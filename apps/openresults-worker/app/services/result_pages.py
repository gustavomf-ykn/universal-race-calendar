"""Strict native-result pagination. Missing end evidence is not an empty success."""
from dataclasses import dataclass
import hashlib
import json
import re

from app.models import StructureChangedError
from app.services.openresults_client import payload_value
from app.services.parser import parse_result_rows


def whole_number(value):
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise StructureChangedError('result_pagination_invalid')
    text = str(value).strip()
    if not re.fullmatch(r'[0-9]+', text) or int(text) > 2147483647:
        raise StructureChangedError('result_pagination_invalid')
    return int(text)


def boolean(value):
    if value is True or value == 'true' or value == 'TRUE':
        return True
    if value is False or value == 'false' or value == 'FALSE':
        return False
    raise StructureChangedError('result_pagination_invalid')


def record_key(record):
    # Keep the key used by the already published PostgreSQL result sets.
    return hashlib.sha256(json.dumps({k: record.get(k) for k in
        ['modality', 'gender', 'bib', 'name', 'category', 'overall_position']}, sort_keys=True).encode()).hexdigest()


def page_hash(records):
    stable = [{k: v for k, v in record.items() if k != 'extracted_at'} for record in records]
    return hashlib.sha256(json.dumps(stable, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()


@dataclass
class ResultPage:
    records: list
    expected: int | None
    next_offset: int
    has_more: bool
    digest: str


def parse_result_page(payload, discovery, modality, gender, offset, extracted_at):
    if not isinstance(payload, dict):
        raise StructureChangedError('result_pagination_invalid')
    if payload_value(payload, 'ok') is not None and not boolean(payload_value(payload, 'ok')):
        raise StructureChangedError('result_endpoint_failed')
    html = payload_value(payload, 'html')
    if not isinstance(html, str):
        raise StructureChangedError('result_rows_missing')
    totals = [whole_number(value) for value in
              (payload_value(payload, 'recordsTotal'), payload_value(payload, 'recordsFiltered')) if value is not None]
    if len(set(totals)) > 1:
        raise StructureChangedError('result_totals_diverge')
    expected = totals[0] if totals else None
    records = parse_result_rows(html, discovery.result_headers, discovery.metadata, modality, gender, extracted_at)
    next_raw = payload_value(payload, 'nextOffset')
    next_offset = whole_number(next_raw) if next_raw is not None else offset + len(records)
    if next_offset != offset + len(records):
        raise StructureChangedError('result_pagination_gap')
    more_raw = payload_value(payload, 'hasMore')
    if more_raw is None:
        if expected is None:
            raise StructureChangedError('result_end_unconfirmed')
        has_more = next_offset < expected
    else:
        has_more = boolean(more_raw)
    if has_more and (not records or next_offset <= offset):
        raise StructureChangedError('result_pagination_not_advancing')
    if expected is not None and (next_offset > expected or has_more != (next_offset < expected)):
        raise StructureChangedError('result_totals_diverge')
    return ResultPage(records, expected, next_offset, has_more, page_hash(records))
