"""Resolve an existing URL identity without guessing associations from names."""
from psycopg.types.json import Jsonb
from psycopg import sql
from source_observation import edition_observation

def update_edition(task, metadata, connection, fenced):
    event_id = task['payload'].get('eventId')
    if not event_id:
        return
    with connection() as conn:
        fenced(conn, task)
        ref = conn.execute('''SELECT * FROM "EventSourceReference" WHERE "eventId"=%s
            AND "sourceType"='openresults' FOR UPDATE''', (event_id,)).fetchone()
        event = conn.execute('SELECT * FROM "Event" WHERE id=%s FOR UPDATE', (event_id,)).fetchone()
        if not ref or ref['url'].rstrip('/') != metadata.source_url.rstrip('/'):
            raise ValueError('association_changed')
        if event['date'] and metadata.event_date and event['date'].date() != metadata.event_date:
            raise ValueError('edition_date_mismatch')
        old = ref['sourceExternalId']
        new = str(metadata.event_id) if metadata.event_id else old
        if not old.startswith('url:') and old != new:
            raise ValueError('source_identity_mismatch')
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
        audits = conn.execute('''SELECT details FROM "AdminAudit" WHERE "eventId"=%s AND action='review_event' ''', (event_id,)).fetchall()
        protected = {field for audit in audits for field in (audit['details'].get('changes') or {})}
        incoming = {
            'name': metadata.name, 'date': metadata.event_date, 'city': metadata.city, 'state': metadata.state,
            'country': metadata.country, 'description': metadata.description,
            'mainImageUrl': metadata.image_url, 'locationName': metadata.location_name, 'address': metadata.address,
        }
        # A deliberately cleared administrative field must stay null as well.
        for field in protected:
            if field in incoming:
                incoming[field] = None
        conn.execute('''UPDATE "EventSourceReference" SET observation=%s,"lastValidatedAt"=now(),
            "lastSeenAt"=now(),"updatedAt"=now() WHERE id=%s''', (Jsonb(edition_observation(metadata)), ref['id']))
        primary = event['sourceType'] == 'openresults' and event['sourceId'] == ref['sourceId']
        assignments, values = [], []
        for field, value in incoming.items():
            if value is None or value == '':
                continue
            column = sql.Identifier(field)
            assignments.append(sql.SQL('{}=%s').format(column) if primary else
                               sql.SQL('{}=coalesce({},%s)').format(column, column))
            values.append(value)
        if assignments:
            assignments.append(sql.SQL('"updatedAt"=now()'))
            statement = sql.SQL('UPDATE "Event" SET {} WHERE id=%s').format(sql.SQL(',').join(assignments))
            conn.execute(statement, (*values, event_id))
        task['payload']['externalId'] = new
