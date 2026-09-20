from __future__ import annotations

import re
from datetime import date, datetime, timezone
from inspect import isawaitable
from typing import Any, Callable
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup, Tag

from app.config import Settings
from app.models import CatalogDiscoveryResult, EventSummary, StructureChangedError
from app.services.openresults_client import OpenResultsClient, payload_value
from app.services.parser import MONTHS_PT, clean_text, normalized_key
from app.services.url_validation import validate_event_url


CatalogProgress = Callable[[str, int, dict[str, int]], Any]


def _number(value: object) -> int | None:
    match = re.search(r"\d+", clean_text(value).replace(".", ""))
    return int(match.group()) if match else None


def _event_date(card: Tag) -> date | None:
    date_node = card.select_one(".or-event-card-date, .event-date, [class*='date']")
    text = clean_text(date_node.get_text(" ", strip=True) if date_node else card.get_text(" ", strip=True))
    numeric = re.search(r"\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b", text)
    if numeric:
        try:
            return date(int(numeric.group(3)), int(numeric.group(2)), int(numeric.group(1)))
        except ValueError:
            return None
    textual = re.search(
        r"\b(\d{1,2})\s+(?:de\s+)?(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-zç]*\s+(?:de\s+)?(20\d{2})\b",
        normalized_key(text).replace("_", " "),
        re.I,
    )
    if textual:
        try:
            return date(int(textual.group(3)), MONTHS_PT[textual.group(2).lower()], int(textual.group(1)))
        except ValueError:
            return None
    day = _number(card.select_one(".day").get_text() if card.select_one(".day") else "")
    month = normalized_key(card.select_one(".month").get_text() if card.select_one(".month") else "")[:3]
    year = _number(card.select_one(".year").get_text() if card.select_one(".year") else "")
    if day and year and month in MONTHS_PT:
        try:
            return date(year, MONTHS_PT[month], day)
        except ValueError:
            return None
    return None


def parse_catalog_html(html: str, base_url: str = "https://openresults.run/") -> list[EventSummary]:
    soup = BeautifulSoup(html, "lxml")
    links = soup.select("a[href*='/evento/']")
    events: list[EventSummary] = []
    seen: set[str] = set()
    for link in links:
        href = clean_text(link.get("href"))
        try:
            event_url = validate_event_url(urljoin(base_url, href))
        except Exception:
            continue
        if event_url in seen:
            continue
        card = link.find_parent(["article", "li"]) or link.find_parent(
            "div", class_=lambda value: value and any(token in str(value).lower() for token in ("card", "evento", "event"))
        )
        card = card or link
        title = card.select_one(".or-event-card-title, .event-title, h2, h3, h4") if isinstance(card, Tag) else None
        name = clean_text(title.get_text(" ", strip=True) if title else link.get_text(" ", strip=True))
        if not name:
            continue
        text = clean_text(card.get_text(" ", strip=True))
        location_node = card.select_one(".or-event-card-meta span")
        location_text = clean_text(location_node.get_text(" ", strip=True)) if location_node else text
        location = re.search(r"(.+?)\s*-\s*([A-Z]{2})(?:\b|$)", location_text)
        city = clean_text(location.group(1)) if location else ""
        if city:
            city = re.sub(r"^.*?(?:20\d{2}|jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\s+", "", city, flags=re.I)
        state = location.group(2) if location else ""
        total_match = re.search(r"([\d.]+)\s+(?:concluintes|resultados|atletas)", text, re.I)
        modalities: list[dict[str, Any]] = []
        for node in card.select(".or-event-distance"):
            modality_text = clean_text(node.get_text(" ", strip=True))
            match = re.match(r"(.+?)(?:\s*\|\s*([\d.]+))?$", modality_text)
            if match:
                modalities.append(
                    {
                        "name": clean_text(match.group(1)),
                        "expected_total": int(match.group(2).replace(".", "")) if match.group(2) else None,
                    }
                )
        slug = urlsplit(event_url).path.rstrip("/").split("/")[-1]
        seen.add(event_url)
        events.append(
            EventSummary(
                name=name,
                event_date=_event_date(card),
                city=city,
                state=state,
                event_url=event_url,
                event_slug=slug,
                expected_total=int(total_match.group(1).replace(".", "")) if total_match else None,
                modalities=modalities,
                raw_metadata={"catalog_text": text},
                discovered_at=datetime.now(timezone.utc),
            )
        )
    return events


def parse_catalog_payload(payload: dict[str, Any] | str) -> tuple[list[EventSummary], int | None, bool | None]:
    if isinstance(payload, str):
        total_match = re.search(r"totalEventos\s*=\s*(\d+)", payload)
        return parse_catalog_html(payload), int(total_match.group(1)) if total_match else None, None
    html = payload_value(payload, "html", "") or payload_value(payload, "eventos", "") or ""
    total = payload_value(payload, "totalEventos")
    if total is None:
        total = payload_value(payload, "recordsTotal")
    total_value = int(float(total)) if total is not None else None
    has_more = payload_value(payload, "hasMore")
    return parse_catalog_html(str(html)), total_value, bool(has_more) if has_more is not None else None


class EventCatalog:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def _emit(self, callback: CatalogProgress | None, stage: str, progress: int, counters: dict[str, int]) -> None:
        if callback is None:
            return
        outcome = callback(stage, progress, counters)
        if isawaitable(outcome):
            await outcome

    async def discover(
        self,
        *,
        date_from: date,
        date_to: date | None = None,
        progress: CatalogProgress | None = None,
    ) -> CatalogDiscoveryResult:
        events: list[EventSummary] = []
        warnings: list[str] = []
        advertised_total: int | None = None
        previous_oldest: date | None = None
        pages_loaded = 0
        async with OpenResultsClient(self.settings) as client:
            for page in range(1, self.settings.catalog_max_pages + 1):
                payload = await client.get_catalog_page(page)
                page_events, total, has_more = parse_catalog_payload(payload)
                pages_loaded = page
                advertised_total = total if total is not None else advertised_total
                dated = [item.event_date for item in page_events if item.event_date]
                newest = max(dated) if dated else None
                oldest = min(dated) if dated else None
                if previous_oldest and newest and newest > previous_oldest:
                    warnings.append("A ordenação do catálogo mudou durante a coleta; a busca continuou até o limite seguro.")
                monotonic = not (previous_oldest and newest and newest > previous_oldest)
                if oldest:
                    previous_oldest = oldest
                events.extend(
                    item
                    for item in page_events
                    if (item.event_date is None or item.event_date >= date_from)
                    and (date_to is None or item.event_date is None or item.event_date <= date_to)
                )
                await self._emit(
                    progress,
                    f"Lendo página {page} do catálogo",
                    min(75, 2 + page),
                    {"pages_loaded": page, "events_found": len(events)},
                )
                if not page_events or has_more is False:
                    break
                if monotonic and oldest and oldest < date_from and all(
                    item.event_date is not None and item.event_date < date_from for item in page_events
                ):
                    break
            else:
                warnings.append("O catálogo atingiu o limite máximo de páginas configurado.")
        unique = {item.event_url: item for item in events}
        ordered = sorted(unique.values(), key=lambda item: (item.event_date or date.max, item.name.casefold()))
        return CatalogDiscoveryResult(
            events=ordered,
            date_from=date_from,
            date_to=date_to,
            pages_loaded=pages_loaded,
            advertised_total=advertised_total,
            warnings=warnings,
        )
