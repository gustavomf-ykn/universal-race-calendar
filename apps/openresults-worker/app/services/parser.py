from __future__ import annotations

import re
import unicodedata
from datetime import date, datetime, timezone
from urllib.parse import parse_qs, urljoin, urlsplit

from bs4 import BeautifulSoup, Tag

from app.models import (
    EventDiscovery,
    EventMetadata,
    ModalityInfo,
    StructureChangedError,
)


MONTHS_PT = {
    "jan": 1,
    "fev": 2,
    "mar": 3,
    "abr": 4,
    "mai": 5,
    "jun": 6,
    "jul": 7,
    "ago": 8,
    "set": 9,
    "out": 10,
    "nov": 11,
    "dez": 12,
}


HEADER_FIELDS = {
    "geral": "overall_position",
    "posicao geral": "overall_position",
    "cat": "category_code",
    "categoria": "category_code",
    "numero": "bib",
    "nome": "name",
    "equipe": "team",
    "pace": "pace",
    "tempo": "time",
    "gap": "gap",
}


def clean_text(value: object) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value).replace("\xa0", " ")).strip()


def normalized_key(value: str) -> str:
    text = unicodedata.normalize("NFKD", clean_text(value))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = re.sub(r"[^a-zA-Z0-9]+", "_", text).strip("_").lower()
    return text or "campo_adicional"


def normalized_header(value: str) -> str:
    return normalized_key(value).replace("_", " ")


def normalize_gender(value: str) -> str:
    key = normalized_key(value)
    if key in {"f", "fem", "feminino", "feminina"}:
        return "Feminino"
    if key in {"m", "masc", "masculino", "masculina"}:
        return "Masculino"
    raise ValueError(f"Gênero não reconhecido: {value}")


def extract_distance_km(modality: str) -> float | None:
    match = re.search(r"(?<!\d)(\d+(?:[.,]\d+)?)\s*(?:km|k)(?![a-z])", modality, re.I)
    if not match:
        return None
    return float(match.group(1).replace(",", "."))


def _parse_int(value: str) -> int | None:
    match = re.search(r"\d+", clean_text(value).replace(".", ""))
    return int(match.group()) if match else None


def _parse_event_date(card: Tag | None) -> date | None:
    if card is None:
        return None
    date_box = card.select_one(".or-event-card-date")
    if date_box:
        day = _parse_int(clean_text(date_box.select_one(".day").get_text()) if date_box.select_one(".day") else "")
        month_text = normalized_key(
            clean_text(date_box.select_one(".month").get_text()) if date_box.select_one(".month") else ""
        )[:3]
        year = _parse_int(clean_text(date_box.select_one(".year").get_text()) if date_box.select_one(".year") else "")
        if day and year and month_text in MONTHS_PT:
            try:
                return date(year, MONTHS_PT[month_text], day)
            except ValueError:
                return None
    return None


def _extract_metadata(soup: BeautifulSoup, canonical_url: str) -> EventMetadata:
    card = soup.select_one("article.or-event-card")
    title_node = soup.select_one(".or-event-card-title")
    if title_node:
        name = clean_text(title_node.get_text(" ", strip=True))
    else:
        meta = soup.select_one('meta[property="og:description"], meta[name="description"]')
        name = clean_text(meta.get("content")) if meta else ""
    if not name:
        page_title = clean_text(soup.title.get_text()) if soup.title else ""
        name = re.sub(r"\s+-\s+(?:Resultado\s+-\s+)?Open Results.*$", "", page_title, flags=re.I)
    if not name:
        raise StructureChangedError("Não foi possível identificar o nome do evento.")

    city = ""
    state = ""
    meta_box = card.select_one(".or-event-card-meta") if card else None
    meta_text = clean_text(meta_box.get_text(" ", strip=True)) if meta_box else ""
    location_match = re.search(r"(.+?)\s*-\s*([A-Z]{2})(?:\s|$)", meta_text)
    if location_match:
        city = clean_text(location_match.group(1))
        state = location_match.group(2)
    total_match = re.search(r"([\d.]+)\s+concluintes", meta_text, re.I)
    expected_total = int(total_match.group(1).replace(".", "")) if total_match else None
    slug = urlsplit(canonical_url).path.rstrip("/").split("/")[-1]
    image_node = soup.select_one('meta[property="og:image"]')
    image_url = urljoin(canonical_url, clean_text(image_node.get("content"))) if image_node else ""
    related_links: dict[str, str] = {}
    for link in soup.select("a[href]"):
        href = clean_text(link.get("href"))
        text = normalized_key(link.get_text(" ", strip=True))
        if not href:
            continue
        absolute = urljoin(canonical_url, href)
        host = (urlsplit(absolute).hostname or "").lower()
        if host == "roadrunners.run" and (
            "sobre_evento" in text or urlsplit(absolute).path.startswith("/evento/")
        ):
            related_links["about_url"] = absolute
        elif any(token in text for token in ("site_oficial", "pagina_oficial")):
            related_links.setdefault("official_url", absolute)
        elif any(token in text for token in ("inscricao", "inscreva")):
            related_links.setdefault("registration_url", absolute)
    return EventMetadata(
        name=name,
        event_date=_parse_event_date(card),
        city=city,
        state=state,
        source_url=canonical_url,
        slug=slug,
        expected_total=expected_total,
        image_url=image_url,
        about_url=related_links.get("about_url", ""),
        official_result_url=canonical_url,
        registration_url=related_links.get("registration_url", ""),
        related_links=related_links,
        metadata_fetched_at=datetime.now(timezone.utc),
    )


