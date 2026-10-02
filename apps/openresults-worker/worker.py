"""Durable PostgreSQL executor. Never imports the legacy HTTP server or SQLite jobs."""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import signal
import uuid
import unicodedata
from datetime import date, datetime, timezone
from dataclasses import replace

import httpx
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from openpyxl import Workbook

from app.config import Settings
from app.models import AccessBlockedError, StructureChangedError
from app.services.openresults.metadata import EventMetadataService
from app.services.openresults.catalog import EventCatalog
from app.services.scraper import OpenResultsScraper
from batch import BatchRun
from presence import announce, stop_requested
from app.services.source_requests import request_hooks, SourceBudgetDeferred, SourceCircuitOpen
from source_requests import database_request_hooks
from capacity import CapacityDeferred, check_capacity, database_capacity, storage_capacity
from result_checkpoints import ResultCheckpoints, ResultCheckpointError, cleanup_checkpoints
from app.services.country import normalize_country
from event_aliases import payload as canonical_payload


def storage_headers():
    key=os.environ.get('SUPABASE_SECRET_KEY') or os.environ['SUPABASE_SERVICE_ROLE_KEY']
    return {'apikey':key, **({} if key.startswith('sb_secret_') else {'Authorization':f'Bearer {key}'})}


def claim_next_task():
    file=os.environ.get('WORKER_TASK_SELECTION_FILE')
    if not file:
        return query('SELECT * FROM claim_task(%s,%s)',(['openresults','exports'],str(uuid.uuid4())),True)
    try:
        from pathlib import Path
        ids=json.loads(Path(file).read_text(encoding='utf-8'))
        if not isinstance(ids,list) or len(ids)>100 or any(not isinstance(i,str) or not i or len(i)>100 for i in ids):raise ValueError()
    except Exception:
        raise ValueError('task_selection_invalid') from None
    return query('SELECT * FROM claim_selected_task(%s,%s,%s)',(['openresults','exports'],str(uuid.uuid4()),ids),True)


def connection():
    # psycopg uses libpq URI, not Prisma's ?schema=public parameter.
    return psycopg.connect(os.environ["WORKER_DATABASE_URL"], row_factory=dict_row)


def query(sql, params=(), one=False):
    with connection() as conn:
        cur = conn.execute(sql, params)
        return cur.fetchone() if one else cur.fetchall()


def fenced(conn, task, growth_bytes=65536):
    row = conn.execute('''SELECT id FROM "CollectionTask" WHERE id=%s AND status='running'
        AND "leaseToken"=%s AND "leaseUntil">now() FOR UPDATE''', (task['id'], task['leaseToken'])).fetchone()
    if not row:
        raise RuntimeError('lease_lost')
    check_capacity(conn, growth_bytes)


