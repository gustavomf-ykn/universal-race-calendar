import pytest
from batch import BatchRun, options


def test_continuous_default():
    assert options({}) == (False, 3, 600)


@pytest.mark.parametrize('value', ['0', '-1', 'NaN', 'Infinity', '3601'])
def test_invalid_budget(value):
    with pytest.raises(ValueError, match='invalid_worker_limits'):
        options({'WORKER_MAX_SECONDS': value})


def test_batch_limits(monkeypatch):
    monkeypatch.setenv('WORKER_MODE', 'batch')
    monkeypatch.setenv('WORKER_MAX_TASKS', '2')
    run = BatchRun()
    run.claimed = 1
    assert run.can_claim()
    run.claimed = 2
    assert not run.can_claim() and run.reason == 'task_limit'
    run.claimed = 0
    run.started -= 601
    assert not run.can_claim() and run.reason == 'duration_limit'
