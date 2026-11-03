"""Fresh-context published-panel checks; never reads the owner's browser/session."""
import asyncio
import json
from pathlib import Path
import re
import runpy
import secrets
import sys
from urllib.parse import urlsplit
import httpx
from playwright.async_api import async_playwright
from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parents[1]
c = runpy.run_path(str(ROOT / "scripts/local-staging.py"))
env = c["environment"]("--from-environment" in sys.argv)
out = c["RUNTIME"]
PANEL = "https://runfinder-rithmy.lovable.app"
API = json.loads((out / "tunnel-public.json").read_text())["publicUrl"]
BASE = env["SUPABASE_URL"]
report = {"projectRef": c["REF"], "testType": "fresh_headless_browser_published_site", "checks": {}, "blockedDestinations": []}
uid = None
stage = "identity"
admin_headers = {"apikey": env["SUPABASE_SECRET_KEY"]}

async def run():
    global uid, stage
    v = httpx.get(API + "/v1/version", timeout=20).json()
    assert v["supabaseProjectRef"] == c["REF"]
    report['backendCommit'] = v['gitSha']
    if '--controls' in sys.argv:
        assert '--collect' not in sys.argv and '--export' not in sys.argv
        with c['connection'](env) as db:
            db.execute('SET default_transaction_read_only=on')
            assert db.execute('SELECT count(*) FROM "WorkerPresence" WHERE "lastSeenAt">now()-interval \'75 seconds\' AND state<>\'stopped\'').fetchone()[0] == 0
            assert db.execute('SELECT count(*) FROM "CollectionTask" WHERE status IN (\'queued\',\'running\')').fetchone()[0] == 0
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
        api_requests, auth_requests = set(), set()
        export_keys = []
        export_path = '/v1/events/evt_e27edbae921b459b9fa8bf1f/exports'
        page_errors = []
        async def guard(route):
            u = urlsplit(route.request.url)
            if u.hostname and u.hostname.endswith(".supabase.co"):
                if u.hostname != urlsplit(BASE).hostname:
                    report["blockedDestinations"].append(u.hostname)
                    await route.abort(); return
                auth_requests.add(u.hostname)
            if u.path.startswith("/v1/") or (u.hostname and u.hostname.endswith(".onrender.com")):
                if u.hostname != urlsplit(API).hostname:
                    report["blockedDestinations"].append(u.hostname)
                    await route.abort(); return
                api_requests.add(u.hostname)
            if '--export' in sys.argv and u.hostname == urlsplit(API).hostname and u.path == export_path and route.request.method == 'POST':
                export_keys.append(await route.request.header_value('idempotency-key'))
                if not report.get('lostAcceptedResponse'):
                    response = await route.fetch()
                    assert response.status == 202
                    accepted = await response.json()
                    report['exportId'], report['exportTaskId'] = accepted['id'], accepted['taskId']
                    report['lostAcceptedResponse'] = True
                    await route.abort('failed')
                    return
            await route.continue_()
        await context.route("**/*", guard)
        page = await context.new_page()
        page.on("pageerror", lambda error: page_errors.append(type(error).__name__))
        def response_seen(response):
            u = urlsplit(response.url)
            if u.hostname == urlsplit(BASE).hostname and u.path.startswith('/auth/v1/'):
                report.setdefault('authResponses', []).append({'path': u.path, 'status': response.status})
            if u.hostname == urlsplit(BASE).hostname and u.path.startswith('/storage/v1/'):
                report.setdefault('storageResponses', []).append({'status': response.status, 'contentType': response.headers.get('content-type'), 'attachment': 'attachment' in response.headers.get('content-disposition', '')})
        page.on('response', response_seen)
        stage = "published_calendar"
        await page.goto(PANEL, wait_until="domcontentloaded", timeout=60000)
        await page.get_by_role("link", name=re.compile("MOUNTAIN.*SANTINHO", re.I)).first.wait_for(timeout=90000)
        assert api_requests == {urlsplit(API).hostname} and not report["blockedDestinations"]
        report["checks"][stage] = "passed"
        stage = "technical_user"
        email = "runfinder-browser-" + secrets.token_hex(12) + "@example.com"
        password = secrets.token_urlsafe(32)
        r = httpx.post(BASE + "/auth/v1/admin/users", headers=admin_headers, json={
            "email": email, "password": password, "email_confirm": True, "app_metadata": {"role": "admin"}}, timeout=25)
        assert r.status_code == 200
        uid = r.json()["id"]
        (out / "browser-user-requiring-cleanup.json").write_text(json.dumps({"id": uid}))
        stage = "browser_login"
        await page.goto(PANEL + "/entrar", wait_until="networkidle")
        await page.get_by_label("Email", exact=True).fill(email)
        await page.get_by_label("Senha", exact=True).fill(password)
        await page.wait_for_timeout(500)
        report['inputsRetained'] = ((await page.get_by_label('Email', exact=True).input_value()) == email
            and (await page.get_by_label('Senha', exact=True).input_value()) == password)
        assert report['inputsRetained']
        await page.locator('form').get_by_role("button", name="Entrar", exact=True).click()
        await page.wait_for_timeout(5000)
        report['loginPath'] = urlsplit(page.url).path
        report['pageErrorCount'] = len(page_errors)
        await page.screenshot(path=str(out / 'browser-login.private.png'), mask=[page.locator('input')])
        await page.wait_for_url(lambda u: urlsplit(u).path == '/', timeout=60000)
        assert auth_requests == {urlsplit(BASE).hostname} and not report["blockedDestinations"]
        report["checks"][stage] = "passed"
        stage = "browser_details"
        await page.get_by_role("link", name=re.compile("MOUNTAIN.*SANTINHO", re.I)).first.click()
        await page.get_by_role("tab", name="Resultados", exact=True).wait_for(timeout=60000)
        assert "evt_e27edbae921b459b9fa8bf1f" in page.url
        report["checks"][stage] = "passed"
        stage = "browser_results"
        await page.get_by_role("tab", name="Resultados", exact=True).click()
        await page.get_by_text(re.compile("435 registros no total")).wait_for(timeout=60000)
        report["checks"][stage] = {"displayedTotal": 435}
        stage = 'browser_modality_and_pagination'
        await page.get_by_role('combobox').first.click()
        await page.get_by_role('option', name='5k', exact=True).click()
        await page.get_by_text(re.compile('91 registros no total')).wait_for(timeout=60000)
        await page.get_by_role('button', name='Próxima', exact=True).click()
        await page.get_by_text(re.compile('Página 2 de')).wait_for(timeout=60000)
        report['checks'][stage] = {'modality': '5k', 'total': 91, 'page': 2}
        if '--controls' in sys.argv:
            report['controlTaskIds'] = []
            stage = 'browser_cancel_queued_task'
            await page.get_by_role('tab', name='Ações', exact=True).click()
            async with page.expect_response(lambda r: urlsplit(r.url).path == '/v1/collections' and r.request.method == 'POST' and r.status == 202, timeout=60000) as pending:
                await page.get_by_role('button', name='Coletar / acompanhar resultados', exact=True).click()
            task = await (await pending.value).json()
            report['controlTaskIds'].append(task['id'])
            assert task['status'] == 'queued'
            async def cancel_task(task_id):
                await page.goto(PANEL + '/tarefas/' + task_id, wait_until='networkidle')
                await page.get_by_role('button', name='Cancelar tarefa', exact=True).click()
                await page.get_by_text('Cancelada', exact=True).wait_for(timeout=30000)
            await cancel_task(task['id'])
            report['checks'][stage] = 'passed'
            stage = 'browser_retry_without_source_requests'
            old_id = '9c5736fa-3234-4672-9882-82f1e6024b57'
            await page.goto(PANEL + '/tarefas/' + old_id, wait_until='networkidle')
            await page.get_by_role('button', name='Iniciar nova tentativa do início', exact=True).wait_for(timeout=30000)
            assert await page.get_by_role('button', name='Retomar páginas/etapas confirmadas', exact=True).count() == 0
            async with page.expect_response(lambda r: urlsplit(r.url).path == '/v1/tasks/' + old_id + '/retry' and r.status == 202, timeout=60000) as pending:
                await page.get_by_role('button', name='Iniciar nova tentativa do início', exact=True).click()
            retry = await (await pending.value).json()
            report['controlTaskIds'].append(retry['id'])
            assert retry['id'] != old_id
            await cancel_task(retry['id'])
            report['checks'][stage] = {'newTaskCancelledBeforeExecution': True, 'invalidCheckpointNotOffered': True}
            stage = 'browser_campaign_controls_without_execution'
            await page.goto(PANEL + '/admin/', wait_until='networkidle')
            heading = page.get_by_role('heading', name='Importação piloto das três fontes', exact=True)
            await heading.wait_for(timeout=60000)
            section = heading.locator('..')
            await section.get_by_label('Justificativa da carga ampla').fill('Controlled staging UI validation; executors stopped; no source requests')
            async with page.expect_response(lambda r: urlsplit(r.url).path == '/v1/admin/catalog/campaigns' and r.request.method == 'POST' and r.status == 202, timeout=60000) as pending:
                await section.get_by_role('button', name='Importar piloto das três fontes', exact=True).click()
            campaign = await (await pending.value).json()
            report['campaignId'] = campaign['id']
            article = section.locator('article').filter(has=page.get_by_text(campaign['id'], exact=True))
            for operation, label, expected in [('pause','Pausar','paused'),('resume','Retomar etapas não concluídas','discovery'),('cancel','Cancelar pendentes','cancelled')]:
                path = '/v1/admin/catalog/campaigns/' + campaign['id'] + '/' + operation
                async with page.expect_response(lambda r: urlsplit(r.url).path == path and r.status == 200, timeout=60000) as pending:
                    await article.get_by_role('button', name=label, exact=True).click()
                response = await (await pending.value).json()
                assert response['status'] == expected
            with c['connection'](env) as db:
                db.execute('SET default_transaction_read_only=on')
                tasks = db.execute('SELECT id,kind,status,attempt FROM "CollectionTask" WHERE "ownerId"=(SELECT "ownerId" FROM "CollectionTask" WHERE id=%s) ORDER BY "createdAt"', (task['id'],)).fetchall()
                assert len(tasks) == 5 and all(t[2] == 'cancelled' and t[3] == 0 for t in tasks)
                assert db.execute('SELECT status FROM "CollectionTask" WHERE id=%s', (old_id,)).fetchone()[0] == 'failed'
                assert db.execute('SELECT count(*) FROM "RaceResult"').fetchone()[0] == 435
                assert db.execute('SELECT count(*) FROM "CollectionTask" WHERE status IN (\'queued\',\'running\')').fetchone()[0] == 0
                assert not db.execute('SELECT enabled FROM "CatalogWeeklySchedule" WHERE id=1').fetchone()[0]
            report['checks'][stage] = {'steps': ['start','pause','resume','cancel'], 'tasks': tasks,
                'sourceTasksExecuted': 0, 'resultsPreserved': 435}
        if '--collect' in sys.argv:
            stage = 'browser_collection'
            with c['connection'](env) as db:
                db.execute('SET default_transaction_read_only=on')
                before_keys = {r[0] for r in db.execute('SELECT r."recordKey" FROM "RaceResult" r JOIN "ResultSet" s ON s.id=r."resultSetId" WHERE s."eventId"=%s', ('evt_e27edbae921b459b9fa8bf1f',)).fetchall()}
            await page.get_by_role('tab', name='Ações', exact=True).click()
            collect = page.get_by_role('button', name='Coletar / acompanhar resultados', exact=True)
            async with page.expect_response(lambda r: urlsplit(r.url).path == '/v1/collections' and r.request.method == 'POST' and r.status == 202, timeout=60000) as pending:
                await collect.click()
            accepted = await (await pending.value).json()
            report['collectionTaskId'] = accepted['id']
            async with page.expect_response(lambda r: urlsplit(r.url).path == '/v1/collections' and r.request.method == 'POST' and r.status == 202, timeout=60000) as pending:
                await collect.click()
            again = await (await pending.value).json()
            assert again['id'] == accepted['id']
            await page.get_by_text(re.compile('^(Concluída|Falhou|Parcial|Cancelada)$')).first.wait_for(timeout=900000)
            assert await page.get_by_text('Concluída', exact=True).count() > 0
            with c['connection'](env) as db:
                db.execute('SET default_transaction_read_only=on')
                state = db.execute('SELECT status,"errorCode" FROM "CollectionTask" WHERE id=%s', (accepted['id'],)).fetchone()
                after_rows = db.execute('SELECT r."recordKey" FROM "RaceResult" r JOIN "ResultSet" s ON s.id=r."resultSetId" WHERE s."eventId"=%s', ('evt_e27edbae921b459b9fa8bf1f',)).fetchall()
                after_keys = {r[0] for r in after_rows}
            assert state == ('completed', None) and len(after_keys) == len(after_rows) == 435
            report['checks'][stage] = {'status': state[0], 'sameKeySameTask': True, 'rows': len(after_rows),
                'newRecordKeys': len(after_keys-before_keys), 'removedRecordKeys': len(before_keys-after_keys), 'duplicates': len(after_rows)-len(after_keys)}
        if '--export' in sys.argv:
            stage = 'browser_export_lost_response'
            await page.get_by_role('tab', name='Ações', exact=True).click()
            button = page.get_by_role('button', name='Solicitar / acompanhar exportação', exact=True)
            await button.click()
            for _ in range(200):
                if report.get('lostAcceptedResponse') and await button.is_enabled(): break
                await asyncio.sleep(0.1)
            assert report.get('lostAcceptedResponse')
            async with page.expect_response(lambda r: urlsplit(r.url).path == export_path and r.request.method == 'POST' and r.status == 202, timeout=60000) as pending:
                await button.click()
            accepted = await (await pending.value).json()
            assert accepted['id'] == report['exportId'] and accepted['taskId'] == report['exportTaskId']
            async with page.expect_response(lambda r: urlsplit(r.url).path == export_path and r.request.method == 'POST' and r.status == 202, timeout=60000) as pending:
                await button.click()
            third = await (await pending.value).json()
            assert third['id'] == report['exportId'] and third['taskId'] == report['exportTaskId']
            assert len(export_keys) == 3 and len(set(export_keys)) == 1
            report['checks'][stage] = {'postAttempts': len(export_keys), 'uniqueArtifacts': 1, 'sameKey': True}
            stage = 'browser_export_download'
            await page.get_by_role('link', name='Minhas exportações', exact=True).first.click()
            row = page.get_by_role('row').filter(has=page.get_by_text(report['exportId'], exact=True))
            await row.wait_for(timeout=60000)
            await page.bring_to_front()
            await page.wait_for_timeout(25000)
            report['downloadUi'] = {'visibility': await page.evaluate('document.visibilityState'),
                'buttonEnabled': await row.get_by_role('button', name='Baixar', exact=True).is_enabled(),
                'readyMessage': await row.get_by_text('Pronto para baixar', exact=True).count() > 0}
            await page.screenshot(path=str(out / 'browser-export.private.png'), mask=[page.locator('input')])
            try:
                async with page.expect_download(timeout=60000) as download:
                    await row.get_by_role('button', name='Baixar', exact=True).click(timeout=45000)
            except Exception:
                report['downloadUi']['pathAfterClick'] = urlsplit(page.url).path
                report['downloadUi']['rowText'] = (await row.inner_text(timeout=3000))[:180] if urlsplit(page.url).path == '/exportacoes' else 'navigated'
                await page.screenshot(path=str(out / 'browser-export-failure.private.png'), mask=[page.locator('input')])
                raise
            path = out / 'downloads' / 'browser-results.xlsx'
            await (await download.value).save_as(path)
            book = load_workbook(path, read_only=True)
            sheet = book.active
            headers = list(next(sheet.iter_rows(values_only=True)))
            count = sum(1 for _ in sheet.iter_rows(min_row=2, values_only=True))
            book.close()
            assert count == 435 and len(headers) == 19
            report['checks'][stage] = {'rows': count, 'columns': len(headers), 'downloadedThroughUi': True}
        report["pageErrorCount"] = len(page_errors)
        report["apiOrigin"] = API
        report["authOrigin"] = BASE
        report["status"] = "passed"
        await context.close()
        await browser.close()

