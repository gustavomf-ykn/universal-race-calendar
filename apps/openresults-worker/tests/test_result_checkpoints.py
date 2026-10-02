import os
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timezone
from urllib.parse import urlsplit, parse_qs
from unittest.mock import AsyncMock

import pytest
from psycopg.types.json import Jsonb
from app.config import Settings
from app.models import EventDiscovery, EventMetadata, ModalityInfo, StructureChangedError
from app.services.result_pages import parse_result_page
from app.services.scraper import OpenResultsScraper
from app.services.source_requests import SourceBudgetDeferred
from capacity import CapacityDeferred
from result_checkpoints import ResultCheckpoints, ResultCheckpointError, cleanup_checkpoints
import worker
from edition_metadata import update_edition
from app.models import ExtractionResult

pytestmark = pytest.mark.skipif(not os.environ.get('DATABASE_URL'),reason='isolated PostgreSQL required')


@pytest.fixture
def checkpoint(monkeypatch):
    uri=os.environ['DATABASE_URL'].split('?')[0]
    parsed=urlsplit(uri)
    assert parsed.hostname in ('localhost','127.0.0.1','postgres') and parsed.path.endswith('_test')
    monkeypatch.setenv('WORKER_DATABASE_URL',uri)
    ident='result-cp-'+str(uuid.uuid4())
    payload={'eventId':ident,'externalId':ident,'url':f'https://openresults.run/evento/{ident}/'}
    metadata=EventMetadata('Teste',date(2026,1,1),'Teste','SC',payload['url'],ident,expected_total=2,event_id=ident)
    modality=ModalityInfo('5k','5k',{'F':2,'M':0})
    discovery=EventDiscovery(metadata,[modality],f'https://openresults.run/ajax_resultados_evento.cfm?id_evento={ident}',
        ['Geral','Cat.','Número','Nome','Equipe','Pace','Tempo','Gap'])
    task={'id':ident,'ownerId':ident,'kind':'extract','source':'openresults','leaseToken':ident,'payload':payload}
    settings=Settings(endpoint_page_size=1)
    with worker.connection() as conn:
        conn.execute('''INSERT INTO "Source" (id,name,url,type,adapter,"externalId","updatedAt")
            VALUES (%s,'Teste',%s,'official_page','openresults',%s,now())''',(ident,payload['url'],ident))
        conn.execute('''INSERT INTO "Event" (id,slug,name,date,city,state,country,"canonicalFingerprint",warnings,
            "publishabilityReasons","publicationStatus","updatedAt") VALUES (%s,%s,'Teste','2026-01-01','Teste','SC','BR',%s,'[]','[]','published',now())''',(ident,ident,ident))
        conn.execute('''INSERT INTO "EventSourceReference" (id,"eventId","sourceId","sourceType","sourceExternalId",url,"updatedAt")
            VALUES (%s,%s,%s,'openresults',%s,%s,now())''',(ident,ident,ident,ident,payload['url']))
        conn.execute('''INSERT INTO "CollectionTask" (id,source,kind,"ownerId","idempotencyKey","requestHash",payload,status,
            "leaseToken","leaseUntil",attempt) VALUES (%s,'openresults','extract',%s,%s,%s,%s,'running',%s,now()+interval '5 minutes',1)''',
            (ident,ident,ident,ident,Jsonb(payload),ident))
        conn.execute('''INSERT INTO "ResultSet" (id,"eventId",source,"externalId","sourceUrl","updatedAt","contentHash",count)
            VALUES (%s,%s,'openresults',%s,%s,now(),'old-validated-hash',1)''',(ident,ident,ident,payload['url']))
        conn.execute('''INSERT INTO "RaceResult" (id,"resultSetId","recordKey",modality,name) VALUES (%s,%s,'old','5k','Previous valid fixture')''',(ident,ident))
    adapter=ResultCheckpoints(task,settings,worker.connection,worker.fenced)
    yield adapter,discovery,settings
    with worker.connection() as conn:
        conn.execute('DELETE FROM "EventAlias" WHERE "canonicalEventId"=%s',(ident,))
        conn.execute('DELETE FROM "ResultCheckpoint" WHERE "eventId"=%s',(ident,))
        conn.execute('DELETE FROM "AdminAudit" WHERE "actorId"=%s',(ident,))
        conn.execute('DELETE FROM "CollectionTask" WHERE "ownerId"=%s',(ident,))
        conn.execute('DELETE FROM "ResultSet" WHERE "eventId"=%s',(ident,))
        conn.execute('DELETE FROM "Event" WHERE id=%s',(ident,))
        conn.execute('DELETE FROM "Source" WHERE id=%s',(ident,))
        conn.execute('''UPDATE "CatalogCapacity" SET "confirmedAt"=now(),"databaseBudgetBytes"=1000000000000 WHERE id=1''')


