"""Fenced, atomic PostgreSQL result-page checkpoints; never publishes partial rows."""
from dataclasses import asdict
from datetime import date, datetime, timezone
import hashlib
import json
import uuid

from psycopg.types.json import Jsonb

from app.models import EventDiscovery, EventMetadata, ExtractionResult, ModalityInfo, NoResultsError, StructureChangedError
from app.services.parser import clean_text, normalize_gender
from app.services.result_pages import record_key
from event_aliases import payload as canonical_payload

PARSER_VERSION = 1


class ResultCheckpointError(ValueError):
    pass


def cleanup_checkpoints(connection):
    """Bounded retention cleanup never deletes permanent results or a live lease's data."""
    with connection() as conn:
        roots = conn.execute('''SELECT c."rootTaskId" FROM "ResultCheckpoint" c
            WHERE c."expiresAt"<=now() AND c.status IN ('collecting','ready','invalid')
            AND NOT EXISTS (SELECT FROM "CollectionTask" t WHERE t.id=c."activeTaskId"
                AND t.status='running' AND t."leaseUntil">now())
            ORDER BY c."expiresAt" LIMIT 25 FOR UPDATE OF c SKIP LOCKED''').fetchall()
        for root in roots:
            conn.execute('DELETE FROM "ResultCheckpointRow" WHERE "rootTaskId"=%s', (root['rootTaskId'],))
            conn.execute('UPDATE "ResultCheckpoint" SET status=\'expired\',"updatedAt"=now() WHERE "rootTaskId"=%s', (root['rootTaskId'],))
        return len(roots)


def json_value(value):
    return json.loads(json.dumps(value, default=lambda v: v.isoformat()))


def dedupe_key(record):
    common = (record.get('modality_value') or record.get('modality'), record.get('gender'),
              clean_text(record.get('name')).casefold(), record.get('time') or '')
    bib = clean_text(record.get('bib'))
    key = common[:2] + (('bib', bib),) + common[2:] if bib else common + (record.get('overall_position'),)
    return hashlib.sha256(json.dumps(key, ensure_ascii=False).encode()).hexdigest()


def manifest_for(discovery, page_size, extracted_at):
    metadata = json_value(asdict(discovery.metadata))
    modalities = json_value([asdict(m) for m in discovery.modalities])
    manifest = {'metadata': metadata, 'modalities': modalities, 'endpoint': discovery.endpoint_url,
                'headers': discovery.result_headers, 'extractedAt': extracted_at.isoformat()}
    identity = {'sourceUrl': metadata['source_url'], 'externalId': metadata['event_id'],
                'date': metadata['event_date'], 'expected': metadata['expected_total'],
                'endpoint': discovery.endpoint_url, 'headers': discovery.result_headers,
                'groups': [(str(m.value), m.name, m.expected_by_gender) for m in discovery.modalities],
                'version': PARSER_VERSION, 'pageSize': page_size}
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return manifest, digest


def restore(manifest):
    metadata = dict(manifest['metadata'])
    for field in ('event_date', 'end_date'):
        metadata[field] = date.fromisoformat(metadata[field]) if metadata.get(field) else None
    if metadata.get('metadata_fetched_at'):
        metadata['metadata_fetched_at'] = datetime.fromisoformat(metadata['metadata_fetched_at'])
    return EventDiscovery(EventMetadata(**metadata), [ModalityInfo(**m) for m in manifest['modalities']],
                          manifest['endpoint'], manifest['headers'])


