"""Idle-worker liveness is independent of CollectionTask leases."""
import os
from pathlib import Path
from psycopg.types.json import Jsonb
from local_resources import inspect_resources


def stop_requested():
    path = os.environ.get('WORKER_STOP_FILE')
    return bool(path and Path(path).exists())


def announce(query, worker_id, state, task_id=None):
    resources = inspect_resources()
    if state == 'available' and resources['reason']:
        state = 'resource_wait'
    query('''INSERT INTO "WorkerPresence" (id,runtime,capabilities,state,"activeTaskId",version,resources)
      VALUES (%s,'python',ARRAY['openresults','exports'],%s,%s,%s,%s)
      ON CONFLICT (id) DO UPDATE SET state=EXCLUDED.state,"activeTaskId"=EXCLUDED."activeTaskId",resources=EXCLUDED.resources,"lastSeenAt"=now()
      WHERE "WorkerPresence".state<>'stopped' RETURNING id''', (worker_id,state,task_id,os.environ.get('WORKER_CODE_VERSION',os.environ.get('GIT_SHA','unknown')),Jsonb(resources)))