def page(discovery,gender,offset):
    if gender=='M':
        payload={'ok':True,'recordsTotal':0,'hasMore':False,'nextOffset':0,'html':''}
    else:
        payload={'ok':True,'recordsTotal':2,'hasMore':offset==0,'nextOffset':offset+1,
            'html':f'<tr><td>{offset+1}</td><td>F18</td><td>00{offset+1}</td><td>Fixture {offset+1}</td><td></td><td>05:00</td><td>00:25:00</td><td></td></tr>'}
    return payload


def parsed_page(discovery,gender,offset):
    return parse_result_page(page(discovery,gender,offset),discovery,discovery.modalities[0],gender,offset,datetime.now(timezone.utc))


def ready(adapter,discovery):
    adapter.start(discovery,datetime.now(timezone.utc))
    for gender,offset in [('F',0),('F',1),('M',0)]:
        adapter.save_page(discovery.modalities[0],gender,offset,parsed_page(discovery,gender,offset))
    return adapter.finish()


def test_checkpoint_with_old_event_id_publishes_to_canonical_without_mutating_request(checkpoint):
    adapter, discovery, _ = checkpoint
    canonical = adapter.task['payload']['eventId']
    old = canonical + '-old'
    with worker.connection() as conn:
        conn.execute('''INSERT INTO "EventAlias" (id,"oldSlug","canonicalEventId",snapshot,"createdBy")
            VALUES (%s,%s,%s,'{}','controlled_fixture')''', (old, old, canonical))
        original = {**adapter.task['payload'], 'eventId': old}
        conn.execute('UPDATE "CollectionTask" SET payload=%s WHERE id=%s', (Jsonb(original), adapter.task['id']))
    adapter.task['payload'] = original
    result = ready(adapter, discovery)
    assert adapter.task['payload']['eventId'] == old
    assert adapter.ready().extracted_total == 2
    adapter.publish(result, worker.position)
    assert previous(adapter)['count'] == 2
    with worker.connection() as conn:
        assert conn.execute('SELECT "eventId" FROM "ResultSet" WHERE id=%s', (adapter.root_id,)).fetchone()['eventId'] == canonical
        saved = conn.execute('SELECT payload,status FROM "CollectionTask" WHERE id=%s', (adapter.task['id'],)).fetchone()
        assert saved['payload'] == original and saved['status'] == 'completed'


def previous(adapter):
    return worker.query('SELECT "contentHash",count FROM "ResultSet" WHERE "externalId"=%s',(adapter.task['payload']['externalId'],),True)


@pytest.mark.parametrize('field,value,reason', [
    ('city', 'Outra cidade', 'edition_location_conflict'),
    ('state', 'PR', 'edition_location_conflict'),
    ('country', 'PT', 'edition_location_conflict'),
    ('event_date', date(2027, 1, 1), 'edition_date_mismatch'),
    ('event_date', None, 'edition_date_unconfirmed'),
    ('country', 'País não reconhecido', 'edition_location_unconfirmed'),
    ('raw_metadata', {'country_evidence': {'status': 'conflicting'}}, 'edition_location_unconfirmed'),
])
def test_conflicting_enrichment_records_observation_without_upgrading_identity_or_edition(checkpoint, field, value, reason):
    adapter, discovery, _ = checkpoint
    ident = adapter.root_id
    old = 'url:pending-' + ident
    with worker.connection() as conn:
        conn.execute('UPDATE "Source" SET "externalId"=%s WHERE id=%s', (old, ident))
        conn.execute('UPDATE "EventSourceReference" SET "sourceExternalId"=%s WHERE id=%s', (old, ident))
        conn.execute('UPDATE "Event" SET "sourceType"=\'openresults\',"sourceId"=%s,"sourceExternalId"=%s WHERE id=%s', (ident, old, ident))
        before = conn.execute('SELECT * FROM "Event" WHERE id=%s', (ident,)).fetchone()
    discovery.metadata.name = 'Changed upstream name'
    setattr(discovery.metadata, field, value)
    original_payload = dict(adapter.task['payload'])
    with pytest.raises(ValueError, match=reason):
        update_edition(adapter.task, discovery.metadata, worker.connection, worker.fenced)
    with worker.connection() as conn:
        assert conn.execute('SELECT * FROM "Event" WHERE id=%s', (ident,)).fetchone() == before
        ref = conn.execute('SELECT "sourceExternalId",observation,"lastValidatedAt" FROM "EventSourceReference" WHERE id=%s', (ident,)).fetchone()
        assert ref['sourceExternalId'] == old and ref['lastValidatedAt']
        assert ref['observation']['name'] == 'Changed upstream name'
        assert conn.execute('SELECT "externalId" FROM "Source" WHERE id=%s', (ident,)).fetchone()['externalId'] == old
    assert adapter.task['payload'] == original_payload
    assert previous(adapter) == {'contentHash': 'old-validated-hash', 'count': 1}