class ResultCheckpoints:
    def __init__(self, task, settings, connection, fence, progress=None):
        self.task, self.settings, self.connection, self.fence = task, settings, connection, fence
        self.root_id = task['payload'].get('checkpointOf') or task['id']
        self.progress = progress

    def _root(self, conn):
        root = conn.execute('SELECT * FROM "ResultCheckpoint" WHERE "rootTaskId"=%s FOR UPDATE',
                            (self.root_id,)).fetchone()
        if not root:
            return None
        payload = canonical_payload(conn, self.task['payload'])
        if (root['eventId'] != payload['eventId'] or root['externalId'] != payload['externalId']
                or root['sourceUrl'] != payload['url'] or root['parserVersion'] != PARSER_VERSION
                or root['pageSize'] != self.settings.endpoint_page_size):
            raise ResultCheckpointError('result_checkpoint_incompatible')
        if root['activeTaskId'] != self.task['id']:
            raise ResultCheckpointError('result_checkpoint_in_use')
        if root['expiresAt'] <= datetime.now(timezone.utc) or root['status'] == 'expired':
            raise ResultCheckpointError('result_checkpoint_expired')
        if root['status'] not in ('collecting', 'ready'):
            raise ResultCheckpointError('result_checkpoint_unavailable')
        return root

    def ready(self):
        # A ready checkpoint needs no additional request to a possibly blocked source.
        with self.connection() as conn:
            self.fence(conn, self.task)
            root = self._root(conn)
            if self.task['payload'].get('checkpointOf') and root is None:
                raise ResultCheckpointError('result_checkpoint_unavailable')
            return self._result(conn, root) if root and root['status'] == 'ready' else None

    def start(self, discovery, extracted_at):
        manifest, digest = manifest_for(discovery, self.settings.endpoint_page_size, extracted_at)
        groups = [(str(m.value), gender, m.expected_by_gender.get(gender))
                  for m in discovery.modalities for gender in ('F', 'M')]
        if not groups or len({(m, g) for m, g, _ in groups}) != len(groups):
            raise StructureChangedError('result_groups_invalid')
        payload = self.task['payload']
        if str(discovery.metadata.event_id or '') != payload['externalId']:
            raise ResultCheckpointError('source_identity_mismatch')
        with self.connection() as conn:
            self.fence(conn, self.task, len(json.dumps(manifest).encode()) * 8 + 65536)
            payload = canonical_payload(conn, payload)
            reference = conn.execute('''SELECT r."eventId",e.date FROM "EventSourceReference" r
                JOIN "Event" e ON e.id=r."eventId" WHERE r."sourceType"='openresults'
                AND r."sourceExternalId"=%s FOR UPDATE OF r''', (payload['externalId'],)).fetchone()
            if not reference or reference['eventId'] != payload['eventId']:
                raise ResultCheckpointError('association_changed')
            if not reference['date'] or reference['date'].date() != discovery.metadata.event_date:
                raise ResultCheckpointError('edition_date_mismatch')
            root = self._root(conn)
            if root:
                if root['manifestHash'] != digest:
                    raise ResultCheckpointError('result_checkpoint_incompatible')
                return restore(root['manifest']), datetime.fromisoformat(root['manifest']['extractedAt'])
            if self.root_id != self.task['id']:
                raise ResultCheckpointError('result_checkpoint_unavailable')
            conn.execute('''INSERT INTO "ResultCheckpoint" ("rootTaskId","activeTaskId","eventId",
                "externalId","sourceUrl","parserVersion","pageSize","manifestHash",manifest)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                (self.root_id, self.task['id'], payload['eventId'], payload['externalId'], payload['url'],
                 PARSER_VERSION, self.settings.endpoint_page_size, digest, Jsonb(manifest)))
            for modality, gender, expected in groups:
                conn.execute('''INSERT INTO "ResultCheckpointGroup" ("rootTaskId","modalityValue",gender,"expectedTotal")
                    VALUES (%s,%s,%s,%s)''', (self.root_id, modality, gender, expected))
        return discovery, extracted_at

    def group(self, modality, gender):
        with self.connection() as conn:
            self.fence(conn, self.task)
            self._root(conn)
            return conn.execute('''SELECT * FROM "ResultCheckpointGroup"
                WHERE "rootTaskId"=%s AND "modalityValue"=%s AND gender=%s''',
                (self.root_id, str(modality.value), gender)).fetchone()

    def save_page(self, modality, gender, offset, page):
        growth = len(json.dumps(page.records, default=str).encode()) * 8 + 65536
        with self.connection() as conn:
            self.fence(conn, self.task, growth)
            root = self._root(conn)
            if not root or root['status'] != 'collecting':
                raise ResultCheckpointError('result_checkpoint_unavailable')
            key = (self.root_id, str(modality.value), gender)
            group = conn.execute('''SELECT * FROM "ResultCheckpointGroup"
                WHERE "rootTaskId"=%s AND "modalityValue"=%s AND gender=%s FOR UPDATE''', key).fetchone()
            receipt = conn.execute('''SELECT * FROM "ResultCheckpointPage"
                WHERE "rootTaskId"=%s AND "modalityValue"=%s AND gender=%s AND "offset"=%s''', (*key, offset)).fetchone()
            if receipt:
                if (receipt['contentHash'], receipt['nextOffset'], receipt['hasMore'], receipt['expectedTotal']) != (
                        page.digest, page.next_offset, page.has_more, page.expected):
                    raise ResultCheckpointError('result_checkpoint_incompatible')
                return
            if not group or group['status'] != 'collecting' or group['nextOffset'] != offset:
                raise ResultCheckpointError('result_checkpoint_incompatible')
            if group['pageCount'] >= self.settings.max_endpoint_pages:
                raise StructureChangedError('result_page_limit')
            expected = group['expectedTotal'] if group['expectedTotal'] is not None else page.expected
            if expected is not None and page.expected is not None and expected != page.expected:
                raise StructureChangedError('result_total_changed')
            count = group['recordCount'] + len(page.records)
            if expected is not None and (count > expected or (not page.has_more and count != expected)):
                raise ResultCheckpointError('incomplete_extraction')
            if page.records and conn.execute('''SELECT 1 FROM "ResultCheckpointPage"
                WHERE "rootTaskId"=%s AND "modalityValue"=%s AND gender=%s AND "contentHash"=%s''',
                (*key, page.digest)).fetchone():
                raise StructureChangedError('result_page_repeated')
            for record in page.records:
                inserted = conn.execute('''INSERT INTO "ResultCheckpointRow"
                    ("rootTaskId","recordKey","dedupeKey","modalityValue",gender,record)
                    VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING RETURNING "recordKey"''',
                    (self.root_id, record_key(record), dedupe_key(record), str(modality.value), gender, Jsonb(record))).fetchone()
                if not inserted:
                    raise StructureChangedError('result_rows_repeated')
            conn.execute('''INSERT INTO "ResultCheckpointPage" ("rootTaskId","modalityValue",gender,"offset",
                "nextOffset","hasMore","expectedTotal","contentHash","recordCount") VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                (*key, offset, page.next_offset, page.has_more, page.expected, page.digest, len(page.records)))
            conn.execute('''UPDATE "ResultCheckpointGroup" SET "nextOffset"=%s,"expectedTotal"=%s,
                "recordCount"=%s,"pageCount"="pageCount"+1,status=%s
                WHERE "rootTaskId"=%s AND "modalityValue"=%s AND gender=%s''',
                (page.next_offset, expected, count, 'collecting' if page.has_more else 'completed', *key))
            conn.execute('UPDATE "ResultCheckpoint" SET "updatedAt"=now() WHERE "rootTaskId"=%s', (self.root_id,))
            # Heartbeat progress cannot be required for durability: commit counters with the page.
            saved = conn.execute('''UPDATE "CollectionTask" SET progress=progress||jsonb_build_object(
                'checkpointRootId',%s::text,'stage','extracting','checkpointPages',
                (SELECT coalesce(sum("pageCount"),0) FROM "ResultCheckpointGroup" WHERE "rootTaskId"=%s),
                'checkpointRecords',(SELECT coalesce(sum("recordCount"),0) FROM "ResultCheckpointGroup" WHERE "rootTaskId"=%s))
                WHERE id=%s RETURNING progress''', (self.root_id, self.root_id, self.root_id, self.task['id'])).fetchone()['progress']
        if self.progress is not None:
            self.progress.update(saved)

    def _result(self, conn, root):
        discovery = restore(root['manifest'])
        groups = conn.execute('SELECT * FROM "ResultCheckpointGroup" WHERE "rootTaskId"=%s', (self.root_id,)).fetchall()
        required = {(str(m.value), gender) for m in discovery.modalities for gender in ('F', 'M')}
        if {(g['modalityValue'], g['gender']) for g in groups} != required:
            raise ResultCheckpointError('incomplete_extraction')
        total = sum(g['recordCount'] for g in groups)
        if not total:
            raise NoResultsError('results_unavailable')
        if any(g['status'] != 'completed' or (g['expectedTotal'] is not None and g['expectedTotal'] != g['recordCount']) for g in groups):
            raise ResultCheckpointError('incomplete_extraction')
        expected = discovery.metadata.expected_total
        if expected is None and all(g['expectedTotal'] is not None for g in groups):
            expected = sum(g['expectedTotal'] for g in groups)
        if expected is not None and expected != total:
            raise ResultCheckpointError('incomplete_extraction')
        names = {str(m.value): m.name for m in discovery.modalities}
        by_group = {f"{names[g['modalityValue']]} | {normalize_gender(g['gender'])}": g['recordCount'] for g in groups}
        by_gender = {normalize_gender(gender): sum(g['recordCount'] for g in groups if g['gender'] == gender) for gender in ('F','M')}
        return ExtractionResult(discovery.metadata, discovery.modalities, [], expected, total, by_gender, by_group,
                                extracted_at=datetime.fromisoformat(root['manifest']['extractedAt']), checkpoint_root_id=self.root_id)

    def finish(self):
        with self.connection() as conn:
            self.fence(conn, self.task)
            root = self._root(conn)
            if not root:
                raise ResultCheckpointError('result_checkpoint_unavailable')
            result = self._result(conn, root)
            count = conn.execute('SELECT count(*) AS count FROM "ResultCheckpointRow" WHERE "rootTaskId"=%s', (self.root_id,)).fetchone()['count']
            if count != result.extracted_total:
                raise ResultCheckpointError('incomplete_extraction')
            conn.execute('UPDATE "ResultCheckpoint" SET status=\'ready\',"updatedAt"=now() WHERE "rootTaskId"=%s', (self.root_id,))
            return result

    def invalidate(self, reason):
        # Small operational diagnostic remains possible even when allocation is full.
        with self.connection() as conn:
            live = conn.execute('''SELECT id FROM "CollectionTask" WHERE id=%s AND status='running'
                AND "leaseToken"=%s AND "leaseUntil">now() FOR UPDATE''', (self.task['id'], self.task['leaseToken'])).fetchone()
            if live:
                conn.execute('''UPDATE "ResultCheckpoint" SET status='invalid',"errorCode"=%s,"updatedAt"=now()
                    WHERE "rootTaskId"=%s AND "activeTaskId"=%s AND status IN ('collecting','ready')''',
                    (reason, self.root_id, self.task['id']))

    def publish(self, result, position):
        """Stream staged records twice, then replace published rows in one transaction."""
        with self.connection() as conn:
            self.fence(conn, self.task)
            root = self._root(conn)
            if not root or root['status'] != 'ready' or result.checkpoint_root_id != self.root_id:
                raise ResultCheckpointError('result_checkpoint_unavailable')
            validated = self._result(conn, root)
            size = conn.execute('''SELECT count(*) AS count,coalesce(sum(pg_column_size(record)),0) AS bytes
                FROM "ResultCheckpointRow" WHERE "rootTaskId"=%s''', (self.root_id,)).fetchone()
            if size['count'] != validated.extracted_total:
                raise ResultCheckpointError('incomplete_extraction')
            self.fence(conn, self.task, int(size['bytes']) * 8 + size['count'] * 2048)
            payload = canonical_payload(conn, self.task['payload'])
            reference = conn.execute('''SELECT r."eventId",r.url,e.date FROM "EventSourceReference" r
                JOIN "Event" e ON e.id=r."eventId" WHERE r."sourceType"='openresults'
                AND r."sourceExternalId"=%s FOR UPDATE OF r,e''', (payload['externalId'],)).fetchone()
            if not reference or reference['eventId'] != payload['eventId'] or reference['url'] != payload['url']:
                raise ResultCheckpointError('association_changed')
            if not reference['date'] or reference['date'].date() != validated.metadata.event_date:
                raise ResultCheckpointError('edition_date_mismatch')
            digest = hashlib.sha256()
            with conn.cursor(name='checkpoint_digest') as cursor:
                cursor.execute('''SELECT record FROM "ResultCheckpointRow" WHERE "rootTaskId"=%s ORDER BY "recordKey"''', (self.root_id,))
                for row in cursor:
                    stable = {k: v for k, v in row['record'].items() if k != 'extracted_at'}
                    digest.update(json.dumps(stable, sort_keys=True, ensure_ascii=False).encode() + b'\n')
            published = conn.execute('''INSERT INTO "ResultSet"
                (id,"eventId",source,"externalId","sourceUrl","updatedAt","contentHash",count)
                VALUES (%s,%s,'openresults',%s,%s,now(),%s,%s)
                ON CONFLICT (source,"externalId") DO UPDATE SET "updatedAt"=now(),
                "contentHash"=EXCLUDED."contentHash",count=EXCLUDED.count,"sourceUrl"=EXCLUDED."sourceUrl"
                WHERE "ResultSet"."eventId"=EXCLUDED."eventId" RETURNING id''',
                (str(uuid.uuid4()), payload['eventId'], payload['externalId'], payload['url'], digest.hexdigest(), size['count'])).fetchone()
            if not published:
                raise ResultCheckpointError('association_changed')
            result_set = published['id']
            conn.execute('DELETE FROM "RaceResult" WHERE "resultSetId"=%s', (result_set,))
            conn.execute('DELETE FROM "RaceDiscipline" WHERE "resultSetId"=%s', (result_set,))
            for modality in validated.modalities:
                conn.execute('''INSERT INTO "RaceDiscipline" (id,"resultSetId","externalId",name) VALUES (%s,%s,%s,%s)''',
                    (str(uuid.uuid5(uuid.NAMESPACE_URL, result_set + ':' + str(modality.value))), result_set, str(modality.value), modality.name))
            with conn.cursor(name='checkpoint_publish') as cursor:
                cursor.execute('''SELECT "recordKey",record FROM "ResultCheckpointRow"
                    WHERE "rootTaskId"=%s ORDER BY "recordKey"''', (self.root_id,))
                for row in cursor:
                    record, key = row['record'], row['recordKey']
                    conn.execute('''INSERT INTO "RaceResult" (id,"resultSetId","recordKey",modality,gender,category,bib,name,team,
                        "overallPosition","categoryPosition",time,pace,"distanceKm",gap)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                        (str(uuid.uuid5(uuid.NAMESPACE_URL, result_set + ':' + key)), result_set, key, str(record.get('modality','')),
                         record.get('gender'),record.get('category'),str(record.get('bib','')),record.get('name',''),record.get('team'),
                         position(record.get('overall_position')),position(record.get('category_position')),record.get('time'),
                         record.get('pace'),record.get('distance_km'),record.get('gap')))
            conn.execute('''UPDATE "EventSourceReference" SET "lastSeenAt"=now(),"updatedAt"=now()
                WHERE "sourceType"='openresults' AND "sourceExternalId"=%s''', (payload['externalId'],))
            done = conn.execute('SELECT finish_task(%s,%s,\'completed\',%s,NULL) AS ok',
                (self.task['id'], self.task['leaseToken'], Jsonb({'stage':'published','processed':size['count'],
                 'checkpointRootId':self.root_id}))).fetchone()
            if not done['ok']:
                raise RuntimeError('lease_lost')
            conn.execute('UPDATE "ResultCheckpoint" SET status=\'published\',"updatedAt"=now() WHERE "rootTaskId"=%s', (self.root_id,))
            # Receipts remain; athlete rows are only retained in the published result set.
            conn.execute('DELETE FROM "ResultCheckpointRow" WHERE "rootTaskId"=%s', (self.root_id,))
