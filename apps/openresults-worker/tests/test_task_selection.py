import json
import pytest
import worker


def test_selection_fails_closed(tmp_path, monkeypatch):
    selected = tmp_path / 'tasks.json'
    monkeypatch.setenv('WORKER_TASK_SELECTION_FILE', str(selected))
    monkeypatch.setattr(worker, 'query', lambda *args: pytest.fail('must not query database'))
    for content in (None, '{', 'null', '{}', '[1]', '[""]'):
        if content is not None:
            selected.write_text(content, encoding='utf-8')
        with pytest.raises(ValueError, match='task_selection_invalid'):
            worker.claim_next_task()


def test_selection_is_reloaded_and_empty_is_not_unrestricted(tmp_path, monkeypatch):
    selected = tmp_path / 'tasks.json'
    monkeypatch.setenv('WORKER_TASK_SELECTION_FILE', str(selected))
    calls = []
    monkeypatch.setattr(worker, 'query', lambda *args: calls.append(args))
    for ids in ([], ['chosen-task']):
        selected.write_text(json.dumps(ids), encoding='utf-8')
        worker.claim_next_task()
        assert 'claim_selected_task' in calls[-1][0]
        assert calls[-1][1][2] == ids