def test_enrichment_preserves_reviewed_location_but_never_accepts_a_different_date(checkpoint):
    adapter, discovery, _ = checkpoint
    ident = adapter.root_id
    with worker.connection() as conn:
        conn.execute('UPDATE "Event" SET city=\'Cidade revisada\',"sourceType"=\'openresults\',"sourceId"=%s WHERE id=%s', (ident, ident))
        conn.execute('''INSERT INTO "AdminAudit" (id,"actorId",action,"eventId",details)
            VALUES (%s,%s,'review_event',%s,%s)''',
            (str(uuid.uuid4()), ident, ident, Jsonb({'changes': {'city': 'Cidade revisada', 'date': '2026-01-01'}})))
    discovery.metadata.name = 'Nome atualizado'
    update_edition(adapter.task, discovery.metadata, worker.connection, worker.fenced)
    saved = worker.query('SELECT name,city,date FROM "Event" WHERE id=%s', (ident,), True)
    assert saved['name'] == 'Nome atualizado' and saved['city'] == 'Cidade revisada'
    discovery.metadata.event_date = date(2027, 1, 1)
    with pytest.raises(ValueError, match='edition_date_mismatch'):
        update_edition(adapter.task, discovery.metadata, worker.connection, worker.fenced)
    assert worker.query('SELECT name,city,date FROM "Event" WHERE id=%s', (ident,), True) == saved


@pytest.mark.parametrize('field,value,reason', [
    ('city', 'Outra cidade', 'edition_location_conflict'),
    ('state', 'PR', 'edition_location_conflict'),
    ('country', 'PT', 'edition_location_conflict'),
    ('country', 'não reconhecido', 'edition_location_unconfirmed'),
    ('source_url', 'https://openresults.run/evento/another/', 'association_changed'),
])
def test_checkpoint_rejects_conflicting_evidence_before_first_page(checkpoint, field, value, reason):
    adapter, discovery, _ = checkpoint
    setattr(discovery.metadata, field, value)
    with pytest.raises(ResultCheckpointError, match=reason):
        adapter.start(discovery, datetime.now(timezone.utc))
    assert worker.query('SELECT count(*) AS n FROM "ResultCheckpoint" WHERE "rootTaskId"=%s', (adapter.root_id,), True)['n'] == 0
    assert previous(adapter) == {'contentHash': 'old-validated-hash', 'count': 1}


@pytest.mark.parametrize('target', ['incoming', 'canonical'])
def test_native_and_dom_require_a_confirmed_date(checkpoint, target):
    adapter, discovery, _ = checkpoint
    if target == 'incoming':
        discovery.metadata.event_date = None
    else:
        worker.query('UPDATE "Event" SET date=NULL WHERE id=%s RETURNING id', (adapter.root_id,))
    with pytest.raises(ResultCheckpointError, match='edition_date_unconfirmed'):
        adapter.start(discovery, datetime.now(timezone.utc))
    result = ExtractionResult(discovery.metadata, discovery.modalities,
        [{'name': 'Controlled fixture', 'modality': '5k', 'gender': 'F', 'bib': '01'}],
        1, 1, {'F': 1}, {'5k:F': 1})
    with pytest.raises(ValueError, match='edition_date_unconfirmed'):
        worker.publish(adapter.task, result)
    assert previous(adapter) == {'contentHash': 'old-validated-hash', 'count': 1}