def _extract_gender_totals(card: Tag) -> dict[str, int]:
    totals: dict[str, int] = {}
    for row in card.select("table tr"):
        cells = row.find_all("td", recursive=False)
        if not cells or not clean_text(cells[0].get_text()).lower().startswith("totais"):
            continue
        for link in row.select("a[href*='genero=']"):
            query = parse_qs(urlsplit(link.get("href", "")).query)
            gender = (query.get("genero") or [""])[0].upper()
            value_cell = link.find_parent("td")
            number_cell = value_cell.find_next_sibling("td") if value_cell else None
            number = _parse_int(number_cell.get_text(" ", strip=True) if number_cell else "")
            if gender in {"F", "M"} and number is not None:
                totals[gender] = number
        break
    return totals


def _extract_modalities(soup: BeautifulSoup) -> list[ModalityInfo]:
    heading = next(
        (
            node
            for node in soup.find_all(["h2", "h3", "h4"])
            if "resultados por modalidade" in clean_text(node.get_text()).lower()
        ),
        None,
    )
    container = heading.find_parent(class_="row") if heading else soup
    seen: set[str] = set()
    modalities: list[ModalityInfo] = []
    for link in container.select("a[href*='modalidade=']"):
        query = parse_qs(urlsplit(link.get("href", "")).query)
        value = (query.get("modalidade") or [""])[0]
        if not value or value in seen or query.get("genero"):
            continue
        seen.add(value)
        card = link.find_parent("div", class_=lambda classes: classes and "card" in classes)
        name_node = link.select_one(".kms") or link
        name = clean_text(name_node.get_text(" ", strip=True)) or value
        totals = _extract_gender_totals(card) if card else {}
        best: dict[str, str] = {}
        average: dict[str, str] = {}
        if card:
            for row in card.select("table tr"):
                cells = [clean_text(cell.get_text(" ", strip=True)) for cell in row.find_all(["th", "td"], recursive=False)]
                if not cells:
                    continue
                label = normalized_key(cells[0])
                for index, cell in enumerate(cells[1:], start=1):
                    gender = "F" if re.search(r"\bf(?:em(?:inino)?)?\b", cell, re.I) else "M" if re.search(r"\bm(?:asc(?:ulino)?)?\b", cell, re.I) else ""
                    value_cell = cells[index + 1] if gender and index + 1 < len(cells) else ""
                    if "melhor" in label and gender and value_cell:
                        best[gender] = value_cell
                    if "media" in label and gender and value_cell:
                        average[gender] = value_cell
        modalities.append(
            ModalityInfo(
                name=name,
                value=value,
                expected_by_gender=totals,
                best_time_by_gender=best,
                average_time_by_gender=average,
            )
        )
    if not modalities:
        raise StructureChangedError("Não foi possível descobrir as modalidades do evento.")
    return modalities


def parse_event_page(html: str, canonical_url: str) -> EventDiscovery:
    soup = BeautifulSoup(html, "lxml")
    metadata = _extract_metadata(soup, canonical_url)
    modalities = _extract_modalities(soup)
    result_table = soup.select_one("#tableResultados")
    endpoint_url: str | None = None
    headers: list[str] = []
    if result_table:
        remote = result_table.get("data-remote-url")
        endpoint_url = urljoin(canonical_url, remote) if remote else None
        headers = [clean_text(th.get_text(" ", strip=True)) for th in result_table.select("thead th")]
        if endpoint_url:
            event_id = (parse_qs(urlsplit(endpoint_url).query).get("id_evento") or [None])[0]
            metadata.event_id = clean_text(event_id) or None
    return EventDiscovery(
        metadata=metadata,
        modalities=modalities,
        endpoint_url=endpoint_url,
        result_headers=headers,
    )


