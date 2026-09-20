"""Phased remote-only acceptance. Never starts an API or worker locally.

Run through with-staging-secrets.ps1 -Action remote, setting
STAGING_REMOTE_PHASE to check, collect, results, export, or download.
Only sanitized evidence is persisted; result samples and tokens stay in memory.
"""
import hashlib
import hmac
import io
import json
import os
import secrets
import sys
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import httpx
import psycopg
from psycopg.rows import dict_row
from openpyxl import load_workbook

API = 'https://universal-race-calendar.onrender.com'
BASE = 'https://sggrijhyblejlgimgzzc.supabase.co'
assert os.environ['SUPABASE_URL'] == BASE
EVENT = 'evt_91fe44bc51e94cf6acf036b6'
FILE = Path('.secrets/staging-remote-report.json')
report = json.loads(FILE.read_text()) if FILE.exists() else {'api': API, 'projectRef': 'sggrijhyblejlgimgzzc', 'eventId': EVENT, 'checks': {}}
phase = os.environ.get('STAGING_REMOTE_PHASE', 'check')
client = httpx.Client(timeout=120, follow_redirects=False)
internal = {'X-API-Key': os.environ['INTERNAL_API_KEY']}
auth = internal
stage = phase


def call(method, path, expected=200, body=None, key=None, headers=None):
    h = dict(auth if headers is None else headers)
    if key:
        h['Idempotency-Key'] = key
    r = client.request(method, API + path, headers=h, json=body)
    if r.status_code != expected:
        raise RuntimeError('unexpected_http_' + str(r.status_code))
    return r.json() if r.content else None


def db(sql, params=()):
    with psycopg.connect(os.environ['WORKER_DATABASE_URL'], row_factory=dict_row, connect_timeout=15,
                         options='-c default_transaction_read_only=on -c statement_timeout=20000') as conn:
        return conn.execute(sql, params).fetchall()


