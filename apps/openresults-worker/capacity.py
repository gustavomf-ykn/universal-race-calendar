"""Live PostgreSQL capacity checks; provider quotas require human confirmation."""

from app.services.source_requests import CapacityDeferred


def check_capacity(conn, growth_bytes=65536, resource='database', task=None):
    row = conn.execute('SELECT check_catalog_capacity(%s,%s,%s,%s) AS decision',
                       (resource, growth_bytes, task['id'] if task else None,
                        task['leaseToken'] if task else None)).fetchone()
    if not row or row['decision'] != 'allowed':
        raise CapacityDeferred(row['decision'] if row else 'capacity_measurement_unavailable', resource)


def database_capacity(query):
    row = query("SELECT check_catalog_capacity('database',65536) AS decision", (), True)
    if not row or row['decision'] != 'allowed':
        raise CapacityDeferred(row['decision'] if row else 'capacity_measurement_unavailable')


def storage_capacity(query):
    row = query("SELECT check_catalog_capacity('storage') AS decision", (), True)
    if not row or row['decision'] != 'allowed':
        raise CapacityDeferred(row['decision'] if row else 'capacity_measurement_unavailable', 'storage')
