"""Bounded runner accounting; reports never contain payloads, URLs or credentials."""
import json
import os
import threading
import time
from pathlib import Path


def options(env=None):
    env = os.environ if env is None else env
    mode = env.get('WORKER_MODE', 'continuous')
    if mode not in ['batch', 'continuous']:
        raise ValueError('invalid_worker_mode')
    def limit(name, default, maximum):
        value = env.get(name, str(default))
        if not value.isascii() or not value.isdigit() or not 1 <= int(value) <= maximum:
            raise ValueError('invalid_worker_limits')
        return int(value)
    return mode == 'batch', limit('WORKER_MAX_TASKS', 3, 100), limit('WORKER_MAX_SECONDS', 600, 3600)


class BatchRun:
    def __init__(self):
        self.batch, self.max_tasks, self.max_seconds = options()
        self.started = time.monotonic()
        self.claimed = 0
        self.active_task_id = None
        self.tasks = []
        self.reason = 'stopped'

    def can_claim(self):
        if not self.batch:
            return True
        if self.claimed >= self.max_tasks:
            self.reason = 'task_limit'
            return False
        if time.monotonic() - self.started >= self.max_seconds:
            self.reason = 'duration_limit'
            return False
        return True

    def report(self, reason=None):
        result = dict(worker='python', mode='batch' if self.batch else 'continuous',
                      reason=reason or self.reason, claimed=self.claimed,
                      activeTaskId=self.active_task_id, tasks=list(self.tasks),
                      elapsedSeconds=round(time.monotonic() - self.started),
                      recoveryPending=self.active_task_id is not None)
        path = os.environ.get('WORKER_REPORT_PATH')
        if path:
            Path(path).write_text(json.dumps(result), encoding='utf-8')
        print(json.dumps(result), flush=True)

    def watchdog(self):
        if not self.batch:
            return None
        def expire():
            # asyncio cancellation cannot stop a live psycopg/publisher thread.
            # Exit the process without releasing the lease; recovery stays fenced.
            try: self.report('duration_limit')
            finally: os._exit(75 if self.active_task_id else 0)
        timer = threading.Timer(self.max_seconds, expire)
        timer.daemon = True
        timer.start()
        return timer
