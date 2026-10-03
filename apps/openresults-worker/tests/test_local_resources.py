from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
import pytest
import local_resources as resources
from app.services.source_requests import CapacityDeferred, LocalResourceDeferred

MIB = 1024 * 1024
SAMPLE = dict(memoryAvailableBytes=2048*MIB, tempFreeBytes=2048*MIB, rssBytes=128*MIB)


def test_memory_rss_disk_and_exact_boundaries():
    assert resources.assess(SAMPLE)['reason'] is None
    assert resources.assess(dict(SAMPLE, memoryAvailableBytes=511*MIB))['reason'] == 'local_memory_limit'
    assert resources.assess(dict(SAMPLE, rssBytes=1024*MIB))['reason'] == 'local_memory_limit'
    assert resources.assess(dict(SAMPLE, tempFreeBytes=1023*MIB))['reason'] == 'local_disk_limit'
    assert resources.assess(dict(memoryAvailableBytes=512*MIB, tempFreeBytes=1024*MIB, rssBytes=1024*MIB-1))['reason'] is None


@pytest.mark.parametrize('value', [None, float('nan'), float('inf'), -1, True, 9007199254740992])
def test_unknown_or_invalid_measurements_fail_closed(value):
    assert resources.assess(dict(SAMPLE, rssBytes=value))['reason'] == 'local_resource_measurement_unavailable'


@pytest.mark.parametrize('value', ['0', '127', '-1', '1e3', '128.5', 'Infinity', '1048577', '１２８'])
def test_invalid_limits_never_disable_admission(value):
    with pytest.raises(ValueError, match='invalid_local_resource_limits'):
        resources.limits({'WORKER_MIN_FREE_MEMORY_MB': value})


def test_cgroup_v2_parent_limit_and_v1_limit_are_respected(tmp_path):
    root=tmp_path/'cgroup'; root.mkdir()
    child=root/'workers'; child.mkdir()
    (root/'memory.max').write_text('800')
    (root/'memory.current').write_text('700')
    (child/'memory.max').write_text('max')
    membership=tmp_path/'membership'; membership.write_text('0::/workers\n')
    assert resources.cgroup_available(10000,root,membership) == 100
    (child/'memory.max').write_text('100')
    (child/'memory.current').write_text('90')
    assert resources.cgroup_available(10000,root,membership) == 10
    memory=root/'memory'; memory.mkdir()
    (memory/'memory.limit_in_bytes').write_text('1000')
    (memory/'memory.usage_in_bytes').write_text('1200')
    membership.write_text('5:memory:/\n')
    assert resources.cgroup_available(10000,root,membership) == 0


def test_unreadable_cgroup_usage_is_not_host_free_memory(tmp_path):
    root=tmp_path/'cgroup'; root.mkdir()
    (root/'memory.max').write_text('100')
    membership=tmp_path/'membership'; membership.write_text('0::/\n')
    with pytest.raises(FileNotFoundError):resources.cgroup_available(10000,root,membership)


def test_process_tree_includes_chromium_and_access_denied_becomes_unknown(monkeypatch):
    parent=SimpleNamespace(memory_info=lambda:SimpleNamespace(rss=200),children=lambda recursive:[SimpleNamespace(memory_info=lambda:SimpleNamespace(rss=300))])
    monkeypatch.setattr(resources.psutil,'Process',lambda:parent)
    assert resources.measurements()['rssBytes'] == 500
    parent.children=lambda recursive:(_ for _ in ()).throw(resources.psutil.AccessDenied())
    assert resources.measurements()['rssBytes'] is None


@pytest.mark.asyncio
async def test_worker_pressure_retains_task_before_database_work_or_source_access(monkeypatch):
    import worker
    snapshot=resources.assess(dict(SAMPLE,memoryAvailableBytes=0))
    def reject():raise LocalResourceDeferred(snapshot)
    query=MagicMock()
    scrape=AsyncMock()
    monkeypatch.setattr(worker,'assert_resources',reject)
    monkeypatch.setattr(worker,'query',query)
    monkeypatch.setattr(worker.OpenResultsScraper,'scrape',scrape)
    await worker.execute(dict(id='resource-test',leaseToken='synthetic',kind='extract',payload={}))
    scrape.assert_not_awaited()
    assert query.call_count == 1 and 'defer_local_resource_task' in query.call_args.args[0]
    assert query.call_args.args[1][-1] == 'local_memory_limit'
    assert query.call_args.args[1][2].obj['localResources'] == snapshot


@pytest.mark.asyncio
async def test_transport_pressure_does_not_reserve_a_request_or_trigger_fallback(monkeypatch):
    import source_requests
    import app.services.scraper as scraper
    from app.config import Settings
    from app.services.openresults_client import OpenResultsClient
    snapshot=resources.assess(dict(SAMPLE,tempFreeBytes=0))
    def reject():raise LocalResourceDeferred(snapshot)
    monkeypatch.setattr(source_requests,'assert_resources',reject)
    query=MagicMock()
    with pytest.raises(LocalResourceDeferred):await source_requests.database_request_hooks(query).before()
    query.assert_not_called()
    fallback=AsyncMock()
    monkeypatch.setattr(scraper,'run_playwright_fallback',fallback)
    monkeypatch.setattr(OpenResultsClient,'get_event_page',AsyncMock(side_effect=LocalResourceDeferred(snapshot)))
    with pytest.raises(CapacityDeferred):await scraper.OpenResultsScraper(Settings()).scrape('https://openresults.run/evento/synthetic/')
    fallback.assert_not_awaited()
