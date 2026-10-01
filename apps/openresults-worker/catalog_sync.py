"""Native OpenResults pages, durable receipts and atomic candidate enrichment."""
import hashlib
import json
import uuid

from psycopg.types.json import Jsonb

from app.services.openresults.catalog import parse_catalog_payload
from app.services.openresults.catalog_ledger import checkpoint, receipt, record_page
from app.services.openresults_client import OpenResultsClient


def enqueue_inspection(conn, sync, row, event_id):
    # Same stable JSON convention as the TypeScript queue, scoped to this sync
    # and URL (URL identity survives resolution to the source's numeric ID).
    key = hashlib.sha256(f"catalog-enrich:{sync['id']}:{row['url']}".encode()).hexdigest()
    payload = {'url': row['url'], 'eventId': event_id, 'syncId': sync['id']}
    canonical = json.dumps({'source': 'openresults', 'kind': 'inspect', 'payload': payload},
                           sort_keys=True, ensure_ascii=False, separators=(',', ':'))
    request_hash = hashlib.sha256(canonical.encode()).hexdigest()
    queued = conn.execute('''INSERT INTO "CollectionTask"
        (id,source,kind,"ownerId","idempotencyKey","requestHash",payload,"updatedAt")
        VALUES (%s,'openresults','inspect',%s,%s,%s,%s,now())
        ON CONFLICT ("ownerId","idempotencyKey") DO UPDATE SET "idempotencyKey"=EXCLUDED."idempotencyKey"
        RETURNING "requestHash"''',
        (str(uuid.uuid4()), sync['ownerId'], key, request_hash, Jsonb(payload))).fetchone()
    if queued['requestHash'] != request_hash:
        raise ValueError('idempotency_conflict')


async def sync_catalog(task, settings, connection, fenced, progress):
    sync_id = task['payload']['syncId']
    with connection() as conn:
        fenced(conn, task)
        sync = conn.execute('SELECT * FROM "CatalogSync" WHERE id=%s', (sync_id,)).fetchone()
    if not sync:
        raise ValueError('sync_not_found')
    if sync['status'] != 'ready':
        progress.update(stage=sync['status'], syncId=sync_id, processed=0)
        return
    options = sync['options']
    ledger = checkpoint(sync['snapshot'], sync['page'], sync['cursor'])
    if ledger['currentPage'] is None:
        async with OpenResultsClient(settings) as client:
            payload = await client.get_catalog_page(sync['page'])
        events, total, more = parse_catalog_payload(payload)
        ledger = record_page(ledger, sync['page'], events, total, more, options, settings.catalog_max_pages)
        with connection() as conn:
            fenced(conn, task, 65536 + len(json.dumps(ledger, ensure_ascii=False).encode()) * 8)
            conn.execute('''UPDATE "CatalogSync" SET snapshot=%s,coverage=%s,
                discovered=discovered+%s,"updatedAt"=now() WHERE id=%s''',
                (Jsonb(ledger), ledger['reason'], len(ledger['rows']), sync_id))
    elif ledger['legacyEvidenceMissing'] and sync['coverage'] == 'last_page':
        ledger['terminal'] = True
        ledger['reason'] = 'catalog_legacy_evidence_missing'
        ledger['receipts'] = [receipt(ledger)]

    created = existing = 0
    batch = ledger['rows'][sync['cursor']:sync['cursor'] + options['batchSize']]
    for row in batch:
        with connection() as conn:
            fenced(conn, task)
            ref = conn.execute('''SELECT id,"eventId","sourceId" FROM "EventSourceReference"
                WHERE "sourceType"='openresults' AND ("sourceExternalId"=%s OR rtrim(url,'/')=rtrim(%s,'/'))''',
                (row['externalId'], row['url'])).fetchone()
            if ref:
                conn.execute('UPDATE "EventSourceReference" SET "lastSeenAt"=now() WHERE id=%s', (ref['id'],))
                event_id = ref['eventId']
            else:
                digest = hashlib.sha256(('openresults:' + row['externalId']).encode()).hexdigest()
                source_id = 'src_' + digest[:24]
                event_id = 'evt_' + digest[:24]
                source = conn.execute('''INSERT INTO "Source" (id,name,url,type,adapter,"externalId","createdAt","updatedAt")
                    VALUES (%s,%s,%s,'official_page','openresults',%s,now(),now())
                    ON CONFLICT (adapter,"externalId") DO UPDATE SET adapter=EXCLUDED.adapter RETURNING id''',
                    (source_id, row['name'], row['url'], row['externalId'])).fetchone()
                reasons = ['metadata_validation_required']
                if not row.get('country'):
                    reasons.append('country_unconfirmed')
                event = conn.execute('''INSERT INTO "Event"
                    (id,slug,name,date,city,state,country,"sourceId","sourceType","sourceExternalId","sourceUrl",
                    "canonicalFingerprint",warnings,"publishabilityReasons","publicationStatus","administrativeReview","createdAt","updatedAt")
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'openresults',%s,%s,%s,'[]',%s,'pending_review',true,now(),now())
                    ON CONFLICT ("sourceType","sourceExternalId") DO UPDATE SET "sourceType"=EXCLUDED."sourceType" RETURNING id''',
                    (event_id, 'openresults-' + digest[:24], row['name'], row['date'], row['city'] or None,
                     row['state'] or None, row.get('country'), source['id'], row['externalId'], row['url'], digest, Jsonb(reasons))).fetchone()
                event_id = event['id']
                conn.execute('''INSERT INTO "EventSourceReference"
                    (id,"eventId","sourceId","sourceType","sourceExternalId",url,"updatedAt")
                    VALUES (%s,%s,%s,'openresults',%s,%s,now())''',
                    (str(uuid.uuid4()), event_id, source['id'], row['externalId'], row['url']))
            # Candidate, queued metadata and checkpoint either all commit or all roll back.
            enqueue_inspection(conn, sync, row, event_id)
            conn.execute('UPDATE "CatalogSync" SET cursor=cursor+1,processed=processed+1,"updatedAt"=now() WHERE id=%s', (sync_id,))
        if ref:
            existing += 1
        else:
            created += 1

    if sync['cursor'] + len(batch) >= len(ledger['rows']):
        with connection() as conn:
            fenced(conn, task)
            if ledger['terminal']:
                final = ledger['receipts'][0]['status']
                conn.execute('''UPDATE "CatalogSync" SET snapshot=%s,status=%s,coverage=%s,"updatedAt"=now() WHERE id=%s''',
                             (Jsonb(ledger), final, ledger['reason'], sync_id))
            else:
                ledger['rows'] = []
                ledger['currentPage'] = None
                conn.execute('''UPDATE "CatalogSync" SET snapshot=%s,cursor=0,page=page+1,"updatedAt"=now() WHERE id=%s''',
                             (Jsonb(ledger), sync_id))
    progress.update(stage='catalog_batch', syncId=sync_id, created=created, existing=existing,
                    processed=len(batch), coverage=ledger['reason'],
                    pagesRead=len(ledger['pageReceipts']), unique=len(ledger['seenURLs']),
                    duplicates=ledger['duplicates'], outOfScope=ledger['outOfScope'],
                    unknownCountry=ledger['unknownCountry'])