def test_stale_metadata_executor_cannot_even_record_a_conflicting_observation(checkpoint):
    adapter, discovery, _ = checkpoint
    discovery.metadata.city = 'Outra cidade'
    worker.query('UPDATE "CollectionTask" SET "leaseToken"=\'new-executor\' WHERE id=%s RETURNING id', (adapter.task['id'],))
    with pytest.raises(RuntimeError, match='lease_lost'):
        update_edition(adapter.task, discovery.metadata, worker.connection, worker.fenced)
    ref = worker.query('SELECT observation,"lastValidatedAt" FROM "EventSourceReference" WHERE id=%s', (adapter.root_id,), True)
    assert ref == {'observation': {}, 'lastValidatedAt': None}
    assert worker.query('SELECT city FROM "Event" WHERE id=%s', (adapter.root_id,), True)['city'] == 'Teste'
    assert previous(adapter) == {'contentHash': 'old-validated-hash', 'count': 1}


def test_changed_location_manifest_or_legacy_version_cannot_resume_confirmed_pages(checkpoint):
    adapter, discovery, _ = checkpoint
    adapter.start(discovery, datetime.now(timezone.utc))
    adapter.save_page(discovery.modalities[0], 'F', 0, parsed_page(discovery, 'F', 0))
    # Both observations are compatible with the canonical BR country, but are
    # different snapshots. The already-confirmed page must not be mixed into a new one.
    discovery.metadata.country = 'BR'
    with pytest.raises(ResultCheckpointError, match='result_checkpoint_incompatible'):
        adapter.start(discovery, datetime.now(timezone.utc))
    discovery.metadata.country = ''
    with worker.connection() as conn:
        conn.execute('UPDATE "ResultCheckpoint" SET "parserVersion"=1 WHERE "rootTaskId"=%s', (adapter.root_id,))
    with pytest.raises(ResultCheckpointError, match='result_checkpoint_incompatible'):
        adapter.start(discovery, datetime.now(timezone.utc))
    with pytest.raises(ResultCheckpointError, match='result_checkpoint_incompatible'):
        adapter.ready()
    assert worker.query('SELECT "nextOffset" FROM "ResultCheckpointGroup" WHERE "rootTaskId"=%s AND gender=\'F\'', (adapter.root_id,), True)['nextOffset'] == 1
    assert previous(adapter) == {'contentHash': 'old-validated-hash', 'count': 1}


@pytest.mark.parametrize('field,value,reason', [
    ('city', 'Outra cidade', 'edition_location_conflict'),
    ('state', 'PR', 'edition_location_conflict'),
    ('country', 'PT', 'edition_location_conflict'),
    ('date', date(2027, 1, 1), 'edition_date_mismatch'),
    ('url', 'https://openresults.run/evento/another/', 'association_changed'),
])
def test_ready_checkpoint_rechecks_current_edition_before_replacing_results(checkpoint, field, value, reason):
    adapter, discovery, _ = checkpoint
    discovery.metadata.country = 'BR'
    result = ready(adapter, discovery)
    with worker.connection() as conn:
        if field == 'url':
            conn.execute('UPDATE "EventSourceReference" SET url=%s WHERE id=%s', (value, adapter.root_id))
        else:
            from psycopg import sql
            conn.execute(sql.SQL('UPDATE "Event" SET {}=%s WHERE id=%s').format(sql.Identifier(field)), (value, adapter.root_id))
    with pytest.raises(ResultCheckpointError, match=reason):
        adapter.publish(result, worker.position)
    assert previous(adapter) == {'contentHash': 'old-validated-hash', 'count': 1}
    assert adapter.ready().extracted_total == 2
    assert worker.query('SELECT status FROM "CollectionTask" WHERE id=%s', (adapter.task['id'],), True)['status'] == 'running'


