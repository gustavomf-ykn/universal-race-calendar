import json
import psycopg
import pytest

from idle_database import idle_database_call, transient_connection_error
from worker_health import healthy


@pytest.mark.asyncio
async def test_idle_connection_recovers_with_bounded_delays_without_logging_dsn(monkeypatch, tmp_path, capsys):
    health = tmp_path / 'health.json'
    monkeypatch.setenv('WORKER_HEALTH_FILE', str(health))
    calls, delays = [], []
    def operation():
        calls.append(True)
        if len(calls) <= 6:
            raise psycopg.OperationalError('postgresql://user:private-password@private-host/db')
        return {'id': 'one-confirmed-task'}
    async def sleep(delay):
        delays.append(delay)
        assert not healthy(health)
        assert json.loads(health.read_text())['state'] == 'connection_wait'
    result = await idle_database_call(operation, 'claim', lambda: True, lambda: False, sleep=sleep)
    assert result == {'id': 'one-confirmed-task'}
    assert delays == [1, 2, 4, 8, 15, 15]
    output = capsys.readouterr().out
    assert 'OperationalError' in output and 'phase=claim' in output
    assert all(secret not in output for secret in ('postgresql://', 'private-password', 'private-host'))


@pytest.mark.asyncio
@pytest.mark.parametrize('can_retry', [False, True])
async def test_permissions_and_credentials_fail_closed(can_retry, capsys):
    def operation():
        raise psycopg.errors.InvalidPassword('privileged-secret-must-stay-hidden')
    with pytest.raises(psycopg.errors.InvalidPassword):
        await idle_database_call(operation, 'startup_presence', lambda: can_retry, lambda: False)
    assert 'privileged-secret' not in capsys.readouterr().out


@pytest.mark.asyncio
async def test_batch_or_active_task_never_replays_ambiguous_io():
    calls = []
    def operation():
        calls.append(True)
        raise psycopg.OperationalError('unconfirmed active write')
    with pytest.raises(psycopg.OperationalError):
        await idle_database_call(operation, 'active_task', lambda: False, lambda: False)
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_stop_during_reconnect_does_not_claim_again():
    stopped, calls = False, []
    def operation():
        calls.append(True)
        raise psycopg.OperationalError()
    async def sleep(_):
        nonlocal stopped
        stopped = True
    assert await idle_database_call(operation, 'claim', lambda: True, lambda: stopped, sleep=sleep) is None
    assert len(calls) == 1


def test_non_connection_errors_are_not_retried():
    assert not transient_connection_error(psycopg.errors.InsufficientPrivilege())
    assert not transient_connection_error(ValueError('configuration'))


@pytest.mark.asyncio
@pytest.mark.parametrize('reason', ['FATAL: Tenant or user not found', 'password authentication failed', 'certificate verify failed'])
async def test_pooler_permanent_errors_without_sqlstate_are_not_retried(reason, capsys):
    calls = []
    def operation():
        calls.append(True)
        raise psycopg.OperationalError(reason + ' private-connection-details')
    with pytest.raises(psycopg.OperationalError):
        await idle_database_call(operation, 'claim', lambda: True, lambda: False)
    assert len(calls) == 1
    assert 'private-connection-details' not in capsys.readouterr().out
