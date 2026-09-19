"""Small real-source staging flow. Emits only execution IDs, counts and states."""
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

import httpx

assert os.environ['SUPABASE_URL'] == 'https://sggrijhyblejlgimgzzc.supabase.co'
API = 'http://127.0.0.1:3302'
headers = {'X-API-Key': os.environ['INTERNAL_API_KEY']}
report = {'projectRef': 'sggrijhyblejlgimgzzc', 'tasks': [], 'checks': {}}
processes = []
stage = 'startup'

def call(method, path, expected=200, body=None, key=None):
    h = dict(headers)
    if key: h['Idempotency-Key'] = key
    response = httpx.request(method, API + path, headers=h, json=body, timeout=30)
    if response.status_code != expected:
        raise RuntimeError('http_' + str(response.status_code))
    return response.json() if response.content else None

def task(path, body=None):
    row = call('POST', path, 202, body, str(uuid.uuid4()))
    return wait_task(row['id'])

def wait_task(task_id):
    for _ in range(180):
        row = call('GET', '/v1/tasks/' + task_id)
        if row['status'] in ['completed', 'partial', 'failed', 'cancelled']:
            evidence = {k: row.get(k) for k in ['id', 'source', 'kind', 'status', 'attempt', 'errorCode']}
            report['tasks'].append(evidence)
            print(json.dumps(evidence), flush=True)
            if row['status'] != 'completed': raise RuntimeError('task_' + row['status'])
            return row
        time.sleep(3)
    raise RuntimeError('task_timeout')

try:
    env = dict(os.environ, PORT='3302', NODE_ENV='production')
    for command, cwd in [
        (['node', 'apps/api/dist/apps/api/src/server.js'], None),
        (['node', 'apps/worker/dist/apps/worker/src/queue.js'], None),
        ([sys.executable, '-m', 'worker'], 'apps/openresults-worker'),
    ]:
        processes.append(subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    for _ in range(30):
        try:
            call('GET', '/health')
            break
        except Exception: time.sleep(1)
    stage = 'calendar_discovery'
    if '--corridasbr' in sys.argv:
        stage = 'corridasbr_separate'
        result = task('/v1/collections', {'source': 'corridasbr', 'quantity': 1, 'states': ['SC']})
        assert result['progress'].get('processed', 0) == 1
        report['checks'][stage] = 'passed'
        report['status'] = 'passed'
        raise SystemExit(0)
    sources = call('GET', '/v1/sources')['data']
    source = next((s for s in sources if s.get('adapter') == 'ticketsports' and s.get('externalId') == '74857'), None)
    if not source:
        source = call('POST', '/v1/sources', 201, {
            'name': 'MOUNTAIN DO COSTAO DO SANTINHO 2026', 'type': 'registration_page',
            'adapter': 'ticketsports', 'externalId': '74857', 'country': 'BR', 'state': 'SC',
            'city': 'Florianopolis', 'url': 'https://site.ticketsports.com.br/Inscricao/categoria.aspx?__idEvento=74857'})
    task('/v1/sources/' + source['id'] + '/check')
    events = call('GET', '/v1/events?from=2026-07-25&to=2026-07-25&limit=100')['data']
    matching = [e for e in events if 'SANTINHO' in e.get('name', '').upper()]
    assert len(matching) == 1
    event = matching[0]
    report['eventId'] = event['id']
    report['checks']['calendar_discovery'] = 'passed'
    stage = 'source_association'
    task('/v1/admin/source-matches', {'url': 'https://openresults.run/evento/2026-mountain-do-costao-do-santinho-2026/'})
    matches = call('GET', '/v1/admin/source-matches?limit=100')['data']
    match = next((m for m in matches if m['externalId'] == '37007'), None)
    if match:
        assert match['date'].startswith('2026-07-25') and 'SANTINHO' in match['name'].upper()
        call('POST', '/v1/admin/source-matches/' + match['id'] + '/resolve', body={'eventId': event['id']})
    report['checks']['source_association'] = 'passed'
    stage = 'real_extraction'
    body = {'source': 'openresults', 'eventId': event['id']}
    key = str(uuid.uuid4())
    first = call('POST', '/v1/collections', 202, body, key)
    again = call('POST', '/v1/collections', 202, body, key)
    assert first['id'] == again['id']
    report['checks']['same_request_idempotency'] = 'passed'
    wait_task(first['id'])
    results_path = '/v1/events/' + event['id'] + '/results?page=1&limit=2'
    results = call('GET', results_path)
    count = results['pagination']['total']
    assert count > 0 and len(results['data']) == 2
    report['resultCount'] = count
    report['checks']['persisted_paginated_results'] = 'passed'
    stage = 'export_download'
    artifact = call('POST', '/v1/events/' + event['id'] + '/exports', 202, key=str(uuid.uuid4()))
    report['exportId'] = artifact['id']
    wait_task(artifact['taskId'])
    export = call('GET', '/v1/exports/' + artifact['id'])
    response = httpx.get(export['downloadUrl'], timeout=30)
    assert response.status_code == 200 and response.content.startswith(b'PK')
    report['exportBytes'] = len(response.content)
    report['checks']['storage_download'] = 'passed'
    stage = 'repeat_extraction'
    task('/v1/collections', body)
    assert call('GET', results_path)['pagination']['total'] == count
    report['checks']['repeat_collection_count'] = 'passed'
    report['status'] = 'passed'
except Exception as error:
    report.update(status='failed', failedStage=stage, errorType=type(error).__name__)
finally:
    for process in reversed(processes):
        if process.poll() is None:
            process.terminate()
            try: process.wait(timeout=15)
            except subprocess.TimeoutExpired: process.kill(); process.wait()
    filename = 'staging-corridasbr-report.json' if '--corridasbr' in sys.argv else 'staging-flow-report.json'
    Path('.secrets', filename).write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)
raise SystemExit(0 if report.get('status') == 'passed' else 1)
