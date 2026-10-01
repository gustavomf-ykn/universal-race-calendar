import asyncio
from contextlib import asynccontextmanager
from contextvars import Context
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from app.config import Settings
from app.models import AccessBlockedError
from app.services import safe_network
from app.services.openresults_client import OpenResultsClient
from app.services.scraper import OpenResultsScraper
from app.services.source_requests import RequestHooks, SourceBudgetDeferred, SourceCircuitOpen, request_hooks
from source_requests import database_request_hooks, retry_after_at
import worker


@pytest.mark.asyncio
@pytest.mark.parametrize('error',[SourceBudgetDeferred(datetime.now(timezone.utc)),SourceCircuitOpen()])
async def test_deferred_request_never_opens_transport_and_worker_requeues_without_failure(monkeypatch,error):
    monkeypatch.setattr(safe_network,'public_ip',AsyncMock(return_value='8.8.8.8'))
    transport=MagicMock()
    token=request_hooks.set(RequestHooks(AsyncMock(side_effect=error),AsyncMock()))
    try:
        with pytest.raises(type(error)):
            await safe_network.bounded_get(transport,'https://openresults.run/',{},1)
        transport.stream.assert_not_called()
    finally:
        request_hooks.reset(token)
    monkeypatch.setattr(worker.OpenResultsScraper,'scrape',AsyncMock(side_effect=error))
    query=MagicMock()
    monkeypatch.setattr(worker,'query',query)
    await worker.execute({'id':'test-task','leaseToken':'test-lease','kind':'extract','payload':{'url':'https://openresults.run/evento/test/'}})
    assert query.call_count==1 and 'defer_source_task' in query.call_args.args[0]
    assert query.call_args.args[1][-1] is isinstance(error,SourceCircuitOpen)
    assert request_hooks.get() is None


@pytest.mark.asyncio
async def test_redirects_count_each_transport_and_429_is_not_retried(monkeypatch):
    monkeypatch.setattr(safe_network,'public_ip',AsyncMock(return_value='8.8.8.8'))
    calls=[]
    def response(request):
        calls.append(request.url.path)
        if request.url.path=='/first':
            return httpx.Response(302,headers={'Location':'/second'})
        return httpx.Response(429,headers={'Retry-After':'60'})
    before=AsyncMock();after=AsyncMock()
    token=request_hooks.set(RequestHooks(before,after))
    try:
        async with OpenResultsClient(Settings(request_attempts=3)) as client:
            await client.client.aclose()
            client.client=httpx.AsyncClient(transport=httpx.MockTransport(response),follow_redirects=False)
            with pytest.raises(AccessBlockedError):
                await client._request('https://openresults.run/first',accept='text/html')
        assert calls==['/first','/second']
        assert before.await_count==2
        assert after.await_args_list[-1].args==(429,'60')
    finally:
        request_hooks.reset(token)


@pytest.mark.asyncio
async def test_waiting_is_outside_network_timeout_and_not_a_fallback_trigger(monkeypatch):
    monkeypatch.setattr(safe_network,'public_ip',AsyncMock(return_value='8.8.8.8'))
    token=request_hooks.set(RequestHooks(lambda: asyncio.sleep(0.03),AsyncMock()))
    try:
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _:httpx.Response(200,text='ok'))) as client:
            assert (await safe_network.bounded_get(client,'https://openresults.run/',{},0.01)).text=='ok'
    finally:
        request_hooks.reset(token)
    import app.services.scraper as scraper
    fallback=AsyncMock()
    monkeypatch.setattr(scraper,'run_playwright_fallback',fallback)
    monkeypatch.setattr(OpenResultsClient,'get_event_page',AsyncMock(side_effect=SourceBudgetDeferred(datetime.now(timezone.utc))))
    with pytest.raises(SourceBudgetDeferred):
        await OpenResultsScraper(Settings()).scrape('https://openresults.run/evento/teste/')
    fallback.assert_not_awaited()


@pytest.mark.asyncio
async def test_chromium_route_carries_task_hooks_and_preserves_control_error(monkeypatch):
    import app.services.playwright_fallback as fallback
    import playwright.async_api as playwright
    monkeypatch.setattr(fallback,'public_ip',AsyncMock(return_value='8.8.8.8'))
    error=SourceBudgetDeferred(datetime.now(timezone.utc))
    hooks=RequestHooks(AsyncMock(side_effect=error),AsyncMock())
    async def transport(*args):
        assert request_hooks.get() is hooks
        await request_hooks.get().before()
    monkeypatch.setattr(fallback,'bounded_get',transport)
    page=SimpleNamespace()
    async def route(_pattern,callback):page.callback=callback
    async def goto(*args,**kwargs):
        request=SimpleNamespace(url='https://openresults.run/evento/teste/',resource_type='document',method='GET',all_headers=AsyncMock(return_value={}))
        route=SimpleNamespace(request=request,abort=AsyncMock(),fulfill=AsyncMock())
        # This reproduces Playwright dispatch from a context without task hooks.
        await asyncio.create_task(page.callback(route),context=Context())
        route.abort.assert_awaited_once()
        raise playwright.Error('route aborted')
    page.route=route;page.goto=goto
    browser=SimpleNamespace(new_context=AsyncMock(return_value=SimpleNamespace(new_page=AsyncMock(return_value=page))))
    @asynccontextmanager
    async def fake_playwright():
        yield SimpleNamespace(chromium=SimpleNamespace(launch=AsyncMock(return_value=browser)))
    monkeypatch.setattr(playwright,'async_playwright',fake_playwright)
    token=request_hooks.set(hooks)
    try:
        with pytest.raises(SourceBudgetDeferred):
            await fallback.run_playwright_fallback('https://openresults.run/evento/teste/',Settings())
        assert request_hooks.get() is hooks
    finally:
        request_hooks.reset(token)


@pytest.mark.asyncio
async def test_database_protocol_respects_spacing_and_closes_with_retry_after():
    rows=iter([{'decision':'spacing','retryAt':datetime.now(timezone.utc)}, {'decision':'allowed','retryAt':None}])
    query=MagicMock(side_effect=lambda *_:next(rows))
    hooks=database_request_hooks(query)
    await hooks.before()
    assert query.call_count==2
    query.side_effect=None
    await hooks.after(429,'60')
    assert 'block_source_requests' in query.call_args.args[0]
    assert query.call_args.args[1][1]>datetime.now(timezone.utc)+timedelta(seconds=55)


def test_retry_after_accepts_seconds_or_http_date_without_unbounded_values():
    assert retry_after_at('Thu, 01 Oct 2026 16:00:00 GMT')==datetime(2026,10,1,16,tzinfo=timezone.utc)
    assert retry_after_at('60')>datetime.now(timezone.utc)
    for value in (None,'invalid','NaN','Infinity','1e9999'):
        assert retry_after_at(value) is None
