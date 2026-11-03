"""Retry transient database I/O only while idle; never replay active task writes."""
import asyncio
import re

import psycopg
from worker_health import write_health


def transient_connection_error(error):
    state = getattr(error, 'sqlstate', None)
    return isinstance(error, psycopg.OperationalError) and (
        state is None or state.startswith('08') or state in ('57P01', '57P02', '57P03', '53300'))


def diagnostic(error, phase, attempt=0):
    # Exception messages can contain DSNs, hosts, usernames and passwords.
    state = getattr(error, 'sqlstate', None)
    state = state if isinstance(state, str) and re.fullmatch('[A-Z0-9]{5}', state) else 'none'
    kind = type(error).__name__
    kind = kind if re.fullmatch('[A-Za-z]{1,60}', kind) else 'unknown'
    phase = phase if re.fullmatch('[a-z_]{1,40}', phase) else 'unknown'
    print(f'Results: database I/O; phase={phase}; type={kind}; sqlstate={state}; retry={attempt}.', flush=True)


async def idle_database_call(operation, phase, can_retry, should_stop, *, sleep=asyncio.sleep):
    failures = 0
    while not should_stop():
        try:
            result = await asyncio.to_thread(operation)
            if failures:
                print('Results: database connection recovered while idle.', flush=True)
            return result
        except psycopg.Error as error:
            if not transient_connection_error(error) or not can_retry():
                diagnostic(error, phase)
                raise
            failures += 1
            write_health('connection_wait')
            if failures == 1 or failures % 4 == 0:
                diagnostic(error, phase, failures)
            await sleep(min(15, 2 ** min(failures - 1, 4)))
    return None
