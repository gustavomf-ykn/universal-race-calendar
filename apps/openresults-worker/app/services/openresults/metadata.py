from __future__ import annotations

import ipaddress
import json
from datetime import date, datetime, timezone
from typing import Any
from urllib.parse import parse_qs, urljoin, urlsplit, urlunsplit

import httpx
from bs4 import BeautifulSoup

from app.config import Settings
from app.models import EventMetadata, ModalityInfo, RequestFailedError, URLValidationError
from app.services.safe_network import bounded_get
from app.services.openresults_client import OpenResultsClient
from app.services.parser import clean_text, parse_event_metadata
from app.services.url_validation import validate_event_url


FORBIDDEN_RAW_KEYS = {
    "performer",
    "competitor",
    "participant",
    "attendee",
    "athlete",
    "athletes",
    "recordist",
    "recordists",
    "mapboxtoken",
}


def _safe_related_url(url: str, allowed_host: str = "roadrunners.run") -> str:
    parsed = urlsplit(url.strip())
    hostname = (parsed.hostname or "").lower().rstrip(".")
    if parsed.scheme.lower() != "https" or hostname != allowed_host or parsed.username or parsed.password:
        raise URLValidationError("O link relacionado não pertence ao domínio permitido.")
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        raise URLValidationError("Endereços IP não são permitidos.")
    if parsed.port not in (None, 443) or ".." in parsed.path.split("/"):
        raise URLValidationError("O link relacionado possui porta ou caminho inválido.")
    return urlunsplit(("https", allowed_host, parsed.path or "/", parsed.query, ""))


def _sanitize_raw(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): _sanitize_raw(item)
            for key, item in value.items()
            if str(key).casefold() not in FORBIDDEN_RAW_KEYS
        }
    if isinstance(value, list):
        return [_sanitize_raw(item) for item in value]
    return value


def _sports_event(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        kind = value.get("@type")
        kinds = kind if isinstance(kind, list) else [kind]
        if any(str(item).casefold() == "sportsevent" for item in kinds):
            return value
        graph = value.get("@graph")
        found = _sports_event(graph)
        if found:
            return found
    if isinstance(value, list):
        for item in value:
            found = _sports_event(item)
            if found:
                return found
    return None


def _date_value(value: object) -> date | None:
    text = clean_text(value)
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
    except ValueError:
        try:
            return date.fromisoformat(text[:10])
        except ValueError:
            return None


def parse_related_metadata(html: str, source_url: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "lxml")
    event: dict[str, Any] | None = None
    for node in soup.select('script[type="application/ld+json"]'):
        try:
            payload = json.loads(node.string or node.get_text())
        except (TypeError, ValueError):
            continue
        event = _sports_event(payload)
        if event:
            break
    if not event:
        return {"source_url": source_url}
    safe = _sanitize_raw(event)
    safe["source_url"] = source_url
    return safe


def _first_url(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return next((str(item) for item in value if isinstance(item, str)), "")
    if isinstance(value, dict):
        return clean_text(value.get("url"))
    return ""


def apply_related_metadata(metadata: EventMetadata, raw: dict[str, Any]) -> None:
    metadata.end_date = _date_value(raw.get("endDate")) or metadata.end_date
    metadata.description = clean_text(raw.get("description")) or metadata.description
    metadata.event_type = clean_text(raw.get("@type")) or metadata.event_type
    metadata.source_event_status = clean_text(raw.get("eventStatus"))
    metadata.image_url = _first_url(raw.get("image")) or metadata.image_url
    location = raw.get("location") if isinstance(raw.get("location"), dict) else {}
    address = location.get("address") if isinstance(location.get("address"), dict) else {}
    metadata.location_name = clean_text(location.get("name"))
    metadata.address = clean_text(address.get("streetAddress"))
    metadata.city = clean_text(address.get("addressLocality")) or metadata.city
    metadata.state = clean_text(address.get("addressRegion")) or metadata.state
    metadata.country = clean_text(address.get("addressCountry")) or metadata.country
    geo = location.get("geo") if isinstance(location.get("geo"), dict) else {}
    try:
        metadata.latitude = float(geo.get("latitude")) if geo.get("latitude") is not None else None
        metadata.longitude = float(geo.get("longitude")) if geo.get("longitude") is not None else None
    except (TypeError, ValueError):
        metadata.latitude = metadata.longitude = None
    offers = raw.get("offers")
    metadata.registration_url = _first_url(offers) or metadata.registration_url
    if metadata.registration_url:
        query = parse_qs(urlsplit(metadata.registration_url).query)
        ticket_id = (query.get("__idEvento") or query.get("idEvento") or [""])[0]
        if ticket_id:
            metadata.external_ids["ticketsports"] = clean_text(ticket_id)
    identifier = raw.get("identifier")
    if isinstance(identifier, (str, int)):
        metadata.external_ids["roadrunners"] = str(identifier)
    metadata.raw_metadata["roadrunners"] = raw


class EventMetadataService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def fetch(
        self,
        event_url: str,
        *,
        enrich_roadrunners: bool = False,
    ) -> tuple[EventMetadata, list[ModalityInfo]]:
        canonical = validate_event_url(event_url, self.settings.allowed_host)
        async with OpenResultsClient(self.settings) as client:
            html = await client.get_event_page(canonical)
        metadata, modalities = parse_event_metadata(html, canonical)
        metadata.raw_metadata["openresults"] = {
            "event_id": metadata.event_id,
            "expected_total": metadata.expected_total,
            "modalities": [
                {
                    "name": item.name,
                    "value": item.value,
                    "expected_by_gender": item.expected_by_gender,
                    "best_time_by_gender": item.best_time_by_gender,
                    "average_time_by_gender": item.average_time_by_gender,
                }
                for item in modalities
            ],
        }
        if enrich_roadrunners and metadata.about_url:
            related = await self._get_related_page(metadata.about_url)
            raw = parse_related_metadata(related, metadata.about_url)
            apply_related_metadata(metadata, raw)
        today = datetime.now(timezone.utc).date()
        end = metadata.end_date or metadata.event_date
        metadata.derived_event_status = "completed" if end and end < today else "scheduled"
        metadata.metadata_fetched_at = datetime.now(timezone.utc)
        return metadata, modalities

    async def _get_related_page(self, url: str) -> str:
        current = _safe_related_url(url)
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(self.settings.request_timeout),
            follow_redirects=False,
            trust_env=False,
            headers={"User-Agent": self.settings.user_agent, "Accept": "text/html"},
        ) as client:
            for _ in range(self.settings.max_redirects + 1):
                try:
                    response = await bounded_get(client, current, {}, self.settings.request_timeout)
                except httpx.HTTPError as exc:
                    raise RequestFailedError("Não foi possível consultar o site relacionado.") from exc
                if response.status_code in {301, 302, 303, 307, 308}:
                    location = response.headers.get("location", "")
                    current = _safe_related_url(urljoin(current, location))
                    continue
                if response.status_code >= 400:
                    raise RequestFailedError(f"O site relacionado retornou HTTP {response.status_code}.")
                return response.text
        raise RequestFailedError("O site relacionado excedeu o limite de redirecionamentos.")
