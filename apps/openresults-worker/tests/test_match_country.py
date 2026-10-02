import os
import uuid
from datetime import date
from urllib.parse import urlsplit

import pytest
from psycopg.types.json import Jsonb

import worker
from app.models import EventMetadata


@pytest.mark.skipif(not os.environ.get('DATABASE_URL'), reason='isolated PostgreSQL required')
@pytest.mark.parametrize(('country', 'observed'), [('', None), ('Brasil', 'BR'), ('PT', 'PT')])
def test_inspection_persists_country_evidence_without_inference_and_fences_stale_writer(monkeypatch, country, observed):
    uri = os.environ['DATABASE_URL'].split('?')[0]
    parsed = urlsplit(uri)
    assert parsed.hostname in ('127.0.0.1', 'localhost', 'postgres') and parsed.path.endswith('_test')
    monkeypatch.setenv('WORKER_DATABASE_URL', uri)
    ident = 'country-proof-' + str(uuid.uuid4())
    task = {'id': ident, 'leaseToken': ident, 'payload': {}}
    metadata = EventMetadata('Teste de país', date(2040, 10, 10), 'Cidade', 'SC',
                             f'https://openresults.run/evento/{ident}/', ident, country=country, event_id=ident)
    with worker.connection() as conn:
        conn.execute('''INSERT INTO "CollectionTask" (id,source,kind,"ownerId","idempotencyKey","requestHash",payload,
            status,"leaseToken","leaseUntil") VALUES (%s,'openresults','inspect',%s,%s,'fixture',%s,'running',%s,now()+interval '1 minute')''',
                     (ident, ident, ident, Jsonb({}), ident))
    try:
        worker.store_match(task, metadata)
        with worker.connection() as conn:
            assert conn.execute('SELECT country FROM "SourceMatch" WHERE "externalId"=%s', (ident,)).fetchone()['country'] == observed
        # A partial refresh preserves a previously observed country, including a foreign country.
        metadata.country = ''
        worker.store_match(task, metadata)
        with worker.connection() as conn:
            assert conn.execute('SELECT country FROM "SourceMatch" WHERE "externalId"=%s', (ident,)).fetchone()['country'] == observed
            conn.execute('UPDATE "CollectionTask" SET "leaseToken"=%s WHERE id=%s', ('replacement', ident))
        metadata.country = 'BR'
        with pytest.raises(RuntimeError, match='lease_lost'):
            worker.store_match(task, metadata)
        with worker.connection() as conn:
            assert conn.execute('SELECT country FROM "SourceMatch" WHERE "externalId"=%s', (ident,)).fetchone()['country'] == observed
    finally:
        with worker.connection() as conn:
            conn.execute('DELETE FROM "SourceMatch" WHERE "externalId"=%s', (ident,))
            conn.execute('DELETE FROM "CollectionTask" WHERE id=%s', (ident,))


@pytest.mark.skipif(not os.environ.get('DATABASE_URL'), reason='isolated PostgreSQL required')
@pytest.mark.parametrize(('change', 'value'), [
    ('country', 'PT'), ('country', ''), ('city', 'Outra cidade'),
    ('state', 'PR'), ('event_date', date(2041, 10, 10)), ('event_date', None),
])
def test_reinspection_does_not_hide_conflicts_in_previously_resolved_identity(monkeypatch, change, value):
    uri = os.environ['DATABASE_URL'].split('?')[0]
    parsed = urlsplit(uri)
    assert parsed.hostname in ('127.0.0.1', 'localhost', 'postgres') and parsed.path.endswith('_test')
    monkeypatch.setenv('WORKER_DATABASE_URL', uri)
    ident = 'edition-reinspect-' + str(uuid.uuid4())
    url = f'https://openresults.run/evento/{ident}/'
    task = {'id': ident, 'leaseToken': ident, 'payload': {}}
    metadata = EventMetadata('Teste', date(2040, 10, 10), 'São José', 'SC', url, ident,
                             country='BR', event_id=ident)
    with worker.connection() as conn:
        conn.execute('''INSERT INTO "Source" (id,name,url,type,adapter,"externalId","updatedAt")
            VALUES (%s,'Teste',%s,'official_page','openresults',%s,now())''', (ident, url, ident))
        conn.execute('''INSERT INTO "Event" (id,slug,name,date,city,state,country,"canonicalFingerprint",warnings,
            "publishabilityReasons","publicationStatus","updatedAt")
            VALUES (%s,%s,'Teste','2040-10-10','Sao Jose','SC','BR',%s,'[]','[]','published',now())''',
                     (ident, ident, ident))
        conn.execute('''INSERT INTO "EventSourceReference" (id,"eventId","sourceId","sourceType","sourceExternalId",url,"updatedAt")
            VALUES (%s,%s,%s,'openresults',%s,%s,now())''', (ident, ident, ident, ident, url))
        conn.execute('''INSERT INTO "CollectionTask" (id,source,kind,"ownerId","idempotencyKey","requestHash",payload,
            status,"leaseToken","leaseUntil")
            VALUES (%s,'openresults','inspect',%s,%s,'fixture',%s,'running',%s,now()+interval '5 minutes')''',
                     (ident, ident, ident, Jsonb({}), ident))
        conn.execute('''INSERT INTO "ResultSet" (id,"eventId",source,"externalId","sourceUrl","updatedAt","contentHash",count)
            VALUES (%s,%s,'openresults',%s,%s,now(),'previous-valid',1)''', (ident, ident, ident, url))
    try:
        worker.store_match(task, metadata)
        with worker.connection() as conn:
            assert conn.execute('SELECT status,"eventId","resolvedBy" FROM "SourceMatch" WHERE "externalId"=%s',
                                (ident,)).fetchone() == {'status': 'resolved', 'eventId': ident, 'resolvedBy': 'exact_reference'}
        setattr(metadata, change, value)
        worker.store_match(task, metadata)
        with worker.connection() as conn:
            row = conn.execute('SELECT status,"eventId","resolvedBy",country FROM "SourceMatch" WHERE "externalId"=%s',
                               (ident,)).fetchone()
            if change == 'country' and value == '':
                # A partial refresh keeps known evidence, rather than deleting it.
                assert row == {'status': 'resolved', 'eventId': ident, 'resolvedBy': 'exact_reference', 'country': 'BR'}
            else:
                assert row['status'] == 'pending' and row['eventId'] is None and row['resolvedBy'] is None
            assert conn.execute('SELECT "eventId" FROM "EventSourceReference" WHERE id=%s', (ident,)).fetchone()['eventId'] == ident
            assert conn.execute('SELECT "contentHash",count FROM "ResultSet" WHERE id=%s', (ident,)).fetchone() == {
                'contentHash': 'previous-valid', 'count': 1}
    finally:
        with worker.connection() as conn:
            conn.execute('DELETE FROM "SourceMatch" WHERE "externalId"=%s', (ident,))
            conn.execute('DELETE FROM "CollectionTask" WHERE id=%s', (ident,))
            conn.execute('DELETE FROM "ResultSet" WHERE id=%s', (ident,))
            conn.execute('DELETE FROM "Event" WHERE id=%s', (ident,))
            conn.execute('DELETE FROM "Source" WHERE id=%s', (ident,))
