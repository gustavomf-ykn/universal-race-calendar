from unittest.mock import MagicMock
import psycopg
import pytest
from database_smoke import check_database


def test_prisma_option_is_rejected_without_connecting():
    connect = MagicMock()
    assert check_database('postgresql://test:private@localhost/postgres?connection_limit=3', connect) == 'invalid_libpq_uri'
    connect.assert_not_called()


def test_success_uses_read_only_query():
    connect = MagicMock()
    assert check_database('postgresql://test:private@localhost/postgres', connect) is None
    assert 'default_transaction_read_only=on' in connect.call_args.kwargs['options']
    connect.return_value.__enter__.return_value.execute.assert_called_once_with('SELECT id FROM "CollectionTask" LIMIT 0')


@pytest.mark.parametrize('error,expected', [
    (psycopg.errors.InvalidPassword('sensitive-provider-value'), 'authentication_failed'),
    (psycopg.errors.UndefinedTable('sensitive-provider-value'), 'schema_or_privilege'),
    (psycopg.OperationalError('certificate verify failed: sensitive-provider-value'), 'tls_failed'),
    (psycopg.OperationalError('Network is unreachable: sensitive-provider-value'), 'network_or_timeout'),
    (RuntimeError('sensitive-provider-value'), 'connection_failed'),
])
def test_errors_only_return_allowlisted_category(error, expected, capsys):
    assert check_database('postgresql://test:private@localhost/postgres', MagicMock(side_effect=error)) == expected
    assert capsys.readouterr().out == ''
