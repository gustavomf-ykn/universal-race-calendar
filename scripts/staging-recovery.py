"""Controlled interruption against real staging queue/Storage, without more source requests."""
import asyncio
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path
from types import SimpleNamespace

import httpx
import psycopg
from psycopg.rows import dict_row

assert os.environ['SUPABASE_URL'] == 'https://sggrijhyblejlgimgzzc.supabase.co'
sys.path.insert(0, str(Path('apps/openresults-worker').resolve()))
import worker

flow = json.loads(Path('.secrets/staging-flow-report.json').read_text())
assert flow['status'] == 'passed'
api = 'http://127.0.0.1:3303'
headers = {'X-API-Key': os.environ['INTERNAL_API_KEY']}
report = {'projectRef': flow['projectRef'], 'eventId': flow['eventId'], 'checks': {}}
processes = []
lock = None
stage = 'start'

def call(method, path, expected=200, body=None):
    h = dict(headers, **{'Idempotency-Key': str(uuid.uuid4())})
    r = httpx.request(method, api + path, headers=h, json=body, timeout=20)
    assert r.status_code == expected
    return r.json() if r.content else None

def start_worker():
    p = subprocess.Popen([sys.executable, '-m', 'worker'], cwd='apps/openresults-worker',
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    processes.append(p)
    return p

def snapshot():
    return worker.query('SELECT s.id,s.count,s."contentHash",count(r.id) AS actual FROM "ResultSet" s '
                        'JOIN "RaceResult" r ON r."resultSetId"=s.id WHERE s."eventId"=%s GROUP BY s.id',
                        (flow['eventId'],))

try:
    processes.append(subprocess.Popen(['node', 'apps/api/dist/apps/api/src/server.js'],
                     env=dict(os.environ, PORT='3303'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    for _ in range(30):
        try: call('GET', '/health'); break
        except Exception: time.sleep(1)
    before = snapshot()
    old_export = call('GET', '/v1/exports/' + flow['exportId'])
    signed_url = old_export['downloadUrl']
    stage = 'interruption'
    artifact = call('POST', '/v1/events/' + flow['eventId'] + '/exports', 202)
    report['taskId'] = artifact['taskId']
    report['exportId'] = artifact['id']
    lock = psycopg.connect(os.environ['WORKER_DATABASE_URL'])
    lock.execute('SELECT id FROM "ExportArtifact" WHERE id=%s FOR UPDATE', (artifact['id'],))
    executor = start_worker()
    old_task = None
    for _ in range(30):
        row = worker.query('SELECT * FROM "CollectionTask" WHERE id=%s', (artifact['taskId'],), True)
        if row['status'] == 'running': old_task = row; break
        time.sleep(1)
    assert old_task is not None
    executor.kill(); executor.wait(timeout=10)
    lock.rollback(); lock.close(); lock = None
    report['checks']['worker_killed_during_task'] = 'passed'
    started = time.monotonic()
    start_worker()
    print(json.dumps({'stage': 'waiting_for_real_90_second_lease', 'taskId': artifact['taskId']}), flush=True)
    stage = 'lease_recovery'
    for _ in range(80):
        row = call('GET', '/v1/tasks/' + artifact['taskId'])
        if row['status'] == 'completed': break
        time.sleep(2)
    assert row['status'] == 'completed' and row['attempt'] == 2
    report['recoverySeconds'] = round(time.monotonic() - started)
    report['attempt'] = row['attempt']
    report['checks'][stage] = 'passed'
    stage = 'stale_executor_fenced'
    assert not worker.query('SELECT heartbeat_task(%s,%s,%s::jsonb) AS ok', (old_task['id'], old_task['leaseToken'], '{}'), True)['ok']
    assert not worker.query("SELECT finish_task(%s,%s,'failed',%s::jsonb,'controlled') AS ok", (old_task['id'], old_task['leaseToken'], '{}'), True)['ok']
    try:
        with worker.connection() as connection: worker.fenced(connection, old_task)
        raise AssertionError('stale_write_accepted')
    except RuntimeError:
        pass
    report['checks'][stage] = 'passed'
    stage = 'partial_preserves_results'
    try:
        worker.publish(old_task, SimpleNamespace(warnings=['controlled_incomplete'], records=[]))
        raise AssertionError('partial_accepted')
    except ValueError:
        pass
    assert snapshot() == before
    report['checks'][stage] = 'passed'
    stage = 'signed_link_expiry'
    assert httpx.get(signed_url, timeout=20).status_code in [400, 401, 403]
    report['checks'][stage] = 'passed'
    stage = 'private_storage_denied'
    obj = worker.query('SELECT "objectPath" FROM "ExportArtifact" WHERE id=%s', (artifact['id'],), True)['objectPath']
    r = httpx.get(os.environ['SUPABASE_URL'] + '/storage/v1/object/race-exports/' + obj,
                  headers={'apikey': os.environ['SUPABASE_PUBLISHABLE_KEY']}, timeout=20)
    assert r.status_code in [400, 401, 403, 404]
    report['checks'][stage] = 'passed'
    stage = 'artifact_expiry_preserves_results'
    with worker.connection() as conn:
        conn.execute('UPDATE "ExportArtifact" SET "expiresAt"=now()-interval \'1 second\' WHERE id=ANY(%s)',
                     ([artifact['id'], flow['exportId']],))
    expired = call('GET', '/v1/exports/' + artifact['id'])
    assert expired['status'] == 'expired' and expired['downloadUrl'] is None
    asyncio.run(worker.cleanup_exports())
    assert snapshot() == before
    assert call('GET', '/v1/events/' + flow['eventId'] + '/results?limit=1')['pagination']['total'] == flow['resultCount']
    obj_after = worker.query('SELECT "objectPath",status FROM "ExportArtifact" WHERE id=%s', (artifact['id'],), True)
    assert obj_after['objectPath'] is None and obj_after['status'] == 'expired'
    remaining = httpx.post(os.environ['SUPABASE_URL'] + '/storage/v1/object/list/race-exports',
                          headers=worker.storage_headers(), json={'prefix': artifact['id'] + '/'}, timeout=20)
    assert remaining.status_code == 200 and remaining.json() == []
    report['checks'][stage] = 'passed'
    report['status'] = 'passed'
except Exception as error:
    report.update(status='failed', failedStage=stage, errorType=type(error).__name__)
finally:
    if lock: lock.rollback(); lock.close()
    for process in reversed(processes):
        if process.poll() is None: process.kill(); process.wait(timeout=15)
    Path('.secrets/staging-recovery-report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)
raise SystemExit(0 if report.get('status') == 'passed' else 1)
