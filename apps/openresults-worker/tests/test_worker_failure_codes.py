from unittest.mock import MagicMock
import pytest
import worker
from app.models import AccessBlockedError


@pytest.mark.asyncio
@pytest.mark.parametrize('error,expected,outcome,disable_retry', [
    (AccessBlockedError('upstream-private-detail'), 'source_access_blocked', 'failed', True),
    (ValueError('incomplete_extraction'), 'incomplete_extraction', 'partial', False),
    (RuntimeError('upstream-private-detail'), 'collection_failed', 'failed', False),
])
async def test_worker_records_safe_failure_and_does_not_retry_blocked_source(monkeypatch, error, expected, outcome, disable_retry):
    async def scrape(*args):
        raise error
    monkeypatch.setattr(worker.OpenResultsScraper, 'scrape', scrape)
    query = MagicMock()
    connection = MagicMock()
    monkeypatch.setattr(worker, 'query', query)
    monkeypatch.setattr(worker, 'connection', connection)
    await worker.execute({'id': 'test-task', 'leaseToken': 'test-lease', 'kind': 'extract', 'payload': {'url': 'https://openresults.run/evento/test/'}})
    params = query.call_args.args[1]
    assert params[2] == outcome and params[4] == expected
    assert connection.called is disable_retry
    if disable_retry:
        assert '"maxAttempts"=attempt' in connection.return_value.__enter__.return_value.execute.call_args.args[0]
