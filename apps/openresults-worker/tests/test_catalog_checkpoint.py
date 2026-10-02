import os
import uuid
from datetime import date
from urllib.parse import urlsplit
import pytest
from psycopg.types.json import Jsonb
from app.config import Settings
from app.models import EventSummary, EventMetadata
import catalog_sync
import worker
from edition_metadata import update_edition


@pytest.mark.asyncio
@pytest.mark.skipif(not os.environ.get('DATABASE_URL'), reason='isolated PostgreSQL required')
async def test_url_identity_checkpoint_and_stale_executor(monkeypatch):
    url = os.environ['DATABASE_URL'].split('?')[0]
    parsed = urlsplit(url)
    assert parsed.hostname in ('localhost', '127.0.0.1', 'postgres') and parsed.path.endswith('_test')
    monkeypatch.setenv('WORKER_DATABASE_URL', url)
    ident = 'catalog-test-' + str(uuid.uuid4())
    task = {'id': ident, 'leaseToken': ident, 'payload': {'syncId': ident}}
    events = [EventSummary('Mesmo nome', date(2026, 1, n), 'Teste', 'SC',
                           f'https://openresults.run/evento/{ident}-{n}/', f'{ident}-{n}') for n in (1, 2)]
    calls = []
    async def page(self, number):
        calls.append(number)
        return {}
    monkeypatch.setattr(catalog_sync.OpenResultsClient, 'get_catalog_page', page)
    monkeypatch.setattr(catalog_sync, 'parse_catalog_payload', lambda _: (events, 2, False))
    with worker.connection() as db:
        db.execute('''INSERT INTO "CatalogSync" (id,source,"ownerId",options) VALUES (%s,'openresults','test',%s)''',
                   (ident, Jsonb({'states': ['SC'], 'batchSize': 1})))
        db.execute('''INSERT INTO "CollectionTask" (id,source,kind,"ownerId","idempotencyKey","requestHash",payload,
            status,"leaseToken","leaseUntil") VALUES (%s,'openresults','catalog-sync','test',%s,'test',%s,'running',%s,now()+interval '1 minute')''',
                   (ident, ident, Jsonb(task['payload']), ident))
    try:
        progress = {}
        await catalog_sync.sync_catalog(task, Settings.from_env(), worker.connection, worker.fenced, progress)
        assert progress['created'] == 1
        with worker.connection() as db:
            assert db.execute('SELECT cursor FROM "CatalogSync" WHERE id=%s', (ident,)).fetchone()['cursor'] == 1
            db.execute('UPDATE "CollectionTask" SET "leaseToken"=%s WHERE id=%s', ('new-lease', ident))
        with pytest.raises(RuntimeError, match='lease_lost'):
            await catalog_sync.sync_catalog(task, Settings.from_env(), worker.connection, worker.fenced, progress)
        task['leaseToken'] = 'new-lease'
        await catalog_sync.sync_catalog(task, Settings.from_env(), worker.connection, worker.fenced, progress)
        assert calls == [1] and progress['created'] == 1
        with worker.connection() as db:
            rows = db.execute('SELECT "publicationStatus","sourceExternalId" FROM "Event" WHERE "sourceUrl" LIKE %s', ('%' + ident + '%',)).fetchall()
            assert len(rows) == 2 and all(r['publicationStatus'] == 'pending_review' and r['sourceExternalId'].startswith('url:') for r in rows)
            assert db.execute('SELECT status FROM "CatalogSync" WHERE id=%s', (ident,)).fetchone()['status'] == 'completed'
            inspections = db.execute('''SELECT payload FROM "CollectionTask" WHERE kind='inspect' AND payload->>'syncId'=%s''', (ident,)).fetchall()
            assert len(inspections) == 2 and all(r['payload']['eventId'] for r in inspections)
            assert all(r['country'] is None for r in db.execute('SELECT country FROM "Event" WHERE "sourceUrl" LIKE %s', ('%' + ident + '%',)).fetchall())
            editions = db.execute('SELECT id,"sourceUrl",date FROM "Event" WHERE "sourceUrl" LIKE %s ORDER BY date', ('%' + ident + '%',)).fetchall()
            db.execute('UPDATE "Event" SET name=\'Nome revisado\',city=NULL,country=NULL,modality=\'trail\',"publicationStatus"=\'hidden\' WHERE id=%s', (editions[0]['id'],))
            db.execute('''INSERT INTO "AdminAudit" (id,"actorId",action,"eventId",details) VALUES (%s,%s,'review_event',%s,%s)''',
                       (str(uuid.uuid4()), ident, editions[0]['id'], Jsonb({'changes': {'name': 'Nome revisado', 'city': None, 'country': None, 'modality': 'trail'}})))
        for edition in editions:
            metadata = EventMetadata('Nome extraído', edition['date'].date(), 'Teste', 'SC',
                                     edition['sourceUrl'], 'teste', country='Brasil', event_type='Corrida de rua',
                                     event_id='teste-' + edition['id'])
            inspection = {**task, 'payload': {'eventId': edition['id']}}
            update_edition(inspection, metadata, worker.connection, worker.fenced)
        with worker.connection() as db:
            protected = db.execute('SELECT name,city,country,modality,"publicationStatus" FROM "Event" WHERE id=%s', (editions[0]['id'],)).fetchone()
            assert protected == {'name': 'Nome revisado', 'city': None, 'country': None, 'modality': 'trail', 'publicationStatus': 'hidden'}
            assert db.execute('SELECT name,city,country,modality FROM "Event" WHERE id=%s', (editions[1]['id'],)).fetchone() == {
                'name': 'Nome extraído', 'city': 'Teste', 'country': 'BR', 'modality': 'road'}
            assert all(r['observation']['country'] == 'BR' for r in db.execute('''SELECT observation FROM "EventSourceReference" WHERE "eventId"=ANY(%s)''', ([e['id'] for e in editions],)).fetchall())
            # A supplemental observation cannot replace the primary calendar metadata.
            db.execute('UPDATE "Event" SET "sourceType"=\'ticketsports\' WHERE id=%s', (editions[1]['id'],))
        supplemental = EventMetadata('Outra descrição da fonte', editions[1]['date'].date(), 'Teste', 'SC',
                                     editions[1]['sourceUrl'], 'teste', country='BR', event_type='Trail',
                                     event_id='teste-' + editions[1]['id'])
        update_edition({**task, 'payload': {'eventId': editions[1]['id']}}, supplemental, worker.connection, worker.fenced)
        with worker.connection() as db:
            assert db.execute('SELECT name,city,modality FROM "Event" WHERE id=%s', (editions[1]['id'],)).fetchone() == {
                'name': 'Nome extraído', 'city': 'Teste', 'modality': 'road'}
            db.execute('UPDATE "Event" SET modality=\'unknown\' WHERE id=%s', (editions[1]['id'],))
        update_edition({**task, 'payload': {'eventId': editions[1]['id']}}, supplemental, worker.connection, worker.fenced)
        with worker.connection() as db:
            assert db.execute('SELECT modality FROM "Event" WHERE id=%s', (editions[1]['id'],)).fetchone()['modality'] == 'trail'
            db.execute('UPDATE "Event" SET "sourceType"=\'openresults\' WHERE id=%s', (editions[1]['id'],))
            # A new intentional synchronization enriches existing identities without new editions.
            db.execute('''INSERT INTO "CatalogSync" (id,source,"ownerId",options) VALUES (%s,'openresults',%s,%s)''',
                       (ident + '-repeat', ident, Jsonb({'states': ['SC'], 'batchSize': 5})))
        replay = {**task, 'payload': {'syncId': ident + '-repeat'}}
        await catalog_sync.sync_catalog(replay, Settings.from_env(), worker.connection, worker.fenced, progress)
        assert progress['created'] == 0 and progress['existing'] == 2
        with worker.connection() as db:
            assert db.execute('''SELECT count(*) AS count FROM "CollectionTask" WHERE kind='inspect' AND payload->>'syncId'=%s''', (ident + '-repeat',)).fetchone()['count'] == 2
            assert db.execute('SELECT count(*) AS count FROM "Event" WHERE "sourceUrl" LIKE %s', ('%' + ident + '%',)).fetchone()['count'] == 2
    finally:
        with worker.connection() as db:
            db.execute('DELETE FROM "AdminAudit" WHERE "actorId"=%s', (ident,))
            db.execute('DELETE FROM "Event" WHERE "sourceUrl" LIKE %s', ('%' + ident + '%',))
            db.execute('DELETE FROM "Source" WHERE url LIKE %s', ('%' + ident + '%',))
            db.execute('DELETE FROM "CollectionTask" WHERE payload->>\'syncId\'=ANY(%s)', ([ident, ident + '-repeat'],))
            db.execute('DELETE FROM "CatalogSync" WHERE id=ANY(%s)', ([ident, ident + '-repeat'],))


