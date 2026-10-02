"""Resolve an existing URL identity without guessing associations from names."""
from psycopg.types.json import Jsonb
from psycopg import sql
import unicodedata
from source_observation import edition_observation
from event_aliases import event_id as canonical_event_id

IDENTITY_ERRORS = frozenset({
    'association_changed', 'source_identity_mismatch', 'source_identity_already_associated',
    'edition_date_unconfirmed', 'edition_date_mismatch',
    'edition_location_conflict', 'edition_location_unconfirmed',
})


def reviewed_metadata_fields(conn, event_id):
    audits = conn.execute('''SELECT details FROM "AdminAudit" WHERE "eventId"=%s
        AND action='review_event' ''', (event_id,)).fetchall()
    return {field for audit in audits for field in (audit['details'].get('changes') or {})}


def normalized_location(value):
    return ' '.join(''.join(c for c in unicodedata.normalize('NFD', value or '')
                           if not unicodedata.combining(c)).casefold().split())


def metadata_identity_reason(event, metadata, protected=()):
    """Known conflicting edition evidence requires review before enrichment/publication."""
    if metadata.event_date is None:
        return 'edition_date_unconfirmed'
    if event['date'] and event['date'].date() != metadata.event_date:
        return 'edition_date_mismatch'
    observation = edition_observation(metadata)
    evidence = metadata.raw_metadata.get('country_evidence') or {}
    if evidence.get('status') in ('conflicting', 'unrecognized') or (metadata.country and not observation['country']):
        return 'edition_location_unconfirmed'
    for field in ('city', 'state', 'country'):
        if field in protected:
            continue
        old, new = normalized_location(event[field]), normalized_location(observation[field])
        if old and new and old != new:
            return 'edition_location_conflict'
    return None


def update_edition(task, metadata, connection, fenced):
    event_id = task['payload'].get('eventId')
    if not event_id:
        return
    with connection() as conn:
        fenced(conn, task)
        event_id = canonical_event_id(conn, event_id)
        ref = conn.execute('''SELECT * FROM "EventSourceReference" WHERE "eventId"=%s
            AND "sourceType"='openresults' FOR UPDATE''', (event_id,)).fetchone()
        event = conn.execute('SELECT * FROM "Event" WHERE id=%s FOR UPDATE', (event_id,)).fetchone()
        if not event or not ref or ref['url'].rstrip('/') != metadata.source_url.rstrip('/'):
            raise ValueError('association_changed')
        old = ref['sourceExternalId']
        new = str(metadata.event_id) if metadata.event_id else old
        if not old.startswith('url:') and old != new:
            raise ValueError('source_identity_mismatch')
        protected = reviewed_metadata_fields(conn, event_id)
        observation = edition_observation(metadata)
        problem = metadata_identity_reason(event, metadata, protected)
        # Record an actual observation even when it conflicts. Commit it for review,
        # but do not mutate the edition, provider identity or published results.
        conn.execute('''UPDATE "EventSourceReference" SET observation=%s,"lastValidatedAt"=now(),
            "lastSeenAt"=now(),"updatedAt"=now() WHERE id=%s''', (Jsonb(observation), ref['id']))
        if problem:
            new = old
        if old != new:
            collision = conn.execute('''SELECT "eventId" FROM "EventSourceReference"
                WHERE "sourceType"='openresults' AND "sourceExternalId"=%s''', (new,)).fetchone()
            if collision:
                raise ValueError('source_identity_already_associated')
            conn.execute('UPDATE "Source" SET "externalId"=%s,"updatedAt"=now() WHERE id=%s', (new, ref['sourceId']))
            conn.execute('UPDATE "EventSourceReference" SET "sourceExternalId"=%s,"updatedAt"=now() WHERE id=%s', (new, ref['id']))
            conn.execute('''UPDATE "Event" SET "sourceExternalId"=%s WHERE id=%s
                AND "sourceType"='openresults' ''', (new, event_id))
        # Only the canonical primary source can refresh populated values.
        # Supplemental references fill gaps and retain their own observation.
        incoming = {
            'name': metadata.name, 'date': metadata.event_date, 'city': metadata.city, 'state': metadata.state,
            'country': observation['country'], 'modality': observation['modality'], 'description': metadata.description,
            'mainImageUrl': metadata.image_url, 'locationName': metadata.location_name, 'address': metadata.address,
        }
        # A deliberately cleared administrative field must stay null as well.
        for field in protected:
            if field in incoming:
                incoming[field] = None
        primary = event['sourceType'] == 'openresults' and event['sourceId'] == ref['sourceId']
        assignments, values = [], []
        for field, value in incoming.items():
            if value is None or value == '':
                continue
            column = sql.Identifier(field)
            if field == 'modality' and not primary:
                assignments.append(sql.SQL("{}=CASE WHEN {}='unknown' THEN %s ELSE {} END").format(column, column, column))
            else:
                assignments.append(sql.SQL('{}=%s').format(column) if primary else
                                   sql.SQL('{}=coalesce({},%s)').format(column, column))
            values.append(value)
        if assignments and not problem:
            assignments.append(sql.SQL('"updatedAt"=now()'))
            statement = sql.SQL('UPDATE "Event" SET {} WHERE id=%s').format(sql.SQL(',').join(assignments))
            conn.execute(statement, (*values, event_id))
    if problem:
        raise ValueError(problem)
    task['payload']['externalId'] = new