@pytest.mark.parametrize('field,value,reason', [
    ('city', 'Outra cidade', 'edition_location_conflict'),
    ('state', 'PR', 'edition_location_conflict'),
    ('country', 'PT', 'edition_location_conflict'),
    ('source_url', 'https://openresults.run/evento/another/', 'association_changed'),
    ('event_id', 'another-id', 'source_identity_mismatch'),
])
def test_dom_fallback_publication_rejects_incompatible_identity(checkpoint, field, value, reason):
    adapter, discovery, _ = checkpoint
    setattr(discovery.metadata, field, value)
    result = ExtractionResult(discovery.metadata, discovery.modalities,
        [{'name': 'Controlled fixture', 'modality': '5k', 'gender': 'F', 'bib': '01'}],
        1, 1, {'F': 1}, {'5k:F': 1})
    with pytest.raises(ValueError, match=reason):
        worker.publish(adapter.task, result)
    assert previous(adapter) == {'contentHash': 'old-validated-hash', 'count': 1}


def test_dom_fallback_accepts_same_edition_and_keeps_missing_country(checkpoint):
    adapter, discovery, _ = checkpoint
    result = ExtractionResult(discovery.metadata, discovery.modalities,
        [{'name': 'Controlled fixture', 'modality': '5k', 'gender': 'F', 'bib': '01'}],
        1, 1, {'F': 1}, {'5k:F': 1})
    worker.publish(adapter.task, result)
    assert previous(adapter)['contentHash'] != 'old-validated-hash'
    assert worker.query('SELECT country FROM "Event" WHERE id=%s', (adapter.root_id,), True)['country'] == 'BR'


@pytest.mark.asyncio
async def test_budget_pause_recovers_only_unconfirmed_pages_and_publishes_stream(checkpoint,monkeypatch):
    adapter,discovery,settings=checkpoint
    import app.services.scraper as scraper
    monkeypatch.setattr(scraper,'parse_event_page',lambda *args:discovery)
    get_event=AsyncMock(return_value='fixture only')
    monkeypatch.setattr(scraper.OpenResultsClient,'get_event_page',get_event)
    calls=[]
    async def fetch(self,url,referer):
        params=parse_qs(urlsplit(url).query)
        gender,offset=params['genero'][0],int(params['offset'][0])
        calls.append((gender,offset))
        if len(calls)==2:
            raise SourceBudgetDeferred(datetime.now(timezone.utc))
        return page(discovery,gender,offset)
    monkeypatch.setattr(scraper.OpenResultsClient,'get_endpoint_page',fetch)
    with pytest.raises(SourceBudgetDeferred):
        await OpenResultsScraper(settings).scrape(discovery.metadata.source_url,checkpoint=adapter)
    assert adapter.group(discovery.modalities[0],'F')['nextOffset']==1
    assert previous(adapter)=={'contentHash':'old-validated-hash','count':1}
    result=await OpenResultsScraper(settings).scrape(discovery.metadata.source_url,checkpoint=adapter)
    assert calls==[('F',0),('F',1),('F',1),('M',0)]
    assert result.records==[] and result.extracted_total==2 and not result.warnings
    # Ready work resumes without a metadata or endpoint HTTP request.
    get_event.side_effect=AssertionError('ready checkpoint must not refetch')
    restored=await OpenResultsScraper(settings).scrape(discovery.metadata.source_url,checkpoint=adapter)
    assert restored.extracted_total==2 and len(calls)==4
    adapter.publish(restored,worker.position)
    assert previous(adapter)['count']==2
    with worker.connection() as conn:
        assert conn.execute('SELECT count(*) AS n FROM "ResultCheckpointRow" WHERE "rootTaskId"=%s',(adapter.root_id,)).fetchone()['n']==0
        assert conn.execute('SELECT status FROM "ResultCheckpoint" WHERE "rootTaskId"=%s',(adapter.root_id,)).fetchone()['status']=='published'
        assert conn.execute('SELECT count(*) AS n FROM "RaceResult" WHERE "resultSetId"=%s',(adapter.root_id,)).fetchone()['n']==2