@pytest.mark.asyncio
@pytest.mark.skipif(not os.environ.get('DATABASE_URL'), reason='isolated PostgreSQL required')
async def test_candidate_enrichment_failure_rolls_back_without_refetch(monkeypatch):
    url = os.environ['DATABASE_URL'].split('?')[0]
    parsed = urlsplit(url)
    assert parsed.hostname in ('localhost', '127.0.0.1', 'postgres') and parsed.path.endswith('_test')
    monkeypatch.setenv('WORKER_DATABASE_URL', url)
    ident = 'catalog-atomic-' + str(uuid.uuid4())
    task = {'id': ident, 'leaseToken': ident, 'payload': {'syncId': ident}}
    event = EventSummary('Corrida', date(2026, 1, 1), 'Cidade', 'SC',
                         f'https://openresults.run/evento/{ident}/', ident)
    calls = []
    async def page(self, number):
        calls.append(number)
        return {}
    monkeypatch.setattr(catalog_sync.OpenResultsClient, 'get_catalog_page', page)
    monkeypatch.setattr(catalog_sync, 'parse_catalog_payload', lambda _: ([event], 1, False))
    with worker.connection() as db:
        db.execute('''INSERT INTO "CatalogSync" (id,source,"ownerId",options) VALUES (%s,'openresults',%s,%s)''',
                   (ident, ident, Jsonb({'states': ['SC'], 'batchSize': 5})))
        db.execute('''INSERT INTO "CollectionTask" (id,source,kind,"ownerId","idempotencyKey","requestHash",payload,
            status,"leaseToken","leaseUntil") VALUES (%s,'openresults','catalog-sync',%s,%s,'test',%s,'running',%s,now()+interval '1 minute')''',
                   (ident, ident, ident, Jsonb(task['payload']), ident))
    original = catalog_sync.enqueue_inspection
    def fail_after_enqueue(*args):
        original(*args)
        raise RuntimeError('controlled_transaction_failure')
    monkeypatch.setattr(catalog_sync, 'enqueue_inspection', fail_after_enqueue)
    try:
        with pytest.raises(RuntimeError, match='controlled_transaction_failure'):
            await catalog_sync.sync_catalog(task, Settings.from_env(), worker.connection, worker.fenced, {})
        with worker.connection() as db:
            assert db.execute('SELECT cursor FROM "CatalogSync" WHERE id=%s', (ident,)).fetchone()['cursor'] == 0
            assert db.execute('SELECT count(*) AS count FROM "Event" WHERE "sourceUrl"=%s', (event.event_url,)).fetchone()['count'] == 0
            assert db.execute('''SELECT count(*) AS count FROM "CollectionTask" WHERE kind='inspect' AND "ownerId"=%s''', (ident,)).fetchone()['count'] == 0
        monkeypatch.setattr(catalog_sync, 'enqueue_inspection', original)
        progress = {}
        await catalog_sync.sync_catalog(task, Settings.from_env(), worker.connection, worker.fenced, progress)
        assert calls == [1] and progress['created'] == 1
    finally:
        with worker.connection() as db:
            db.execute('DELETE FROM "Event" WHERE "sourceUrl"=%s', (event.event_url,))
            db.execute('DELETE FROM "Source" WHERE url=%s', (event.event_url,))
            db.execute('DELETE FROM "CollectionTask" WHERE "ownerId"=%s', (ident,))
            db.execute('DELETE FROM "CatalogSync" WHERE id=%s', (ident,))
