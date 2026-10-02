from datetime import date

import pytest

from app.config import Settings
from app.models import EventSummary, StructureChangedError
from app.services.openresults.catalog import EventCatalog, parse_catalog_payload
from app.services.openresults.catalog_ledger import checkpoint, record_page
from app.services.country import normalize_country
from app.services.openresults.metadata import apply_related_metadata
from app.models import EventMetadata


OPTIONS = {'states': ['SC'], 'batchSize': 5}


def event(n, **kwargs):
    return EventSummary(f'Corrida {n}', date(2026, 1, 1), 'Cidade', 'SC',
                        f'https://openresults.run/evento/prova-{n}/', f'prova-{n}', **kwargs)


@pytest.mark.parametrize('value,expected', [('false', False), ('true', True), ('0', False),
                                         ('1', True), (False, False), (1, True), (None, None)])
def test_strict_native_pagination_flag(value, expected):
    _, total, more = parse_catalog_payload({'html': '', 'totalEventos': '0', 'hasMore': value})
    assert total == 0 and more is expected


@pytest.mark.parametrize('payload', [{}, {'html': []}, {'html': '', 'totalEventos': 1.5},
                                   {'html': '', 'totalEventos': True},
                                   {'html': '', 'hasMore': 'maybe'}, {'html': '', 'hasMore': []}])
def test_malformed_catalog_is_not_an_empty_success(payload):
    with pytest.raises(StructureChangedError):
        parse_catalog_payload(payload)


def test_missing_event_name_is_not_silently_lost_from_coverage():
    with pytest.raises(StructureChangedError):
        parse_catalog_payload({'html': '<a href="/evento/sem-nome/"></a>', 'hasMore': False})


def test_country_needs_explicit_evidence_even_with_brazilian_uf():
    html = '<article data-country="{country}"><h2>Corrida</h2><div class="or-event-card-meta">Cidade - SC</div><a href="/evento/prova/">Ver</a></article>'
    for country, expected in [('', ''), ('Brasil', 'BR'), ('PT', 'PT')]:
        events, _, _ = parse_catalog_payload({'html': html.format(country=country)})
        assert events[0].country == expected
    metadata = EventMetadata('Corrida', None, 'Cidade', 'SC', 'https://openresults.run/evento/prova/', 'prova')
    assert not metadata.country
    apply_related_metadata(metadata, {'location': {'address': {'addressCountry': {'name': 'Brazil'}}}})
    assert not metadata.country  # An undated related page does not identify the edition.
    metadata.event_date = date(2026, 1, 1)
    apply_related_metadata(metadata, {'startDate': '2026-01-01', 'location': {'address': {
        'addressLocality': 'Cidade', 'addressRegion': 'SC', 'addressCountry': {'name': 'Brazil'}}}})
    assert metadata.country == 'BR'
    assert normalize_country(None) == ''


def test_source_total_precedes_filters_and_duplicates_do_not_inflate_discovery():
    opts = {**OPTIONS, 'from': '2026-01-01'}
    a, b, foreign, unknown = event(1, country='BR'), event(2), event(3, country='PT'), event(4)
    ledger = record_page(checkpoint([], 1, 0), 1, [a, b], 4, True, opts, 1000)
    assert not ledger['terminal']
    ledger['rows'] = []
    ledger['currentPage'] = None
    ledger = record_page(ledger, 2, [b, foreign, unknown], 4, False, opts, 1000)
    receipt = ledger['receipts'][0]
    assert receipt == {'state': 'BR', 'status': 'completed', 'reason': 'native_end_confirmed',
                       'requested': 2, 'rawCount': 5, 'unique': 4, 'advertisedTotal': 4,
                       'duplicates': 1, 'outOfScope': 1, 'unknownCountry': 2, 'scope': 'source_catalog'}
    assert [r['name'] for r in ledger['rows']] == ['Corrida 4']


def test_nonconsecutive_cycle_survives_checkpoint_and_is_limited():
    ledger = record_page(checkpoint([], 1, 0), 1, [event(1)], None, True, OPTIONS, 1000)
    ledger['rows'] = []
    ledger['currentPage'] = None
    ledger = record_page(checkpoint(ledger, 2, 0), 2, [event(2)], None, True, OPTIONS, 1000)
    ledger['rows'] = []
    ledger['currentPage'] = None
    ledger = record_page(checkpoint(ledger, 3, 0), 3, [event(1)], None, True, OPTIONS, 1000)
    assert ledger['receipts'][0]['status'] == 'limited'
    assert ledger['reason'] == 'catalog_pagination_not_advancing'
    assert not ledger['rows'] and len(ledger['seenURLs']) == 2


