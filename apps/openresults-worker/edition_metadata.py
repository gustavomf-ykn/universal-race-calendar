"""Resolve an existing URL identity without guessing associations from names."""

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
        # Existing canonical fields win; independent editions gain missing metadata.
        conn.execute('''UPDATE "Event" SET date=coalesce(date,%s),city=coalesce(city,nullif(%s,'')),
            state=coalesce(state,nullif(%s,'')),description=coalesce(description,nullif(%s,'')),
            "mainImageUrl"=coalesce("mainImageUrl",nullif(%s,'')),"locationName"=coalesce("locationName",nullif(%s,'')),
            address=coalesce(address,nullif(%s,'')),"updatedAt"=now() WHERE id=%s''',
            (metadata.event_date, metadata.city, metadata.state, metadata.description,
             metadata.image_url, metadata.location_name, metadata.address, event_id))
        task['payload']['externalId'] = new
