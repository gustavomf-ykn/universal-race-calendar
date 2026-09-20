"""One authorized hosted-API collection consumed by one local Python batch.

Before running: confirm GitHub staging runs and other workers are stopped.
Use with-staging-secrets.ps1 -Action localflow. Never prints tokens or rows.
"""
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import uuid

import httpx
import psycopg
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://sggrijhyblejlgimgzzc.supabase.co'
API = 'https://universal-race-calendar.onrender.com'
EVENT = 'evt_91fe44bc51e94cf6acf036b6'
assert os.environ['SUPABASE_URL'] == BASE
REPORT = ROOT / '.secrets/staging-local-report.json'
if REPORT.exists():
    raise SystemExit('Existing local report: inspect it before authorizing another collection.')
report = {'eventId': EVENT}
user_id = None
client = httpx.Client(timeout=120)
admin = {'apikey': os.environ['SUPABASE_SECRET_KEY']}


def query(sql, params=()):
    with psycopg.connect(os.environ['WORKER_DATABASE_URL'], row_factory=dict_row,
                         connect_timeout=15, options='-c default_transaction_read_only=on -c statement_timeout=20000') as conn:
        return conn.execute(sql, params).fetchall()


def call(method, path, expected=200, **kwargs):
    response = client.request(method, API + path, **kwargs)
    if response.status_code != expected:
        raise RuntimeError('unexpected_http_status')
    return response.json()


def snapshot(headers):
    rows = []
    page = 1
    while True:
        response = call('GET', f'/v1/events/{EVENT}/results?limit=100&page={page}', headers=headers)
        rows.extend(response['data'])
        if page >= response['pagination']['totalPages']:
            break
        page += 1
    canonical = sorted(json.dumps({k: v for k, v in row.items() if k not in ['id', 'resultSet']}, sort_keys=True) for row in rows)
    return {'count': len(rows), 'hash': hashlib.sha256(json.dumps(canonical).encode()).hexdigest(),
            'updatedAt': sorted({row['resultSet']['updatedAt'] for row in rows})}


try:
    assert not query('SELECT id FROM "CollectionTask" WHERE status IN (\'queued\',\'running\')')
    report['queueInitiallyEmpty'] = True
    user = client.post(BASE + '/auth/v1/admin/users', headers=admin, json={
        'email': 'local-staging-' + secrets.token_hex(12) + '@example.com',
        'password': (password := secrets.token_urlsafe(32)), 'email_confirm': True,
        'app_metadata': {'role': 'admin'}})
    assert user.status_code == 200
    user_id = user.json()['id']
    report['temporaryAdminId'] = user_id
    REPORT.write_text(json.dumps(report))
    login = client.post(BASE + '/auth/v1/token?grant_type=password', headers={'apikey': os.environ['SUPABASE_PUBLISHABLE_KEY']},
                        json={'email': user.json()['email'], 'password': password})
    assert login.status_code == 200
    headers = {'Authorization': 'Bearer ' + login.json()['access_token']}
    report['version'] = call('GET', '/v1/version')
    before = snapshot(headers)
    refs = query('SELECT "sourceExternalId" FROM "EventSourceReference" WHERE "eventId"=%s AND "sourceType"=\'openresults\'', (EVENT,))
    assert any(row['sourceExternalId'] == '37007' for row in refs)
    headers['Idempotency-Key'] = str(uuid.uuid4())
    task = call('POST', '/v1/collections', 202, headers=headers, json={'source': 'openresults', 'eventId': EVENT})
    report['taskId'] = task['id']
    REPORT.write_text(json.dumps(report))
    pending = query('SELECT id,status,attempt FROM "CollectionTask" WHERE status IN (\'queued\',\'running\')')
    assert pending == [{'id': task['id'], 'status': 'queued', 'attempt': 0}]
    report['exclusiveQueuedTask'] = True
    batch_path = ROOT / '.secrets/staging-local-batch.json'
    env = dict(os.environ, WORKER_MODE='batch', WORKER_MAX_TASKS='1', WORKER_MAX_SECONDS='600', WORKER_REPORT_PATH=str(batch_path))
    completed = subprocess.run([sys.executable, '-m', 'worker'], cwd=ROOT / 'apps/openresults-worker', env=env,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=630)
    report['workerExitCode'] = completed.returncode
    batch = json.loads(batch_path.read_text())
    report['batch'] = batch
    assert batch['claimed'] == 1 and [row['id'] for row in batch['tasks']] == [task['id']]
    result = call('GET', '/v1/tasks/' + task['id'], headers=headers)
    report['task'] = {key: result.get(key) for key in ['id', 'status', 'attempt', 'errorCode', 'progress']}
    assert result['attempt'] == 1
    after = snapshot(headers)
    report.update(beforeCount=before['count'], afterCount=after['count'], contentChanged=before['hash'] != after['hash'],
                  publicationTimestampChanged=before['updatedAt'] != after['updatedAt'])
    report['validationFinished'] = True
except Exception as error:
    report.update(validationFinished=False, errorType=type(error).__name__)
finally:
    if user_id:
        try:
            report['temporaryAdminRemoved'] = client.delete(BASE + '/auth/v1/admin/users/' + user_id, headers=admin).status_code == 200
        except Exception:
            report['temporaryAdminRemoved'] = False
    REPORT.write_text(json.dumps(report, indent=2))
    print(json.dumps({key: value for key, value in report.items() if key != 'temporaryAdminId'}), flush=True)
    client.close()
sys.exit(0 if report.get('validationFinished') else 1)
