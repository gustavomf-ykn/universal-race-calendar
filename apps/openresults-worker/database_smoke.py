"""Read-only runner connectivity check with allowlisted diagnostics only."""
import os
import psycopg
from psycopg.conninfo import conninfo_to_dict


def check_database(uri, connect=psycopg.connect):
    try:
        conninfo_to_dict(uri)
    except Exception:
        return 'invalid_libpq_uri'
    try:
        with connect(uri, connect_timeout=10, options='-c default_transaction_read_only=on -c statement_timeout=10000') as conn:
            conn.execute('SELECT id FROM "CollectionTask" LIMIT 0')
        return None
    except Exception as error:
        # Classify in memory; never print provider text, host, username or password.
        state = getattr(error, 'sqlstate', '') or ''
        detail = str(error).lower()
        if state.startswith('28') or 'password authentication failed' in detail:
            return 'authentication_failed'
        if state in ('42P01', '42501'):
            return 'schema_or_privilege'
        if 'certificate' in detail or 'ssl' in detail:
            return 'tls_failed'
        if any(word in detail for word in ('resolve', 'name or service', 'network is unreachable', 'connection refused', 'timeout', 'timed out')):
            return 'network_or_timeout'
        return 'connection_failed'


if __name__ == '__main__':
    failure = check_database(os.environ.get('WORKER_DATABASE_URL', ''))
    if failure:
        print(f'worker_database_check_failed: {failure}; configuration=STAGING_WORKER_DATABASE_URL', flush=True)
        raise SystemExit(1)
    print('worker_database_read_access_passed', flush=True)