def test_page_commit_rolls_back_rows_receipt_and_cursor_together(checkpoint):
    adapter,discovery,_=checkpoint
    adapter.start(discovery,datetime.now(timezone.utc))
    class Fault:
        def __init__(self,conn):self.conn=conn
        def execute(self,sql,params=()):
            if 'UPDATE "ResultCheckpointGroup"' in sql:raise RuntimeError('controlled_cursor_write_failure')
            return self.conn.execute(sql,params)
    @contextmanager
    def failing():
        with worker.connection() as conn:yield Fault(conn)
    adapter.connection=failing
    with pytest.raises(RuntimeError,match='controlled_cursor_write_failure'):
        adapter.save_page(discovery.modalities[0],'F',0,parsed_page(discovery,'F',0))
    adapter.connection=worker.connection
    assert adapter.group(discovery.modalities[0],'F')['nextOffset']==0
    with worker.connection() as conn:
        for table in ('ResultCheckpointRow','ResultCheckpointPage'):
            assert conn.execute(f'SELECT count(*) AS n FROM "{table}" WHERE "rootTaskId"=%s',(adapter.root_id,)).fetchone()['n']==0


def test_stale_lease_and_duplicate_rows_cannot_advance(checkpoint):
    adapter,discovery,_=checkpoint
    adapter.start(discovery,datetime.now(timezone.utc))
    first=parsed_page(discovery,'F',0)
    adapter.save_page(discovery.modalities[0],'F',0,first)
    adapter.save_page(discovery.modalities[0],'F',0,first) # lost acknowledgment replay
    duplicate=parsed_page(discovery,'F',1)
    duplicate.records=first.records
    with pytest.raises(StructureChangedError,match='result_rows_repeated'):
        adapter.save_page(discovery.modalities[0],'F',1,duplicate)
    assert adapter.group(discovery.modalities[0],'F')['nextOffset']==1
    with worker.connection() as conn:
        conn.execute('UPDATE "CollectionTask" SET "leaseToken"=\'new-executor\' WHERE id=%s',(adapter.task['id'],))
    with pytest.raises(RuntimeError,match='lease_lost'):
        adapter.save_page(discovery.modalities[0],'F',1,parsed_page(discovery,'F',1))
    assert previous(adapter)=={'contentHash':'old-validated-hash','count':1}


def test_changed_manifest_or_group_total_preserves_previous_results(checkpoint):
    adapter,discovery,_=checkpoint
    adapter.start(discovery,datetime.now(timezone.utc))
    adapter.save_page(discovery.modalities[0],'F',0,parsed_page(discovery,'F',0))
    discovery.result_headers=['Nome']
    with pytest.raises(ResultCheckpointError,match='result_checkpoint_incompatible'):
        adapter.start(discovery,datetime.now(timezone.utc))
    changed=parsed_page(EventDiscovery(discovery.metadata,discovery.modalities,discovery.endpoint_url,
        ['Geral','Cat.','Número','Nome','Equipe','Pace','Tempo','Gap']),'F',1)
    changed.expected=3
    with pytest.raises(StructureChangedError,match='result_total_changed'):
        adapter.save_page(discovery.modalities[0],'F',1,changed)
    assert previous(adapter)=={'contentHash':'old-validated-hash','count':1}


def test_publication_failure_rolls_back_replacement_and_keeps_ready_rows(checkpoint):
    adapter,discovery,_=checkpoint
    result=ready(adapter,discovery)
    class Fault:
        def __init__(self,conn):self.conn=conn
        def __getattr__(self,name):return getattr(self.conn,name)
        def execute(self,sql,params=()):
            if 'INSERT INTO "RaceResult"' in sql:raise RuntimeError('controlled_publish_failure')
            return self.conn.execute(sql,params)
    @contextmanager
    def failing():
        with worker.connection() as conn:yield Fault(conn)
    adapter.connection=failing
    with pytest.raises(RuntimeError,match='controlled_publish_failure'):
        adapter.publish(result,worker.position)
    adapter.connection=worker.connection
    assert previous(adapter)=={'contentHash':'old-validated-hash','count':1}
    assert adapter.ready().extracted_total==2


def test_capacity_pause_preserves_ready_checkpoint(checkpoint):
    adapter,discovery,_=checkpoint
    result=ready(adapter,discovery)
    with worker.connection() as conn:
        conn.execute('UPDATE "CatalogCapacity" SET "confirmedAt"=NULL WHERE id=1')
    with pytest.raises(CapacityDeferred):adapter.publish(result,worker.position)
    assert previous(adapter)=={'contentHash':'old-validated-hash','count':1}
    with worker.connection() as conn:
        conn.execute('UPDATE "CatalogCapacity" SET "confirmedAt"=now() WHERE id=1')
    assert adapter.ready().extracted_total==2


