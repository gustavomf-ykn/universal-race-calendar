import os
import uuid
from datetime import date
from urllib.parse import urlsplit
import pytest
from psycopg.types.json import Jsonb
from app.config import Settings
from app.models import EventSummary
import catalog_sync
import worker


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
    finally:
        with worker.connection() as db:
            db.execute('DELETE FROM "Event" WHERE "sourceUrl" LIKE %s', ('%' + ident + '%',))
            db.execute('DELETE FROM "Source" WHERE url LIKE %s', ('%' + ident + '%',))
            db.execute('DELETE FROM "CollectionTask" WHERE id=%s', (ident,))
            db.execute('DELETE FROM "CatalogSync" WHERE id=%s', (ident,))
