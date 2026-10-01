"""Country evidence shared by catalog and edition parsing; never default to BR."""
import re
import unicodedata


def normalize_country(value) -> str:
    if isinstance(value, dict):
        value = value.get('identifier') or value.get('name') or ''
    if not isinstance(value, str):
        return ''
    text = ' '.join(value.split())
    key = ''.join(c for c in unicodedata.normalize('NFD', text.casefold()) if unicodedata.category(c) != 'Mn')
    if key in ('br', 'brasil', 'brazil'):
        return 'BR'
    return text.upper() if re.fullmatch(r'[A-Za-z]{2}', text) else text


def country_from_card(card) -> str:
    if card is None:
        return ''
    node = card.select_one('[data-country], [itemprop="addressCountry"]')
    value = card.get('data-country')
    if not value and node:
        value = node.get('data-country') or node.get('content') or node.get_text(' ', strip=True)
    if value:
        return normalize_country(value)
    location = card.select_one('.or-event-card-meta, .event-location')
    text = location.get_text(' ', strip=True) if location else ''
    return 'BR' if re.search(r'\b(?:Brasil|Brazil|BR)\b', text, re.I) else ''