def parse_event_metadata(html: str, canonical_url: str) -> tuple[EventMetadata, list[ModalityInfo]]:
    """Lê metadados mesmo quando a prova ainda não publicou resultados."""
    soup = BeautifulSoup(html, "lxml")
    metadata = _extract_metadata(soup, canonical_url)
    try:
        modalities = _extract_modalities(soup)
    except StructureChangedError:
        modalities = []
    endpoint = soup.select_one("[data-remote-url*='ajax_resultados_evento.cfm']")
    if endpoint:
        remote = clean_text(endpoint.get("data-remote-url"))
        event_id = (parse_qs(urlsplit(urljoin(canonical_url, remote)).query).get("id_evento") or [None])[0]
        metadata.event_id = clean_text(event_id) or None
    return metadata, modalities


def parse_result_rows(
    html_fragment: str,
    headers: list[str],
    metadata: EventMetadata,
    modality: ModalityInfo,
    gender: str,
    extracted_at: datetime,
) -> list[dict[str, object]]:
    if not headers:
        raise StructureChangedError("A tabela de resultados não possui cabeçalhos reconhecíveis.")
    soup = BeautifulSoup(f"<table><tbody>{html_fragment}</tbody></table>", "lxml")
    rows: list[dict[str, object]] = []
    for row_number, row in enumerate(soup.select("tbody tr"), start=1):
        cells = row.find_all("td", recursive=False)
        if not cells:
            continue
        if len(cells) != len(headers):
            raise StructureChangedError(
                f"Estrutura inesperada na linha {row_number}: {len(cells)} células para {len(headers)} cabeçalhos."
            )
        values: dict[str, object] = {}
        for header, cell in zip(headers, cells, strict=True):
            key = HEADER_FIELDS.get(normalized_header(header), normalized_key(header))
            values[key] = clean_text(cell.get_text(" ", strip=True))

        category_code = clean_text(values.pop("category_code", ""))
        overall_raw = clean_text(values.pop("overall_position", ""))
        record: dict[str, object] = {
            "event_id": metadata.event_id,
            "event": metadata.name,
            "event_date": metadata.event_date.isoformat() if metadata.event_date else None,
            "city": metadata.city,
            "state": metadata.state,
            "modality": modality.name,
            "modality_value": modality.value,
            "distance_km": extract_distance_km(modality.name),
            "gender": normalize_gender(gender),
            "overall_position": _parse_int(overall_raw),
            "category_position": None,
            "category": category_code,
            "category_code": category_code,
            "bib": clean_text(values.pop("bib", "")),
            "name": clean_text(values.pop("name", "")),
            "team": clean_text(values.pop("team", "")),
            "pace": clean_text(values.pop("pace", "")),
            "time": clean_text(values.pop("time", "")),
            "gap": clean_text(values.pop("gap", "")),
            "source_url": metadata.source_url,
            "extracted_at": extracted_at.isoformat(),
        }
        for key, value in values.items():
            if key not in record:
                record[key] = clean_text(value)
        rows.append(record)
    return rows


def deduplicate_records(records: list[dict[str, object]]) -> tuple[list[dict[str, object]], int]:
    unique: list[dict[str, object]] = []
    seen: set[tuple[object, ...]] = set()
    duplicates = 0
    for record in records:
        common = (
            record.get("modality_value") or record.get("modality"),
            record.get("gender"),
            clean_text(record.get("name")).casefold(),
            record.get("time") or "",
        )
        bib = clean_text(record.get("bib"))
        key = common[:2] + (("bib", bib),) + common[2:] if bib else common + (record.get("overall_position"),)
        if key in seen:
            duplicates += 1
            continue
        seen.add(key)
        unique.append(record)
    return unique, duplicates


def sort_records(records: list[dict[str, object]]) -> list[dict[str, object]]:
    def key(record: dict[str, object]) -> tuple[object, ...]:
        distance = record.get("distance_km")
        return (
            distance is None,
            float(distance) if distance is not None else float("inf"),
            str(record.get("modality") or "").casefold(),
            0 if record.get("gender") == "Feminino" else 1,
            record.get("overall_position") is None,
            int(record.get("overall_position") or 0),
        )

    return sorted(records, key=key)