try:
    asyncio.run(run())
except Exception as error:
    report.update(status="failed", failedStage=stage, errorType=type(error).__name__)
finally:
    if '--controls' in sys.argv and report.get('status') != 'passed':
        # Clean only this technical test's own IDs; never touch unrelated history.
        cleanup = {'X-API-Key': env['INTERNAL_API_KEY']}
        try:
            if report.get('campaignId'):
                httpx.post(API + '/v1/admin/catalog/campaigns/' + report['campaignId'] + '/cancel',
                    headers={**cleanup, 'Idempotency-Key': 'cleanup-' + report['campaignId']},
                    json={'reason': 'Cancel only controlled browser test after failed assertion'}, timeout=30)
            for task_id in report.get('controlTaskIds', []):
                httpx.post(API + '/v1/tasks/' + task_id + '/cancel', headers=cleanup, timeout=30)
        except httpx.HTTPError:
            report['controlledCleanupPending'] = True
    if uid:
        try:
            r = httpx.delete(BASE + "/auth/v1/admin/users/" + uid, headers=admin_headers, timeout=25)
            report["technicalUserRemoved"] = r.status_code == 200
        except httpx.HTTPError:
            report["technicalUserRemoved"] = False
        if report["technicalUserRemoved"]:
            (out / "browser-user-requiring-cleanup.json").unlink(missing_ok=True)
        else:
            report.update(status='cleanup_pending', failedStage='technical_user_cleanup')
    (out / "published-browser-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))
raise SystemExit(0 if report.get("status") == "passed" else 2)