def result_snapshot():
    response = call('GET', f'/v1/events/{EVENT}/results?limit=100&page=1')
    rows = response['data']
    total = response['pagination']['total']
    for page in range(2, (total + 99) // 100 + 1):
        rows.extend(call('GET', f'/v1/events/{EVENT}/results?limit=100&page={page}')['data'])
    assert len(rows) == total
    # Stable content comparison excludes generated IDs and collection timestamps.
    content = sorted(json.dumps({k: v for k, v in row.items() if k not in ['id', 'resultSet']}, sort_keys=True) for row in rows)
    return {'count': total, 'contentHash': hashlib.sha256(json.dumps(content).encode()).hexdigest(),
            'sampleHash': hashlib.sha256(json.dumps(content[:5]).encode()).hexdigest()}


def check_task(task_id):
    row = call('GET', '/v1/tasks/' + task_id)
    evidence = {k: row.get(k) for k in ['id', 'source', 'kind', 'status', 'attempt', 'errorCode']}
    report.setdefault('tasks', {})[task_id] = evidence
    print(json.dumps(evidence), flush=True)
    assert db('SELECT status FROM "CollectionTask" WHERE id=%s', (task_id,))[0]['status'] == row['status']
    return row


try:
    # A stable, temporary test identity keeps owner-scoped idempotency across phases.
    # Derive its password in memory from an existing protected local secret.
    nonce = report.setdefault('identityNonce', secrets.token_hex(16))
    email = 'remote-staging-' + nonce + '@example.com'
    password = hmac.new(os.environ['INTERNAL_API_KEY'].encode(), nonce.encode(), hashlib.sha256).hexdigest()
    if not report.get('temporaryAdminId'):
        user = client.post(BASE + '/auth/v1/admin/users', headers={'apikey': os.environ['SUPABASE_SECRET_KEY']},
                           json={'email': email, 'password': password, 'email_confirm': True, 'app_metadata': {'role': 'admin'}})
        assert user.status_code == 200
        report['temporaryAdminId'] = user.json()['id']
        FILE.write_text(json.dumps(report, indent=2))
    session = client.post(BASE + '/auth/v1/token?grant_type=password', headers={'apikey': os.environ['SUPABASE_PUBLISHABLE_KEY']},
                          json={'email': email, 'password': password})
    assert session.status_code == 200
    auth = {'Authorization': 'Bearer ' + session.json()['access_token']}
    if phase == 'check':
        stage = 'health_version'
        call('GET', '/health', headers={})
        report['version'] = call('GET', '/v1/version', headers={})
        stage = 'admin_credential'
        internal_response = client.get(API + '/v1/admin/source-matches?limit=1', headers=internal)
        report['internalCredentialStatus'] = internal_response.status_code
        call('GET', '/v1/admin/source-matches?limit=1')
        for name, headers in [('missing', {}), ('invalid', {'Authorization': 'Bearer invalid'})]:
            call('GET', '/v1/admin/source-matches?limit=1', 401, headers=headers)
            report['checks']['admin_' + name + '_rejected'] = True
        report['checks']['supabase_admin_allowed'] = True
        stage = 'supabase_login_and_roles'
        users = []
        try:
            for role in ['admin', 'member']:
                email, password = f'remote-staging-{secrets.token_hex(10)}@example.com', secrets.token_urlsafe(32)
                user = client.post(BASE + '/auth/v1/admin/users', headers={'apikey': os.environ['SUPABASE_SECRET_KEY']},
                                   json={'email': email, 'password': password, 'email_confirm': True, 'app_metadata': {'role': role}})
                assert user.status_code == 200
                users.append(user.json()['id'])
                session = client.post(BASE + '/auth/v1/token?grant_type=password', headers={'apikey': os.environ['SUPABASE_PUBLISHABLE_KEY']},
                                      json={'email': email, 'password': password})
                assert session.status_code == 200
                call('GET', '/v1/admin/source-matches?limit=1', 200 if role == 'admin' else 403,
                     headers={'Authorization': 'Bearer ' + session.json()['access_token']})
                report['checks']['supabase_' + role] = True
        finally:
            for user_id in users:
                deleted = client.delete(BASE + '/auth/v1/admin/users/' + user_id, headers={'apikey': os.environ['SUPABASE_SECRET_KEY']})
                assert deleted.status_code == 200
            report['checks']['temporary_users_removed'] = True
        stage = 'existing_association'
        refs = db('SELECT "sourceType","sourceExternalId" FROM "EventSourceReference" WHERE "eventId"=%s', (EVENT,))
        assert any(r['sourceType'] == 'openresults' and r['sourceExternalId'] == '37007' for r in refs)
        report['before'] = result_snapshot()
        report['checks']['existing_association'] = True
        report['checks']['jwt_project_identity'] = True
    elif phase == 'collect':
        assert report['checks']['jwt_project_identity']
        body = {'source': 'openresults', 'eventId': EVENT}
        key = report.setdefault('collectionKey', str(uuid.uuid4()))
        FILE.write_text(json.dumps(report, indent=2))
        task = call('POST', '/v1/collections', 202, body=body, key=key)
        report['collectionTaskId'] = task['id']
        same = call('POST', '/v1/collections', 202, body=body, key=key)
        assert same['id'] == task['id']
        report['checks']['collection_202_same_key'] = True
        assert len(db('SELECT id FROM "CollectionTask" WHERE id=%s', (task['id'],))) == 1
        report['checks']['api_queue_in_staging'] = True
        assert check_task(task['id'])['status'] == 'queued'
    elif phase == 'results':
        task = check_task(report['collectionTaskId'])
        assert task['status'] in ['completed', 'partial', 'failed']
        report['collectionOutcome'] = task['status']
        detail = db('SELECT "maxAttempts",progress FROM "CollectionTask" WHERE id=%s', (task['id'],))[0]
        report['collectionDetails'] = detail
        report['after'] = result_snapshot()
        report['checks']['content_matches_previous'] = report['before'] == report['after']
        same = call('POST', '/v1/collections', 202, body={'source': 'openresults', 'eventId': EVENT}, key=report['collectionKey'])
        assert same['id'] == report['collectionTaskId'] and same['status'] == task['status']
        report['checks']['idempotency_after_completion'] = True
    elif phase == 'export':
        key = report.setdefault('exportKey', str(uuid.uuid4()))
        FILE.write_text(json.dumps(report, indent=2))
        item = call('POST', f'/v1/events/{EVENT}/exports', 202, key=key)
        same = call('POST', f'/v1/events/{EVENT}/exports', 202, key=key)
        assert item['id'] == same['id'] and item['taskId'] == same['taskId']
        report['exportId'], report['exportTaskId'] = item['id'], item['taskId']
        assert check_task(item['taskId'])['status'] == 'queued'
    elif phase == 'download':
        assert check_task(report['exportTaskId'])['status'] == 'completed'
        call('GET', '/v1/exports/' + report['exportId'], 401, headers={})
        item = call('GET', '/v1/exports/' + report['exportId'])
        assert item['status'] == 'completed'
        url = item['downloadUrl']
        assert urlsplit(url).hostname == urlsplit(BASE).hostname
        response = client.get(url)
        assert response.status_code == 200
        book = load_workbook(io.BytesIO(response.content), read_only=True)
        rows = sum(sum(1 for _ in sheet.rows) - 1 for sheet in book.worksheets)
        book.close()
        assert rows == report['after']['count']
        bucket = client.get(BASE + '/storage/v1/bucket/race-exports', headers={'apikey': os.environ['SUPABASE_SECRET_KEY']})
        assert bucket.status_code == 200 and bucket.json()['public'] is False
        path = db('SELECT "objectPath" FROM "ExportArtifact" WHERE id=%s', (item['id'],))[0]['objectPath']
        unsigned = client.get(BASE + '/storage/v1/object/public/race-exports/' + path)
        assert unsigned.status_code in [400, 401, 403, 404]
        report['export'] = {'bytes': len(response.content), 'rows': rows, 'signedDownload': True, 'privateBucket': True,
                            'unsignedStatus': unsigned.status_code, 'expiresAt': item['expiresAt']}
        report['checks']['results_survive_export'] = result_snapshot() == report['after']
        deleted = client.delete(BASE + '/auth/v1/admin/users/' + report['temporaryAdminId'], headers={'apikey': os.environ['SUPABASE_SECRET_KEY']})
        assert deleted.status_code == 200
        report['checks']['flow_admin_removed'] = True
    else:
        raise ValueError('invalid_phase')
    report['lastPhase'] = phase
    report['lastPhaseStatus'] = 'passed'
    report.pop('failedStage', None)
    report.pop('errorType', None)
except Exception as error:
    report.update(lastPhase=phase, lastPhaseStatus='failed', failedStage=stage, errorType=type(error).__name__)
finally:
    FILE.write_text(json.dumps(report, indent=2))
    # Omit even harmless idempotency keys/hashes from user-facing logs.
    print(json.dumps({k: v for k, v in report.items() if k not in ['collectionKey', 'exportKey', 'before', 'after', 'identityNonce', 'temporaryAdminId']}), flush=True)
    client.close()
sys.exit(0 if report.get('lastPhaseStatus') == 'passed' else 1)
