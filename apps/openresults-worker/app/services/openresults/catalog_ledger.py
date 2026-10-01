"""Durable source-wide discovery evidence, independent of date/UF filters.

Only normalized source identities and page receipts are retained. No athlete rows,
cookies or arbitrary upstream payloads are part of this checkpoint.
"""
from __future__ import annotations

import hashlib
import json
from copy import deepcopy

BRAZIL_STATES = set('AC AL AM AP BA CE DF ES GO MA MG MS MT PA PB PE PI PR RJ RN RO RR RS SC SE SP TO'.split())


def checkpoint(snapshot, page: int, cursor: int) -> dict:
    if isinstance(snapshot, dict) and snapshot.get('openresultsVersion') == 1:
        required = ('rows', 'seenURLs', 'pageHashes', 'pageReceipts', 'totals', 'receipts')
        if any(not isinstance(snapshot.get(key), list) for key in required):
            raise ValueError('catalog_checkpoint_incompatible')
        if snapshot.get('currentPage') not in (None, page):
            raise ValueError('catalog_checkpoint_incompatible')
        if cursor < 0 or cursor > len(snapshot['rows']):
            raise ValueError('catalog_checkpoint_incompatible')
        return deepcopy(snapshot)
    # Preserve an old partial page; its historical denominator cannot be rebuilt
    # from a processed count. It may finish processing but cannot prove coverage.
    initial = snapshot == [] and page == 1 and cursor == 0
    if not isinstance(snapshot, list) and not (
        isinstance(snapshot, dict) and set(snapshot) <= {'previous'}
    ):
        raise ValueError('catalog_checkpoint_incompatible')
    rows = snapshot if isinstance(snapshot, list) else []
    if cursor < 0 or cursor > len(rows):
        raise ValueError('catalog_checkpoint_incompatible')
    previous = snapshot.get('previous') if isinstance(snapshot, dict) else None
    current_hash = rows[0].get('_pageHash') if rows else previous
    return {
        'openresultsVersion': 1, 'rows': deepcopy(rows),
        'currentPage': page if rows else None,
        'seenURLs': sorted({r['url'].rstrip('/') for r in rows}),
        'pageHashes': [current_hash] if current_hash else [],
        'pageReceipts': [], 'totals': [], 'receipts': [],
        'rawCount': len(rows), 'duplicates': 0, 'outOfScope': 0,
        'unknownCountry': sum(not r.get('country') for r in rows),
        'legacyEvidenceMissing': not initial,
        'terminal': False, 'reason': 'native_pages',
    }


def record_page(ledger: dict, page: int, events, total, more, options, max_pages: int) -> dict:
    result = deepcopy(ledger)
    urls = [e.event_url.rstrip('/') for e in events]
    identities = set(urls)
    digest = hashlib.sha256(json.dumps(sorted(identities)).encode()).hexdigest()
    seen = set(result['seenURLs'])
    fresh = identities - seen
    repeated = bool(identities and (digest in result['pageHashes'] or not fresh))
    result['currentPage'] = page
    result['rawCount'] += len(urls)
    result['duplicates'] += len(urls) - len(fresh)
    result['seenURLs'] = sorted(seen | identities)
    result['pageHashes'].append(digest)
    if total is not None and total not in result['totals']:
        result['totals'].append(total)
    result['rows'] = []
    consumed = set()
    for event in events:
        identity = event.event_url.rstrip('/')
        if identity not in fresh or identity in consumed:
            continue
        consumed.add(identity)
        day = event.event_date.isoformat() if event.event_date else None
        country = event.country or None
        if ((country and country != 'BR') or
            (day and ((options.get('from') and day < options['from']) or
                      (options.get('to') and day > options['to']))) or
            (event.state in BRAZIL_STATES and event.state not in options['states'])):
            result['outOfScope'] += 1
            continue
        if not country:
            result['unknownCountry'] += 1
        result['rows'].append({
            'name': event.name, 'date': day, 'city': event.city, 'state': event.state,
            'country': country, 'url': event.event_url,
            'externalId': str(event.event_id) if event.event_id else
                'url:' + hashlib.sha256(event.event_url.encode()).hexdigest(),
        })
    unique = len(result['seenURLs'])
    advertised = result['totals'][-1] if result['totals'] else None
    stable_total = len(result['totals']) == 1 and advertised == unique
    terminal = repeated or more is False or not events or stable_total or page >= max_pages
    reason = 'native_pages'
    if terminal:
        if repeated:
            reason = 'catalog_pagination_not_advancing'
        elif result['legacyEvidenceMissing']:
            reason = 'catalog_legacy_evidence_missing'
        elif len(result['totals']) > 1:
            reason = 'catalog_total_changed'
        elif stable_total and more is True:
            reason = 'catalog_pagination_conflict'
        elif page >= max_pages and more is not False and events and not stable_total:
            reason = 'catalog_page_limit'
        elif advertised is not None and advertised != unique:
            reason = 'catalog_total_mismatch'
        elif not events and more is True:
            reason = 'catalog_empty_page_with_more'
        elif more is False:
            reason = 'native_end_confirmed'
        elif stable_total:
            reason = 'advertised_total_reconciled'
        elif page >= max_pages:
            reason = 'catalog_page_limit'
        else:
            reason = 'catalog_end_unconfirmed'
    result['terminal'] = terminal
    result['reason'] = reason
    result['pageReceipts'].append({
        'page': page, 'hash': digest, 'rawCount': len(urls), 'unique': len(identities),
        'newUnique': len(fresh), 'total': total, 'hasMore': more,
    })
    if terminal:
        result['receipts'] = [receipt(result)]
    return result


def receipt(ledger: dict) -> dict:
    complete = ledger['reason'] in ('native_end_confirmed', 'advertised_total_reconciled')
    return {
        'state': 'BR', 'status': 'completed' if complete else 'limited',
        'reason': ledger['reason'], 'requested': len(ledger['pageReceipts']),
        'rawCount': ledger['rawCount'], 'unique': len(ledger['seenURLs']),
        'advertisedTotal': ledger['totals'][-1] if ledger['totals'] else None,
        'duplicates': ledger['duplicates'], 'outOfScope': ledger['outOfScope'],
        'unknownCountry': ledger['unknownCountry'],
        'scope': 'source_catalog',
    }