def publish(task, result):
    """Publish a complete replacement atomically; a failed transaction leaves old rows intact."""
    if result.warnings or not result.records or (result.expected_total is not None and len(result.records) != result.expected_total):
        raise ValueError('incomplete_extraction')
    payload = task['payload']
    records = result.records
    canonical = json.dumps(records, sort_keys=True, default=str, ensure_ascii=False)
    with connection() as conn:
        fenced(conn, task, len(canonical.encode()) * 8 + len(records) * 2048)
        payload = canonical_payload(conn, payload)
        reference = conn.execute('''SELECT r."eventId",e.date FROM "EventSourceReference" r JOIN "Event" e ON e.id=r."eventId"
            WHERE r."sourceType"='openresults' AND r."sourceExternalId"=%s FOR UPDATE OF r,e''', (payload['externalId'],)).fetchone()
        if not reference or reference['eventId'] != payload['eventId']:
            raise ValueError('association_changed')
        if not result.metadata.event_date or not reference['date'] or reference['date'].date() != result.metadata.event_date:
            raise ValueError('edition_date_mismatch')
        if result.metadata.event_id and str(result.metadata.event_id) != payload['externalId']:
            raise ValueError('source_identity_mismatch')
        result_set = conn.execute('''INSERT INTO "ResultSet" (id,"eventId",source,"externalId","sourceUrl","updatedAt","contentHash",count)
            VALUES (%s,%s,'openresults',%s,%s,now(),%s,%s) ON CONFLICT (source,"externalId") DO UPDATE
            SET "updatedAt"=now(),"contentHash"=EXCLUDED."contentHash",count=EXCLUDED.count,"sourceUrl"=EXCLUDED."sourceUrl" RETURNING id''',
            (str(uuid.uuid4()),payload['eventId'],payload['externalId'],payload['url'],hashlib.sha256(canonical.encode()).hexdigest(),len(records))).fetchone()['id']
        conn.execute('DELETE FROM "RaceResult" WHERE "resultSetId"=%s',(result_set,))
        conn.execute('DELETE FROM "RaceDiscipline" WHERE "resultSetId"=%s',(result_set,))
        for modality in result.modalities:
            conn.execute('''INSERT INTO "RaceDiscipline" (id,"resultSetId","externalId",name) VALUES (%s,%s,%s,%s)
                ON CONFLICT ("resultSetId","externalId") DO NOTHING''',(str(uuid.uuid5(uuid.NAMESPACE_URL,result_set+":"+str(modality.value))),result_set,str(modality.value),modality.name))
        for record in records:
            # Scoped to one source/edition; never creates a person identity from a name.
            digest=hashlib.sha256(json.dumps({k:record.get(k) for k in ['modality','gender','bib','name','category','overall_position']},sort_keys=True).encode()).hexdigest()
            conn.execute('''INSERT INTO "RaceResult" (id,"resultSetId","recordKey",modality,gender,category,bib,name,team,"overallPosition","categoryPosition",time,pace,"distanceKm",gap)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                (str(uuid.uuid5(uuid.NAMESPACE_URL,result_set+":"+digest)),result_set,digest,str(record.get('modality','')),record.get('gender'),record.get('category'),str(record.get('bib','')),
                 record.get('name',''),record.get('team'),position(record.get('overall_position')),position(record.get('category_position')),record.get('time'),record.get('pace'),record.get('distance_km'),record.get('gap')))
        conn.execute('UPDATE "EventSourceReference" SET "lastSeenAt"=now(),"updatedAt"=now() WHERE "sourceType"=\'openresults\' AND "sourceExternalId"=%s',(payload['externalId'],))
        conn.execute('SELECT finish_task(%s,%s,\'completed\',%s,NULL)',(task['id'],task['leaseToken'],Jsonb({'processed':len(records),'stage':'published'})))


def position(value):
    try:
        number=int(value)
        return number if number>0 else None
    except (TypeError,ValueError):
        return None


def store_match(task, metadata):
    external_id=str(metadata.event_id) if metadata.event_id else 'url:'+hashlib.sha256(metadata.source_url.encode()).hexdigest()
    with connection() as conn:
        fenced(conn,task)
        reference = conn.execute('''SELECT r."eventId",e.date,e.city,e.state,e.country FROM "EventSourceReference" r
            JOIN "Event" e ON e.id=r."eventId" WHERE r."sourceType"='openresults' AND r."sourceExternalId"=%s
            FOR SHARE OF e,r''', (external_id,)).fetchone()
        match = conn.execute('''INSERT INTO "SourceMatch" (id,source,"externalId",url,name,date,city,state,country,status,"updatedAt")
            VALUES (%s,'openresults',%s,%s,%s,%s,%s,%s,%s,'pending',now()) ON CONFLICT (source,"externalId") DO UPDATE SET
            url=EXCLUDED.url,name=EXCLUDED.name,date=EXCLUDED.date,city=EXCLUDED.city,state=EXCLUDED.state,
            country=coalesce(EXCLUDED.country,"SourceMatch".country),"updatedAt"=now() RETURNING *''',
            (str(uuid.uuid4()),external_id,metadata.source_url,metadata.name,metadata.event_date,metadata.city,metadata.state,
             normalize_country(metadata.country) or None)).fetchone()
        # A reused provider ID still needs compatible edition evidence. An old resolved status
        # must not hide a newly observed conflict; references/results remain untouched for review.
        def normalized(value):
            return ' '.join(''.join(c for c in unicodedata.normalize('NFD', value or '')
                                   if not unicodedata.combining(c)).casefold().split())
        evidence = metadata.raw_metadata.get('country_evidence') or {}
        invalid_country = evidence.get('status') in ('conflicting', 'unrecognized') or bool(metadata.country and not normalize_country(metadata.country))
        compatible = bool(reference and not invalid_country and match['date'] and reference['date']
                          and match['date'].astimezone(timezone.utc).date() == reference['date'].date()
                          and all(normalized(match[field]) and normalized(match[field]) == normalized(reference[field])
                                  for field in ('city', 'state', 'country')))
        if compatible:
            conn.execute('''UPDATE "SourceMatch" SET status='resolved',"eventId"=%s,
                "resolvedBy"=CASE WHEN "eventId"=%s AND status='resolved' THEN "resolvedBy" ELSE 'exact_reference' END
                WHERE id=%s''', (reference['eventId'],reference['eventId'],match['id']))
        elif reference:
            conn.execute('''UPDATE "SourceMatch" SET status='pending',"eventId"=NULL,"resolvedBy"=NULL
                WHERE id=%s''', (match['id'],))


def excel_cell(value):
    if isinstance(value,str) and value.lstrip().startswith(('=','+','-','@')):
        return "'"+value
    return value


def build_workbook(event_id):
    workbook=Workbook(write_only=True)
    sheet=workbook.create_sheet('Resultados')
    columns=['name','bib','modality','gender','category','overallPosition','categoryPosition','time','pace','team','source','sourceUrl','updatedAt']
    sheet.append(columns)
    index=0
    with connection() as conn:
        with conn.cursor(name='export_rows') as cursor:
            cursor.execute('''SELECT r.*,s.source,s."sourceUrl",s."updatedAt" FROM "RaceResult" r JOIN "ResultSet" s ON s.id=r."resultSetId"
                JOIN "Event" e ON e.id=s."eventId" WHERE s."eventId"=%s AND e."publicationStatus"='published' ORDER BY r.id''',(event_id,))
            for index,row in enumerate(cursor,1):
                if index%1000000==0:
                    sheet=workbook.create_sheet(f'Resultados-{index}');sheet.append(columns)
                sheet.append([excel_cell(str(row[c]) if isinstance(row[c],datetime) else row[c]) for c in columns])
    if not index:
        raise ValueError('results_unavailable')
    output=io.BytesIO();workbook.save(output)
    if output.tell()>50*1024*1024:
        raise ValueError('export_too_large')
    return output


async def export(task):
    if task['kind']=='export-selection':
        artifact=query('SELECT * FROM "ExportArtifact" WHERE "taskId"=%s',(task['id'],),one=True)
        if not artifact:raise ValueError('export_artifact_missing')
    else:
        # Repair the short API enqueue/artifact creation gap after an interrupted request.
        artifact=query('''INSERT INTO "ExportArtifact" (id,"eventId","ownerId","taskId",status,"expiresAt","createdAt")
            VALUES (%s,resolve_event_id(%s),%s,%s,'queued',%s::timestamptz+interval '1 day',%s)
            ON CONFLICT ("taskId") DO UPDATE SET "taskId"=EXCLUDED."taskId" RETURNING *''',
            (str(uuid.uuid4()),task['payload']['eventId'],task['ownerId'],task['id'],task['createdAt'],task['createdAt']),one=True)
    if artifact['expiresAt'].replace(tzinfo=timezone.utc)<=datetime.now(timezone.utc):
        raise ValueError('export_expired')
    from selection_export import build_selection
    if task['kind']=='export':
        artifact['selection']={'eventIds':[artifact['eventId']],'layout':'consolidated','administrative':False}
        artifact['kind']='results'
    output,extension,content_type,count=await asyncio.to_thread(build_selection,artifact,connection)
    with connection() as conn:
        fenced(conn,task)
        check_capacity(conn, len(output.getvalue()), 'storage', task)
    if artifact['expiresAt']<=datetime.now(timezone.utc):
        raise ValueError('export_expired')
    path=f"{artifact['id']}/{task['leaseToken']}.{extension}"
    base=os.environ['SUPABASE_URL'].rstrip('/')
    async with httpx.AsyncClient(timeout=30) as client:
        response=await client.post(f'{base}/storage/v1/object/race-exports/{path}',headers={
            **storage_headers(),
            'Content-Type':content_type,'x-upsert':'true'},content=output.getvalue())
        response.raise_for_status()
    with connection() as conn:
        fenced(conn,task)
        conn.execute('UPDATE "ExportArtifact" SET status=\'completed\',"objectPath"=%s,"contentType"=%s WHERE id=%s',(path,content_type,artifact['id']))
        conn.execute('SELECT finish_task(%s,%s,\'completed\',%s,NULL)',(task['id'],task['leaseToken'],Jsonb({'stage':'exported','exportId':artifact['id'],'processed':count,'format':extension})))
        conn.execute('DELETE FROM "CapacityReservation" WHERE "taskId"=%s AND "leaseToken"=%s',(task['id'],task['leaseToken']))


_cleanup_cursor = ''

async def cleanup_exports():
    global _cleanup_cursor
    # Revisit expired artifacts in bounded keyset batches. This also removes
    # orphan uploads from a worker that lost its lease after uploading.
    items=query('SELECT id,"objectPath" FROM "ExportArtifact" WHERE "expiresAt"<now() AND id>%s ORDER BY id LIMIT 100',(_cleanup_cursor,))
    if not items:
        _cleanup_cursor=''
        return
    base=os.environ['SUPABASE_URL'].rstrip('/')+'/storage/v1/object'
    headers=storage_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        for item in items:
            response=await client.post(base+'/list/race-exports',headers=headers,json={'prefix':item['id']+'/', 'limit':100,'offset':0})
            response.raise_for_status()
            names=[row['name'] for row in response.json() if row.get('name','').endswith(('.xlsx','.zip')) and '/' not in row['name']]
            paths=[item['id']+'/'+name for name in names]
            if item['objectPath'] and item['objectPath'] not in paths: paths.append(item['objectPath'])
            if paths:
                response=await client.request('DELETE',base+'/race-exports',headers=headers,json={'prefixes':paths})
                response.raise_for_status()
            with connection() as conn:
                conn.execute("UPDATE \"ExportArtifact\" SET status='expired',\"objectPath\"=NULL WHERE id=%s",(item['id'],))
            _cleanup_cursor=item['id']


async def execute(task):
    progress={'stage':'starting','percent':0}
    checkpoint=None
    async def report(_stage,percent):
        # Avoid logging event names, URLs or athlete data from upstream messages.
        progress.update(stage='extracting',percent=percent)
    async def heartbeat():
        while True:
            await asyncio.sleep(20)
            result=await asyncio.to_thread(query,'SELECT heartbeat_task(%s,%s,%s) AS ok',(task['id'],task['leaseToken'],Jsonb(progress)),True)
            if not result['ok']:
                raise RuntimeError('lease_lost')
    async def work():
        nonlocal checkpoint
        await asyncio.to_thread(database_capacity, query)
        settings=replace(Settings.from_env(),scrape_concurrency=1,catalog_concurrency=1,metadata_concurrency=1)
        if task['kind']=='catalog-sync':
            from catalog_sync import sync_catalog
            await sync_catalog(task,settings,connection,fenced,progress)
        elif task['kind']=='discover':
            payload=task['payload']
            settings=replace(settings,catalog_max_pages=min(10,int(payload.get('maxPages',1))))
            catalog=await EventCatalog(settings).discover(date_from=date.fromisoformat(payload['from']),date_to=date.fromisoformat(payload['to']) if payload.get('to') else None)
            failed=0;processed=0
            for event in catalog.events[:min(100,int(payload.get('limit',25)))]:
                try:
                    metadata,_=await EventMetadataService(settings).fetch(event.event_url)
                    await asyncio.to_thread(store_match,task,metadata)
                except (AccessBlockedError, SourceBudgetDeferred, SourceCircuitOpen, CapacityDeferred):
                    raise
                except Exception:
                    failed+=1
                processed+=1
                progress.update(stage='discovering',processed=processed,failed=failed,discovered=len(catalog.events))
                await asyncio.sleep(0.5)
            if failed or catalog.warnings or len(catalog.events)>int(payload.get('limit',25)):
                await asyncio.to_thread(query,'SELECT finish_task(%s,%s,\'partial\',%s,%s)',(task['id'],task['leaseToken'],Jsonb(progress),'discovery_partial'))
        elif task['kind']=='inspect':
            service=EventMetadataService(settings)
            metadata,_=(await service.fetch(task['payload']['url'],enrich_roadrunners=True)
                if task['payload'].get('syncId') else await service.fetch(task['payload']['url']))
            from edition_metadata import update_edition
            await asyncio.to_thread(update_edition,task,metadata,connection,fenced)
            await asyncio.to_thread(store_match,task,metadata)
        elif task['kind']=='extract':
            checkpoint=ResultCheckpoints(task,settings,connection,fenced,progress)
            result=await OpenResultsScraper(settings).scrape(task['payload']['url'],report,checkpoint=checkpoint)
            from edition_metadata import update_edition
            await asyncio.to_thread(update_edition,task,result.metadata,connection,fenced)
            if result.checkpoint_root_id:
                await asyncio.to_thread(checkpoint.publish,result,position)
            else:
                await asyncio.to_thread(publish,task,result)
        elif task['kind'] in ('export','export-selection'):
            await asyncio.to_thread(storage_capacity, query)
            await export(task)
        else:
            raise ValueError('unsupported_task')
    hooks_token=request_hooks.set(database_request_hooks(query))
    pulse=asyncio.create_task(heartbeat());job=asyncio.create_task(work())
    try:
        async with asyncio.timeout(1800):
            done,_=await asyncio.wait([pulse,job],return_when=asyncio.FIRST_COMPLETED)
            for item in done:
                await item
        await asyncio.to_thread(query,'SELECT finish_task(%s,%s,\'completed\',%s,NULL)',(task['id'],task['leaseToken'],Jsonb(progress)))
    except Exception as exc:
        if isinstance(exc, CapacityDeferred):
            progress['stage']='capacity_wait'
            progress['capacityResource']=exc.resource
            await asyncio.to_thread(query,'SELECT defer_capacity_task(%s,%s,%s,%s)',
                (task['id'],task['leaseToken'],Jsonb(progress),exc.reason))
            return
        if isinstance(exc, (SourceBudgetDeferred, SourceCircuitOpen)):
            progress['stage']='source_access_blocked' if isinstance(exc, SourceCircuitOpen) else 'source_budget_wait'
            await asyncio.to_thread(query,'SELECT defer_source_task(%s,%s,%s,%s,%s)',
                (task['id'],task['leaseToken'],Jsonb(progress),exc.retry_at,isinstance(exc, SourceCircuitOpen)))
            return
        if isinstance(exc, AccessBlockedError):
            await asyncio.to_thread(query,'SELECT block_source_requests(%s,NULL)',('openresults',))
        if checkpoint and isinstance(exc, (StructureChangedError, ResultCheckpointError)):
            await asyncio.to_thread(checkpoint.invalidate,'source_structure_changed' if isinstance(exc,StructureChangedError) else str(exc))
        if isinstance(exc, (AccessBlockedError, StructureChangedError, ResultCheckpointError)):
            with connection() as conn:
                conn.execute('UPDATE "CollectionTask" SET "maxAttempts"=attempt WHERE id=%s AND "leaseToken"=%s',(task['id'],task['leaseToken']))
        code=('source_access_blocked' if isinstance(exc, AccessBlockedError) else
              'source_structure_changed' if isinstance(exc, StructureChangedError) else
              str(exc) if isinstance(exc, ResultCheckpointError) else
              str(exc) if isinstance(exc,ValueError) and str(exc) in {'incomplete_extraction','catalog_checkpoint_incompatible','idempotency_conflict','catalog_pagination_not_advancing','catalog_end_unconfirmed','selected_edition_without_results','export_too_large_refine_selection','export_expired','source_identity_already_associated','edition_date_mismatch'} else 'collection_failed')
        outcome='partial' if code=='incomplete_extraction' else 'failed'
        await asyncio.to_thread(query,'SELECT finish_task(%s,%s,%s,%s,%s)',(task['id'],task['leaseToken'],outcome,Jsonb(progress),code))
    finally:
        pulse.cancel();job.cancel()
        await asyncio.gather(pulse,job,return_exceptions=True)
        request_hooks.reset(hooks_token)


async def main():
    run = BatchRun()
    watchdog = run.watchdog()
    stopped=False
    def stop(*_):
        nonlocal stopped
        stopped=True
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    tick=0
    worker_id=str(uuid.uuid4())
    async def presence_pulse():
      nonlocal stopped
      while not stopped:
        await asyncio.sleep(20)
        try:
          await asyncio.to_thread(announce,query,worker_id,'stopping' if stop_requested() else 'busy' if run.active_task_id else 'available',run.active_task_id)
        except Exception:
          stopped=True
          print('Results: connection lost; stopping before the next task.',flush=True)
    presence_task=None
    try:
      await asyncio.to_thread(announce,query,worker_id,'available')
      presence_task=asyncio.create_task(presence_pulse())
      print('Results executor connected; waiting for panel requests.',flush=True)
      await asyncio.to_thread(cleanup_checkpoints,connection)
      # Batch runs may finish before the old 60-tick cleanup cadence.
      if run.batch and os.environ.get('SUPABASE_URL'):
        try: await cleanup_exports()
        except (httpx.HTTPError,KeyError): print('Export cleanup pending; verify Storage configuration.',flush=True)
      while not stopped and not stop_requested() and run.can_claim():
        task=await asyncio.to_thread(claim_next_task)
        if task:
            run.claimed += 1
            run.active_task_id = task['id']
            await asyncio.to_thread(announce,query,worker_id,'busy',task['id'])
            print(f"Results task {task['id']}: started.",flush=True)
            await execute(task)
            outcome=await asyncio.to_thread(query,'SELECT status FROM "CollectionTask" WHERE id=%s',(task['id'],),True)
            run.tasks.append({'id':task['id'],'status':outcome['status']})
            run.tasks = run.tasks[-100:]
            run.active_task_id = None
            await asyncio.to_thread(announce,query,worker_id,'available')
            print(f"Results task {task['id']}: {outcome['status']}.",flush=True)
        else:
            if run.batch:
                run.reason = 'queue_empty'
                break
            await asyncio.sleep(1)
        tick+=1
        if tick%60==0:
            try:
                await asyncio.to_thread(cleanup_checkpoints,connection)
                await cleanup_exports()
            except (httpx.HTTPError,KeyError): print('Export cleanup pending; verify Storage configuration.',flush=True)
    except Exception:
        run.reason = 'worker_failed'
        raise RuntimeError('worker_failed') from None
    finally:
        if presence_task:
            presence_task.cancel()
            await asyncio.gather(presence_task,return_exceptions=True)
        try: await asyncio.to_thread(announce,query,worker_id,'stopped')
        except Exception: pass
        if watchdog: watchdog.cancel()
        run.report()


if __name__=='__main__':
    try:
        asyncio.run(main())
    except Exception:
        print('Worker stopped; inspect sanitized task history and database connectivity.',flush=True)
        raise SystemExit(1) from None
