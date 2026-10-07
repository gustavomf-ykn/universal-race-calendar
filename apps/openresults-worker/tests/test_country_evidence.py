from copy import deepcopy
from datetime import date

import pytest
from bs4 import BeautifulSoup

from app.models import EventMetadata
from app.services.country import country_evidence, country_evidence_from_card, country_from_card, normalize_country
from app.services.openresults.metadata import apply_related_metadata
from source_observation import edition_observation


@pytest.mark.parametrize('value,expected', [
    ('Brasil', 'BR'), ('Brazil', 'BR'), ('BR', 'BR'), ('Portugal', 'PT'), ('ES', 'ES'),
    ({'name': 'Brasil', 'identifier': 'BR'}, 'BR'),
    ({'name': 'Portugal', 'identifier': 'BR'}, ''),
    ({'name': 'País desconhecido', 'identifier': 'BR'}, ''),
    ('ZZ', ''), ('Rua Brasil', ''), (None, ''),
])
def test_explicit_country_has_no_brazil_default_and_requires_consistent_recognized_values(value, expected):
    assert normalize_country(value) == expected


@pytest.mark.parametrize('location,expected', [
    ('Rua Brasil - SC', ''), ('Vitória - ES', ''), ('Vitória - ES, Brasil', 'BR'),
    ('Vitória - ES, Brasil, Portugal', ''), ('Porto, Portugal', 'PT'),
])
def test_free_location_needs_a_country_suffix_and_does_not_reinterpret_uf(location, expected):
    card = BeautifulSoup(f'<article><div class="or-event-card-meta"><span>{location}</span><span>10 concluintes</span></div></article>', 'lxml').article
    assert country_from_card(card) == expected


def test_card_country_conflict_is_visible_and_organizer_address_is_not_race_location():
    card = BeautifulSoup('''<article data-country="BR"><div class="or-event-card-meta">Cidade - SC, Portugal</div>
        <div itemprop="organizer"><meta itemprop="addressCountry" content="BR"></div></article>''', 'lxml').article
    assert country_evidence_from_card(card)['status'] == 'conflicting'
    card = BeautifulSoup('''<article><div class="or-event-card-meta">Cidade - SC</div>
        <div itemprop="organizer"><meta itemprop="addressCountry" content="BR"></div></article>''', 'lxml').article
    assert country_evidence_from_card(card) == {'country': '', 'status': 'missing', 'sourceTexts': []}


def test_related_page_cannot_overwrite_another_edition_or_classify_terrain_from_schema_type():
    metadata = EventMetadata('Corrida', date(2026, 10, 18), 'Vitória', 'ES',
        'https://openresults.run/evento/prova/', 'prova', country='BR', event_type='Trail')
    raw = {'@type': 'SportsEvent', 'startDate': '2027-10-18', 'description': 'Outra edição',
        'location': {'address': {'addressLocality': 'Outra cidade', 'addressRegion': 'SP', 'addressCountry': 'Portugal'}}}
    apply_related_metadata(metadata, raw)
    assert (metadata.country, metadata.city, metadata.state, metadata.description, metadata.event_type) == ('BR', 'Vitória', 'ES', '', 'Trail')
    assert metadata.raw_metadata['related_edition_status'] == 'unconfirmed'
    compatible = {**raw, 'startDate': '2026-10-18T07:00:00-03:00', 'location': {'address': {
        'addressLocality': 'Vitoria', 'addressRegion': 'ES', 'addressCountry': 'Brasil'}}}
    apply_related_metadata(metadata, compatible)
    assert metadata.country == 'BR' and metadata.event_type == 'Trail'
    assert edition_observation(metadata)['modality'] == 'trail'


def test_country_contradiction_does_not_erase_a_valid_value_or_confirm_it_as_new_observation():
    metadata = EventMetadata('Corrida', date(2026, 10, 18), 'Cidade', 'SC',
        'https://openresults.run/evento/prova/', 'prova', country='BR')
    raw = {'startDate': '2026-10-18', 'location': {'address': {'addressLocality': 'Cidade', 'addressRegion': 'SC',
        'addressCountry': 'Portugal'}}}
    apply_related_metadata(metadata, raw)
    assert metadata.country == 'BR'
    assert metadata.raw_metadata['country_evidence']['status'] == 'conflicting'
    assert edition_observation(metadata)['country'] is None
    # The original source object is retained without mutation.
    assert raw['location']['address']['addressCountry'] == 'Portugal'
    metadata.country = 'Brasil'
    metadata.raw_metadata = {}
    assert edition_observation(metadata)['country'] == 'BR'
    original = {'name': 'Portugal', 'identifier': 'BR'}
    copied = deepcopy(original)
    assert country_evidence(original)['status'] == 'conflicting'
    assert original == copied