def test_expiry_cleanup_and_history_preserve_published_results(checkpoint):
    adapter,discovery,_=checkpoint
    adapter.start(discovery,datetime.now(timezone.utc))
    adapter.save_page(discovery.modalities[0],'F',0,parsed_page(discovery,'F',0))
    with worker.connection() as conn:
        conn.execute('UPDATE "CollectionTask" SET status=\'failed\',"leaseToken"=NULL,"leaseUntil"=NULL WHERE id=%s',(adapter.task['id'],))
        # Operational cleanup cannot cascade away an unexpired resumable root.
        conn.execute('DELETE FROM "CollectionTask" WHERE id=%s',(adapter.task['id'],))
        assert conn.execute('SELECT id FROM "CollectionTask" WHERE id=%s',(adapter.task['id'],)).fetchone()
        conn.execute('UPDATE "ResultCheckpoint" SET "expiresAt"=now()-interval \'1 second\' WHERE "rootTaskId"=%s',(adapter.root_id,))
    assert cleanup_checkpoints(worker.connection)==1
    assert previous(adapter)=={'contentHash':'old-validated-hash','count':1}
    with worker.connection() as conn:
        assert conn.execute('SELECT count(*) AS n FROM "ResultCheckpointRow" WHERE "rootTaskId"=%s',(adapter.root_id,)).fetchone()['n']==0


@pytest.mark.asyncio
async def test_completed_groups_are_not_refetched(checkpoint,monkeypatch):
    adapter,discovery,settings=checkpoint
    adapter.start(discovery,datetime.now(timezone.utc))
    for offset in (0,1):adapter.save_page(discovery.modalities[0],'F',offset,parsed_page(discovery,'F',offset))
    import app.services.scraper as scraper
    monkeypatch.setattr(scraper,'parse_event_page',lambda *args:discovery)
    monkeypatch.setattr(scraper.OpenResultsClient,'get_event_page',AsyncMock(return_value='fixture only'))
    calls=[]
    async def fetch(self,url,referer):
        params=parse_qs(urlsplit(url).query);calls.append(params['genero'][0])
        return page(discovery,params['genero'][0],int(params['offset'][0]))
    monkeypatch.setattr(scraper.OpenResultsClient,'get_endpoint_page',fetch)
    assert (await OpenResultsScraper(settings).scrape(discovery.metadata.source_url,checkpoint=adapter)).extracted_total==2
    assert calls==['M']


@pytest.mark.asyncio
async def test_real_worker_queue_defer_claim_and_stream_publish(checkpoint,monkeypatch):
    adapter,discovery,_=checkpoint
    import app.services.scraper as scraper
    monkeypatch.setenv('OPENRESULTS_PAGE_SIZE','1')
    monkeypatch.setattr(scraper,'parse_event_page',lambda *args:discovery)
    monkeypatch.setattr(scraper.OpenResultsClient,'get_event_page',AsyncMock(return_value='fixture only'))
    calls=[]
    async def fetch(self,url,referer):
        params=parse_qs(urlsplit(url).query)
        gender,offset=params['genero'][0],int(params['offset'][0]);calls.append((gender,offset))
        if len(calls)==2:raise SourceBudgetDeferred(datetime.now(timezone.utc))
        return page(discovery,gender,offset)
    monkeypatch.setattr(scraper.OpenResultsClient,'get_endpoint_page',fetch)
    await worker.execute(adapter.task)
    queued=worker.query('SELECT * FROM "CollectionTask" WHERE id=%s',(adapter.task['id'],),True)
    assert queued['status']=='queued' and queued['attempt']==0
    assert queued['progress']['checkpointRecords']==1 and queued['progress']['stage']=='source_budget_wait'
    assert previous(adapter)=={'contentHash':'old-validated-hash','count':1}
    recovered=worker.query('SELECT * FROM claim_selected_task(%s,%s,%s)',(['openresults'],'recovered-fixture',[adapter.task['id']]),True)
    assert recovered and recovered['id']==adapter.task['id']
    await worker.execute(recovered)
    done=worker.query('SELECT status,progress FROM "CollectionTask" WHERE id=%s',(adapter.task['id'],),True)
    assert done['status']=='completed' and done['progress']['processed']==2
    assert calls==[('F',0),('F',1),('F',1),('M',0)]
    assert previous(adapter)['count']==2
