"""Resolve edition aliases for processing without changing persisted requests or keys."""


def event_id(conn, identifier):
    row = conn.execute('SELECT "canonicalEventId" FROM "EventAlias" WHERE id=%s', (identifier,)).fetchone()
    return row['canonicalEventId'] if row else identifier


def event_ids(conn, identifiers):
    rows = conn.execute('SELECT id,"canonicalEventId" FROM "EventAlias" WHERE id=ANY(%s)', (identifiers,)).fetchall()
    aliases = {row['id']: row['canonicalEventId'] for row in rows}
    return list(dict.fromkeys(aliases.get(identifier, identifier) for identifier in identifiers))


def payload(conn, original):
    resolved = dict(original)
    if resolved.get('eventId'):
        resolved['eventId'] = event_id(conn, resolved['eventId'])
    return resolved
