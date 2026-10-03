from unittest.mock import AsyncMock, MagicMock
import pytest
import worker
from capacity import CapacityDeferred, check_capacity
from app.config import Settings
from app.services.scraper import OpenResultsScraper
from app.services.openresults_client import OpenResultsClient
from source_requests import database_request_hooks


@pytest.fixture(autouse=True)
def local_admission_ready_for_database_capacity_unit_tests(monkeypatch):
    # These cases exercise database/Storage deferral, not host disk availability.
    # Dedicated local-resource tests cover admission and fail-closed behavior.
    import source_requests
    ready = lambda: None
    monkeypatch.setattr(worker, 'assert_resources', ready)
    monkeypatch.setattr(source_requests, 'assert_resources', ready)


@pytest.mark.asyncio
async def test_unconfigured_worker_retains_task_without_fetching_or_finishing(monkeypatch):
    query = MagicMock(return_value={'decision': 'capacity_unconfigured'})
    scrape = AsyncMock()
    monkeypatch.setattr(worker, 'query', query)
    monkeypatch.setattr(worker.OpenResultsScraper, 'scrape', scrape)
    await worker.execute({'id': 'capacity-test', 'leaseToken': 'capacity-lease', 'kind': 'extract', 'payload': {}})
    scrape.assert_not_awaited()
    assert query.call_count == 2
    assert 'defer_capacity_task' in query.call_args.args[0]
    assert query.call_args.args[1][-1] == 'capacity_unconfigured'
    assert query.call_args.args[1][2].obj['capacityResource'] == 'database'


@pytest.mark.asyncio
async def test_network_guard_checks_capacity_before_reserving_source_requests():
    query = MagicMock(return_value={'decision': 'capacity_database_limit'})
    with pytest.raises(CapacityDeferred):
        await database_request_hooks(query).before()
    assert query.call_count == 1
    assert 'check_catalog_capacity' in query.call_args.args[0]


@pytest.mark.asyncio
async def test_capacity_pause_never_triggers_chromium_fallback(monkeypatch):
    import app.services.scraper as scraper
    fallback = AsyncMock()
    monkeypatch.setattr(scraper, 'run_playwright_fallback', fallback)
    monkeypatch.setattr(OpenResultsClient, 'get_event_page', AsyncMock(side_effect=CapacityDeferred('capacity_database_limit')))
    with pytest.raises(CapacityDeferred):
        await OpenResultsScraper(Settings()).scrape('https://openresults.run/evento/teste/')
    fallback.assert_not_awaited()


def test_storage_reservation_is_fenced_and_records_exact_output_size():
    conn = MagicMock()
    conn.execute.return_value.fetchone.return_value = {'decision': 'allowed'}
    check_capacity(conn, 12345, 'storage', {'id': 'task', 'leaseToken': 'token'})
    assert conn.execute.call_args.args[1] == ('storage', 12345, 'task', 'token')


@pytest.mark.asyncio
async def test_unknown_storage_pauses_before_building_export(monkeypatch):
    query = MagicMock(side_effect=lambda sql,*_: {'decision': 'capacity_measurement_unavailable' if "'storage'" in sql else 'allowed'})
    export = AsyncMock()
    monkeypatch.setattr(worker, 'query', query)
    monkeypatch.setattr(worker, 'export', export)
    await worker.execute({'id':'capacity-export','leaseToken':'token','kind':'export-selection','payload':{}})
    export.assert_not_awaited()
    assert 'defer_capacity_task' in query.call_args.args[0]
    assert query.call_args.args[1][2].obj['capacityResource'] == 'storage'
