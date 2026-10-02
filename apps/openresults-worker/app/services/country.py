"""Country evidence shared by catalog and edition parsing; never default to BR."""
import unicodedata

COUNTRY_LABELS = {
    'brasil': 'BR', 'brazil': 'BR', 'br': 'BR', 'portugal': 'PT', 'pt': 'PT', 'argentina': 'AR',
    'chile': 'CL', 'uruguai': 'UY', 'uruguay': 'UY', 'paraguai': 'PY', 'paraguay': 'PY',
    'bolivia': 'BO', 'peru': 'PE', 'colombia': 'CO', 'mexico': 'MX', 'estados unidos': 'US',
    'eua': 'US', 'usa': 'US', 'united states': 'US', 'espanha': 'ES', 'spain': 'ES',
}

def country_evidence(value) -> dict:
    if isinstance(value, dict):
        values = [value.get(field) for field in ('name', 'identifier') if value.get(field)]
        return combine_country_evidence(values)
    if not isinstance(value, str) or not value.strip():
        return {'country': '', 'status': 'missing', 'sourceTexts': []}
    text = ' '.join(value.split()).rstrip('.')
    key = ''.join(c for c in unicodedata.normalize('NFD', text.casefold()) if unicodedata.category(c) != 'Mn')
    country = COUNTRY_LABELS.get(key) or (text.upper() if text.upper() in COUNTRY_LABELS.values() else '')
    return {'country': country, 'status': 'confirmed' if country else 'unrecognized', 'sourceTexts': [text]}

def combine_country_evidence(values) -> dict:
    evidence = [country_evidence(value) for value in values]
    observed = [item for item in evidence if item['status'] != 'missing']
    countries = {item['country'] for item in observed if item['country']}
    status = ('conflicting' if len(countries) > 1 or any(item['status'] == 'conflicting' for item in observed) else
              'unrecognized' if any(item['status'] == 'unrecognized' for item in observed) else
              'confirmed' if len(countries) == 1 else 'missing')
    return {'country': next(iter(countries)) if status == 'confirmed' else '', 'status': status,
            'sourceTexts': [text for item in observed for text in item['sourceTexts']]}

def normalize_country(value) -> str:
    return country_evidence(value)['country']

def country_evidence_from_card(card) -> dict:
    if card is None:
        return country_evidence(None)
    values = [card.get('data-country')]
    for node in card.select('[data-country], [itemprop="addressCountry"]'):
        # An organizer address embedded in the card is not the race location.
        if node.get('itemprop') == 'organizer' or node.find_parent(attrs={'itemprop': 'organizer'}) is not None:
            continue
        values.append(node.get('data-country') or node.get('content') or node.get_text(' ', strip=True))
    explicit = combine_country_evidence(values)
    location = card.select_one('.or-event-card-meta, .event-location')
    if location is None:
        return explicit
    # The first metadata span holds city/UF. Athlete counts are separate spans.
    first_span = location.select_one('span')
    text = (first_span or location).get_text(' ', strip=True)
    components = text.split(',')
    suffixes = []
    for component in reversed(components[1:]):
        # Do not use the ISO-code path here: ES/PE can be Brazilian states.
        key = ''.join(c for c in unicodedata.normalize('NFD', component.strip().casefold().rstrip('.'))
                      if unicodedata.category(c) != 'Mn')
        if key not in COUNTRY_LABELS:
            break
        suffixes.append(component)
    return combine_country_evidence([*values, *suffixes])

def country_from_card(card) -> str:
    return country_evidence_from_card(card)['country']