def test_unrecognized_location_is_preserved_for_review_not_silently_discarded():
    candidate = event(1)
    candidate.state = 'ZZ'
    ledger = record_page(checkpoint([], 1, 0), 1, [candidate], 1, False, OPTIONS, 1000)
    assert len(ledger['rows']) == 1 and ledger['rows'][0]['country'] is None
    assert ledger['outOfScope'] == 0 and ledger['unknownCountry'] == 1


@pytest.mark.parametrize('events,total,more,max_pages,reason', [
    ([event(1)], 2, False, 1000, 'catalog_total_mismatch'),
    ([], None, None, 1000, 'catalog_end_unconfirmed'),
    ([], None, True, 1000, 'catalog_empty_page_with_more'),
    ([event(1)], 10, True, 1, 'catalog_page_limit'),
    ([event(1)], 1, True, 1000, 'catalog_pagination_conflict'),
])
def test_end_evidence_cannot_claim_full_coverage(events, total, more, max_pages, reason):
    ledger = record_page(checkpoint([], 1, 0), 1, events, total, more, OPTIONS, max_pages)
    assert ledger['terminal'] and ledger['reason'] == reason
    assert ledger['receipts'][0]['status'] == 'limited'


def test_changing_denominator_does_not_prove_a_consistent_catalog():
    ledger = record_page(checkpoint([], 1, 0), 1, [event(1)], 2, True, OPTIONS, 1000)
    ledger = record_page(ledger, 2, [event(2), event(3)], 3, False, OPTIONS, 1000)
    assert ledger['reason'] == 'catalog_total_changed'
    assert ledger['receipts'][0]['status'] == 'limited'


def test_missing_last_page_total_still_reconciles_previous_advertised_total():
    ledger = record_page(checkpoint([], 1, 0), 1, [event(1)], 3, True, OPTIONS, 1000)
    ledger = record_page(ledger, 2, [event(2)], None, False, OPTIONS, 1000)
    assert ledger['reason'] == 'catalog_total_mismatch'


def test_legacy_checkpoint_is_not_reinterpreted_as_confirmed_country_evidence():
    row = {'name': 'Corrida', 'url': 'https://openresults.run/evento/legacy/', '_pageHash': 'old'}
    for snapshot, page, cursor in [([row], 3, 1), ({'openresultsVersion': 1}, 1, 0), ({'openresultsVersion': 2}, 1, 0)]:
        with pytest.raises(ValueError, match='catalog_checkpoint_incompatible'):
            checkpoint(snapshot, page, cursor)
    assert row == {'name': 'Corrida', 'url': 'https://openresults.run/evento/legacy/', '_pageHash': 'old'}
    assert checkpoint([], 1, 0)['openresultsVersion'] == 2


def test_invalid_checkpoint_cannot_fetch_next_page_and_skip_unprocessed_candidates():
    ledger = record_page(checkpoint([], 1, 0), 1, [event(1), event(2)], 10, True, OPTIONS, 1000)
    ledger['currentPage'] = None
    with pytest.raises(ValueError, match='catalog_checkpoint_incompatible'):
        checkpoint(ledger, 1, 1)
    ledger['currentPage'] = 1
    ledger['rawCount'] = -1
    with pytest.raises(ValueError, match='catalog_checkpoint_incompatible'):
        checkpoint(ledger, 1, 0)


@pytest.mark.asyncio
async def test_date_filter_does_not_end_before_a_later_recent_page(monkeypatch):
    old = event(1)
    old.event_date = date(2020, 1, 1)
    recent = event(2)
    calls = []
    async def get_page(self, page):
        calls.append(page)
        return ([old], 2, True) if page == 1 else ([recent], 2, False)
    monkeypatch.setattr('app.services.openresults.catalog.OpenResultsClient.get_catalog_page', get_page)
    monkeypatch.setattr('app.services.openresults.catalog.parse_catalog_payload', lambda payload: payload)
    result = await EventCatalog(Settings(catalog_max_pages=5)).discover(date_from=date(2025, 1, 1))
    assert calls == [1, 2] and result.events == [recent] and not result.warnings
