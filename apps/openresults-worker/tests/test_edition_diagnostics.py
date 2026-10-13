import os
import uuid
from datetime import date
from urllib.parse import urlsplit

import pytest
from psycopg.types.json import Jsonb

import worker
from app.models import EventMetadata
from edition_metadata import current_field_diagnostics, update_edition


@pytest.mark.parametrize('country,modality,expected', [
    ('BR', 'road', []),
    ('Brasil', 'trail', []),
    (None, 'road', ['country_unconfirmed']),
    ('País não confirmado', 'road', ['country_unconfirmed']),
    ('BR', 'unknown', ['modality_unconfirmed']),
    (None, 'unknown', ['country_unconfirmed', 'modality_unconfirmed']),
    ('PT', 'road', ['non_brazil_event']),
])
def test_requirements_follow_persisted_fields_and_preserve_review_and_conflicts(country, modality, expected):
    event = {'country': country, 'modality': modality,
             'warnings': ['source_conflict', 'country_unconfirmed', 'modality_unconfirmed'],
             'publishabilityReasons': ['metadata_validation_required', 'administrative_review_required',
                                      'country_unconfirmed', 'non_brazil_event', 'modality_unconfirmed']}
    warnings, reasons = current_field_diagnostics(event)
    assert reasons == ['metadata_validation_required', 'administrative_review_required', *expected]
    assert warnings == ['source_conflict', *(reason for reason in expected if reason != 'non_brazil_event')]
    assert event['warnings'] == ['source_conflict', 'country_unconfirmed', 'modality_unconfirmed']


@pytest.mark.skipif(not os.environ.get('DATABASE_URL'), reason='isolated PostgreSQL required')
def test_conflicting_or_stale_inspection_cannot_clear_requirements(monkeypatch):
    uri = os.environ['DATABASE_URL'].split('?')[0]
    parsed = urlsplit(uri)
    assert parsed.hostname in ('127.0.0.1', 'localhost', 'postgres') and parsed.path.endswith('_test')
    monkeypatch.setenv('WORKER_DATABASE_URL', uri)
    ident = 'diagnostics-' + str(uuid.uuid4())
    url = f'https://openresults.run/evento/{ident}/'
    reasons = ['metadata_validation_required', 'country_unconfirmed']
    task = {'id': ident, 'leaseToken': ident, 'payload': {'eventId': ident}}
    with worker.connection() as conn:
        conn.execute('''INSERT INTO "Source" (id,name,url,type,adapter,"externalId","updatedAt")
            VALUES (%s,'Prova',%s,'official_page','openresults',%s,now())''', (ident, url, ident))
        conn.execute('''INSERT INTO "Event" (id,slug,name,date,city,state,country,modality,
            "sourceId","sourceType","sourceExternalId","canonicalFingerprint",warnings,
            "publishabilityReasons","publicationStatus","updatedAt")
            VALUES (%s,%s,'Prova','2040-10-10','Cidade','SC','BR','unknown',%s,'openresults',%s,%s,
                %s,%s,'pending_review',now())''',
                     (ident, ident, ident, ident, ident, Jsonb(['country_unconfirmed']), Jsonb(reasons)))
        conn.execute('''INSERT INTO "EventSourceReference" (id,"eventId","sourceId","sourceType",
            "sourceExternalId",url,"updatedAt") VALUES (%s,%s,%s,'openresults',%s,%s,now())''',
                     (ident, ident, ident, ident, url))
        conn.execute('''INSERT INTO "CollectionTask" (id,source,kind,"ownerId","idempotencyKey",
            "requestHash",payload,status,"leaseToken","leaseUntil")
            VALUES (%s,'openresults','inspect',%s,%s,'test',%s,'running',%s,now()+interval '5 minutes')''',
                     (ident, ident, ident, Jsonb(task['payload']), ident))
    try:
        metadata = EventMetadata('Prova', date(2041, 10, 10), 'Cidade', 'SC', url, ident,
                                 country='BR', event_type='Corrida de rua', event_id=ident)
        with pytest.raises(ValueError, match='edition_date_mismatch'):
            update_edition(task, metadata, worker.connection, worker.fenced)
        with worker.connection() as conn:
            assert conn.execute('SELECT "publishabilityReasons" FROM "Event" WHERE id=%s',
                                (ident,)).fetchone()['publishabilityReasons'] == reasons
            conn.execute('UPDATE "CollectionTask" SET "leaseToken"=\'replacement\' WHERE id=%s', (ident,))
        metadata.event_date = date(2040, 10, 10)
        with pytest.raises(RuntimeError, match='lease_lost'):
            update_edition(task, metadata, worker.connection, worker.fenced)
        with worker.connection() as conn:
            assert conn.execute('SELECT "publishabilityReasons" FROM "Event" WHERE id=%s',
                                (ident,)).fetchone()['publishabilityReasons'] == reasons
        task['leaseToken'] = 'replacement'
        update_edition(task, metadata, worker.connection, worker.fenced)
        with worker.connection() as conn:
            refreshed = conn.execute('SELECT warnings,"publishabilityReasons","publicationStatus" FROM "Event" WHERE id=%s',
                                     (ident,)).fetchone()
            assert refreshed == {'warnings': [], 'publishabilityReasons': ['metadata_validation_required'],
                                 'publicationStatus': 'pending_review'}
    finally:
        with worker.connection() as conn:
            conn.execute('DELETE FROM "Event" WHERE id=%s', (ident,))
            conn.execute('DELETE FROM "Source" WHERE id=%s', (ident,))
            conn.execute('DELETE FROM "CollectionTask" WHERE id=%s', (ident,))
