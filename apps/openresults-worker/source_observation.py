"""Whitelisted edition evidence, never arbitrary upstream metadata or athlete records."""
import unicodedata
from app.services.country import normalize_country

def edition_observation(metadata):
    kind = ''.join(c for c in unicodedata.normalize('NFD',metadata.event_type.lower()) if unicodedata.category(c)!='Mn').strip()
    modality = {'corrida de rua':'road','road':'road','trail run':'trail','trail':'trail','corrida de montanha':'trail'}.get(kind)
    evidence = metadata.raw_metadata.get('country_evidence') or {}
    country = None if evidence.get('status') in ('conflicting', 'unrecognized') else normalize_country(metadata.country) or None
    return {'name':metadata.name or None, 'date':metadata.event_date.isoformat() if metadata.event_date else None,
            'city':metadata.city or None,'state':metadata.state or None,'country':country,
            'modality':modality,'registrationUrl':metadata.registration_url or None,
            'officialUrl':metadata.about_url or metadata.source_url or None}
