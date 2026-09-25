"""Bounded native OpenResults pages, with atomic per-candidate checkpoints."""
import hashlib
import json
import uuid
from psycopg.types.json import Jsonb
from app.services.openresults.catalog import parse_catalog_payload
from app.services.openresults_client import OpenResultsClient

async def sync_catalog(task, settings, connection, fenced, progress):
    sync_id=task['payload']['syncId']
    with connection() as conn:
        sync=conn.execute('SELECT * FROM "CatalogSync" WHERE id=%s',(sync_id,)).fetchone()
    if not sync:raise ValueError('sync_not_found')
    if sync['status']!='ready':
        progress.update(stage=sync['status'],syncId=sync_id,processed=0)
        return
    options=sync['options']; snapshot=sync['snapshot']
    previous_hash=snapshot.get('previous') if isinstance(snapshot,dict) else None
    if (not snapshot or isinstance(snapshot,dict)) and sync['cursor']==0:
        async with OpenResultsClient(settings) as client:
            payload=await client.get_catalog_page(sync['page'])
        events,total,more=parse_catalog_payload(payload)
        page_hash=hashlib.sha256(json.dumps([e.event_url for e in events]).encode()).hexdigest()
        if events and page_hash==previous_hash:raise ValueError('catalog_pagination_not_advancing')
        if not events and more is not False and total != 0:raise ValueError('catalog_end_unconfirmed')
        snapshot=[]
        for event in events:
            day=event.event_date.isoformat() if event.event_date else None
            if day and ((options.get('from') and day<options['from']) or (options.get('to') and day>options['to'])): continue
            if event.state and event.state not in options['states']: continue
            snapshot.append({'_pageHash':page_hash,'name':event.name,'date':day,'city':event.city,'state':event.state,'url':event.event_url,'externalId':str(event.event_id) if event.event_id else 'url:'+hashlib.sha256(event.event_url.encode()).hexdigest()})
        # Pagination metadata is checkpointed separately from the filtered candidates.
        coverage='last_page' if more is False or not events else 'native_pages'
        with connection() as conn:
            fenced(conn,task)
            conn.execute('UPDATE "CatalogSync" SET snapshot=%s,coverage=%s,discovered=discovered+%s,"updatedAt"=now() WHERE id=%s',(Jsonb(snapshot),coverage,len(events),sync_id))
        sync['coverage']=coverage
    else:
        page_hash=snapshot[0]['_pageHash'] if snapshot else previous_hash
    created=existing=0
    batch=snapshot[sync['cursor']:sync['cursor']+options['batchSize']]
    for row in batch:
        with connection() as conn:
            fenced(conn,task)
            ref=conn.execute('''SELECT id FROM "EventSourceReference" WHERE "sourceType"='openresults' AND ("sourceExternalId"=%s OR rtrim(url,'/')=rtrim(%s,'/'))''',(row['externalId'],row['url'])).fetchone()
            if ref:
                conn.execute('UPDATE "EventSourceReference" SET "lastSeenAt"=now() WHERE id=%s',(ref['id'],));existing+=1
            else:
                digest=hashlib.sha256(('openresults:'+row['externalId']).encode()).hexdigest()
                source_id='src_'+digest[:24];event_id='evt_'+digest[:24]
                source=conn.execute('''INSERT INTO "Source" (id,name,url,type,adapter,"externalId","createdAt","updatedAt") VALUES (%s,%s,%s,'official_page','openresults',%s,now(),now()) ON CONFLICT (adapter,"externalId") DO UPDATE SET adapter=EXCLUDED.adapter RETURNING id''',(source_id,row['name'],row['url'],row['externalId'])).fetchone()
                event=conn.execute('''INSERT INTO "Event" (id,slug,name,date,city,state,country,"sourceId","sourceType","sourceExternalId","sourceUrl","canonicalFingerprint",warnings,"publishabilityReasons","publicationStatus","administrativeReview","createdAt","updatedAt") VALUES (%s,%s,%s,%s,%s,%s,'BR',%s,'openresults',%s,%s,%s,'[]','["administrative_review_required"]','pending_review',true,now(),now()) ON CONFLICT ("sourceType","sourceExternalId") DO UPDATE SET "sourceType"=EXCLUDED."sourceType" RETURNING id''',(event_id,'openresults-'+digest[:24],row['name'],row['date'],row['city'] or None,row['state'] or None,source['id'],row['externalId'],row['url'],digest)).fetchone()
                conn.execute('''INSERT INTO "EventSourceReference" (id,"eventId","sourceId","sourceType","sourceExternalId",url,"updatedAt") VALUES (%s,%s,%s,'openresults',%s,%s,now())''',(str(uuid.uuid4()),event['id'],source['id'],row['externalId'],row['url']));created+=1
            conn.execute('UPDATE "CatalogSync" SET cursor=cursor+1,processed=processed+1,"updatedAt"=now() WHERE id=%s',(sync_id,))
    if sync['cursor']+len(batch)>=len(snapshot):
        with connection() as conn:
            fenced(conn,task)
            if sync['coverage']=='last_page':
                conn.execute('''UPDATE "CatalogSync" SET status='completed',"updatedAt"=now() WHERE id=%s''',(sync_id,))
            else:
                conn.execute('''UPDATE "CatalogSync" SET snapshot=%s,cursor=0,page=page+1,"updatedAt"=now() WHERE id=%s''',(Jsonb({'previous':page_hash}),sync_id))
    progress.update(stage='catalog_batch',syncId=sync_id,created=created,existing=existing,processed=len(batch),coverage=sync['coverage'])
