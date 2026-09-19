"""Read-only SQLite inventory; explicit apply with an operator-reviewed ID mapping."""
import argparse
import hashlib
import json
import sqlite3
import uuid
from datetime import date,datetime,timezone
from pathlib import Path

from app.models import EventMetadata,ExtractionResult,ModalityInfo
from worker import connection,publish
from psycopg.types.json import Jsonb


def inventory(path):
    conn=sqlite3.connect(f'{Path(path).resolve().as_uri()}?mode=ro',uri=True)
    conn.row_factory=sqlite3.Row
    events=[]
    for event in conn.execute('SELECT * FROM catalog_events ORDER BY catalog_id'):
        item=dict(event)
        # Only a completed event from a completed job can replace permanent results.
        job=conn.execute('''SELECT je.job_id FROM job_events je JOIN jobs j ON j.id=je.job_id
            WHERE je.event_id=? AND je.status='completed' AND j.status='completed' ORDER BY j.updated_at DESC LIMIT 1''',(item['event_id'],)).fetchone()
        records=[] if not job else [json.loads(row['data_json']) for row in conn.execute('SELECT data_json FROM athlete_results WHERE event_id=? AND job_id=? ORDER BY row_id',(item['event_id'],job['job_id']))]
        item['records']=records
        item['digest']=hashlib.sha256(json.dumps(records,sort_keys=True).encode()).hexdigest()
        events.append(item)
    conn.close()
    return events


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('sqlite');parser.add_argument('--mapping',help='JSON object: old OpenResults event_id -> unified Event.id')
    parser.add_argument('--apply',action='store_true');parser.add_argument('--report',default='sqlite-migration-report.json')
    args=parser.parse_args();events=inventory(args.sqlite)
    mapping=json.loads(Path(args.mapping).read_text()) if args.mapping else {}
    report=[]
    for item in events:
        old_id=item['event_id'];new_id=mapping.get(old_id)
        entry={'catalogId':item['catalog_id'],'oldEventId':old_id,'eventId':new_id,'rows':len(item['records']),'digest':item['digest'],'status':'planned' if new_id else 'mapping_required'}
        report.append(entry)
        if not args.apply or not new_id:continue
        if not old_id or not item['start_date'] or not item['records']:
            entry['status']='skipped_incomplete';continue
        with connection() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(hashtext('race-task-acquisition'))")
            if conn.execute('SELECT id FROM "CollectionTask" WHERE source=\'openresults\' AND status=\'running\' AND "leaseUntil">now() LIMIT 1').fetchone():
                raise RuntimeError('Pause OpenResults workers and wait for active tasks before migration')
            reference=conn.execute('''SELECT "eventId" FROM "EventSourceReference" WHERE "sourceType"='openresults' AND "sourceExternalId"=%s''',(old_id,)).fetchone()
            if not reference or reference['eventId']!=new_id:
                raise ValueError(f'Associate source {old_id} to edition {new_id} through the admin API first')
            task_id=str(uuid.uuid4());token=str(uuid.uuid4())
            payload={'eventId':new_id,'externalId':old_id,'url':item['event_url']}
            task=conn.execute('''INSERT INTO "CollectionTask" (id,source,kind,status,"ownerId","idempotencyKey","requestHash",payload,attempt,"leaseToken","leaseUntil")
                VALUES (%s,'openresults','sqlite-migration','running','sqlite-migration',%s,%s,%s,1,%s,now()+interval '30 minutes') RETURNING *''',
                (task_id,task_id,item['digest'],Jsonb(payload),token)).fetchone()
        metadata=EventMetadata(item['name'],date.fromisoformat(item['start_date'][:10]),item['city'],item['state'],item['event_url'],item['event_slug'],item['expected_total'],event_id=old_id)
        modalities=[ModalityInfo(name,name) for name in sorted({row.get('modality','') for row in item['records']})]
        result=ExtractionResult(metadata,modalities,item['records'],item['expected_total'],len(item['records']),{}, {},extracted_at=datetime.now(timezone.utc))
        try:
            publish(task,result)
        except Exception:
            with connection() as conn:
                conn.execute('UPDATE "CollectionTask" SET "maxAttempts"=1 WHERE id=%s',(task_id,))
                conn.execute("SELECT finish_task(%s,%s,'failed',%s,'migration_failed')",(task_id,token,Jsonb({})))
            raise
        with connection() as conn:
            saved=conn.execute('''SELECT s.id,count(r.id) AS rows FROM "ResultSet" s LEFT JOIN "RaceResult" r ON r."resultSetId"=s.id
                WHERE s.source='openresults' AND s."externalId"=%s GROUP BY s.id''',(old_id,)).fetchone()
            assert saved['rows']==len(item['records'])
            entry.update(status='verified',resultSetId=saved['id'],verifiedRows=saved['rows'])
    Path(args.report).write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps({'events':len(events),'rows':sum(len(item['records']) for item in events),'applied':args.apply,'report':args.report}))


if __name__=='__main__':main()
