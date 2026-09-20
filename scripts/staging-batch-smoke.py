"""Real Supabase batch acceptance. No fixture extraction; no credentials/athlete rows in output."""
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

import httpx
import psycopg
from psycopg.rows import dict_row

assert os.environ['SUPABASE_URL'] == 'https://sggrijhyblejlgimgzzc.supabase.co'
root = Path.cwd()
api = 'http://127.0.0.1:3304'
headers = {'X-API-Key': os.environ['INTERNAL_API_KEY']}
event_id = 'evt_91fe44bc51e94cf6acf036b6'
report = {'projectRef': 'sggrijhyblejlgimgzzc', 'checks': {}, 'runs': []}
processes = []
lock = None
stage = 'startup'

def sql(statement, args=(), one=False):
    with psycopg.connect(os.environ['WORKER_DATABASE_URL'], row_factory=dict_row) as conn:
        cursor = conn.execute(statement, args)
        return cursor.fetchone() if one else cursor.fetchall()

def call(method, path, expected=200, body=None, key=None):
    h = dict(headers, **{'Idempotency-Key': key or str(uuid.uuid4())})
    r = httpx.request(method, api + path, headers=h, json=body, timeout=30)
    assert r.status_code == expected
    return r.json() if r.content else None

def start(kind, tasks=3, seconds=120, mode='batch'):
    file = root / '.secrets' / ('batch-' + kind + '-' + uuid.uuid4().hex + '.json')
    env = dict(os.environ, WORKER_MODE=mode, WORKER_MAX_TASKS=str(tasks),
               WORKER_MAX_SECONDS=str(seconds), WORKER_REPORT_PATH=str(file))
    command = ['node', 'apps/worker/dist/apps/worker/src/queue.js'] if kind == 'typescript' else [sys.executable, '-m', 'worker']
    p = subprocess.Popen(command, cwd=root if kind == 'typescript' else root/'apps/openresults-worker',
                         env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    processes.append(p)
    return p, file

def finish(handle, expected=0):
    p, file = handle
    assert p.wait(timeout=160) == expected
    row = json.loads(file.read_text())
    report['runs'].append(row)
    print(json.dumps(row), flush=True)
    return row

try:
    # This dedicated schema already passed staging; refuse to consume unrelated pending work.
    assert sql('SELECT count(*) AS n FROM "CollectionTask" WHERE status IN (\'queued\',\'running\')', one=True)['n'] == 0
    env = dict(os.environ, PORT='3304', CORS_ORIGINS='https://staging-client.example')
    p = subprocess.Popen(['node', 'scripts/start-staging-api.mjs'], env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    processes.append(p)
    for _ in range(30):
        try: call('GET', '/health'); break
        except Exception: time.sleep(1)
    before = call('GET', f'/v1/events/{event_id}/results?limit=1')['pagination']['total']
    for kind in ['typescript', 'python']:
        stage = 'empty_' + kind
        row = finish(start(kind))
        assert row['claimed'] == 0 and row['reason'] == 'queue_empty'
        report['checks'][stage] = 'passed'
        continuous, _ = start(kind, mode='continuous')
        time.sleep(2)
        assert continuous.poll() is None
        continuous.kill(); continuous.wait()
    report['checks']['continuous_mode_preserved'] = 'passed'
    stage = 'task_limits'
    source = next(s for s in call('GET', '/v1/sources')['data'] if s.get('adapter') == 'ticketsports' and s.get('externalId') == '74857')
    checks = [call('POST', '/v1/sources/' + source['id'] + '/check', 202) for _ in range(2)]
    row = finish(start('typescript', tasks=1))
    assert row['claimed'] == 1 and row['reason'] == 'task_limit'
    assert call('GET', '/v1/tasks/' + checks[1]['id'])['status'] == 'queued'
    finish(start('typescript'))
    extract_key = str(uuid.uuid4())
    body = {'source': 'openresults', 'eventId': event_id}
    first = call('POST', '/v1/collections', 202, body, extract_key)
    again = call('POST', '/v1/collections', 202, body, extract_key)
    assert first['id'] == again['id']
    artifact = call('POST', f'/v1/events/{event_id}/exports', 202)
    row = finish(start('python', tasks=1))
    assert row['claimed'] == 1 and row['reason'] == 'task_limit'
    states = [call('GET', '/v1/tasks/' + task_id)['status'] for task_id in [first['id'], artifact['taskId']]]
    # Queue acquisition is source-scoped, not globally FIFO across exports/openresults.
    assert sorted(states) == ['completed', 'queued']
    finish(start('python'))
    assert call('GET', '/v1/tasks/' + first['id'])['status'] == 'completed'
    assert call('GET', '/v1/tasks/' + artifact['taskId'])['status'] == 'completed'
    report['checks'][stage] = 'passed'
    assert call('GET', f'/v1/events/{event_id}/results?limit=1')['pagination']['total'] == before
    link = call('GET', '/v1/exports/' + artifact['id'])['downloadUrl']
    download = httpx.get(link, timeout=30)
    assert download.status_code == 200 and download.content.startswith(b'PK')
    report['checks']['real_collection_idempotency_persistence_storage'] = 'passed'
    stage = 'duration_limits'
    interrupted_ts = call('POST', '/v1/sources/' + source['id'] + '/check', 202)
    interrupted_py = call('POST', f'/v1/events/{event_id}/exports', 202)
    lock = psycopg.connect(os.environ['WORKER_DATABASE_URL'])
    lock.execute('SELECT id FROM "Source" WHERE id=%s FOR UPDATE', (source['id'],))
    lock.execute('SELECT id FROM "ExportArtifact" WHERE id=%s FOR UPDATE', (interrupted_py['id'],))
    a, b = start('typescript', seconds=4), start('python', seconds=4)
    ra, rb = finish(a, 75), finish(b, 75)
    assert ra['reason'] == rb['reason'] == 'duration_limit'
    assert ra['elapsedSeconds'] <= 6 and rb['elapsedSeconds'] <= 6
    old = sql('SELECT id,"leaseToken" FROM "CollectionTask" WHERE id=ANY(%s)', ([interrupted_ts['id'], interrupted_py['taskId']],))
    lock.rollback(); lock.close(); lock = None
    report['checks'][stage] = 'passed'
    print('Waiting for real lease expiry before subsequent finite batches.', flush=True)
    time.sleep(92)
    finish(start('typescript')); finish(start('python'))
    stage = 'recovery'
    for row in old:
        state = call('GET', '/v1/tasks/' + row['id'])
        assert state['status'] == 'completed' and state['attempt'] == 2
        assert not sql("SELECT finish_task(%s,%s,'failed','{}'::jsonb,'stale') AS ok", (row['id'], row['leaseToken']), True)['ok']
    report['checks'][stage] = 'passed'
    assert call('GET', f'/v1/events/{event_id}/results?limit=1')['pagination']['total'] == before
    report.update(status='passed', resultCount=before)
except Exception as error:
    report.update(status='failed', failedStage=stage, errorType=type(error).__name__)
finally:
    if lock: lock.rollback(); lock.close()
    for process in reversed(processes):
        if process.poll() is None: process.kill(); process.wait(timeout=10)
    Path('.secrets/staging-batch-report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)
raise SystemExit(0 if report.get('status') == 'passed' else 1)
