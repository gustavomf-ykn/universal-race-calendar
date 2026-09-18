from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any


class ScraperError(Exception):
    """Base error that is safe to translate into a user-facing message."""


class URLValidationError(ScraperError):
    pass


class EventNotFoundError(ScraperError):
    pass


class NoResultsError(ScraperError):
    pass


class StructureChangedError(ScraperError):
    pass


class AccessBlockedError(ScraperError):
    pass


class RequestTimeoutError(ScraperError):
    pass


class RequestFailedError(ScraperError):
    pass


class ExportError(ScraperError):
    pass


class JobCapacityError(ScraperError):
    pass


class ScopeValidationError(ScraperError):
    pass


class EventIdentifierUnavailableError(ScraperError):
    pass


@dataclass(slots=True)
class EventMetadata:
    name: str
    event_date: date | None
    city: str
    state: str
    source_url: str
    slug: str
    expected_total: int | None = None
    event_id: str | None = None
    end_date: date | None = None
    country: str = "BR"
    address: str = ""
    location_name: str = ""
    latitude: float | None = None
    longitude: float | None = None
    description: str = ""
    event_type: str = ""
    source_event_status: str = ""
    derived_event_status: str = ""
    image_url: str = ""
    about_url: str = ""
    official_result_url: str = ""
    registration_url: str = ""
    external_ids: dict[str, str] = field(default_factory=dict)
    related_links: dict[str, str] = field(default_factory=dict)
    raw_metadata: dict[str, Any] = field(default_factory=dict)
    metadata_fetched_at: datetime | None = None


@dataclass(slots=True)
class ModalityInfo:
    name: str
    value: str
    expected_by_gender: dict[str, int] = field(default_factory=dict)
    best_time_by_gender: dict[str, str] = field(default_factory=dict)
    average_time_by_gender: dict[str, str] = field(default_factory=dict)
    raw_metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def expected_total(self) -> int | None:
        return sum(self.expected_by_gender.values()) if self.expected_by_gender else None


@dataclass(slots=True)
class EventDiscovery:
    metadata: EventMetadata
    modalities: list[ModalityInfo]
    endpoint_url: str | None
    result_headers: list[str]


@dataclass(slots=True)
class ExtractionResult:
    metadata: EventMetadata
    modalities: list[ModalityInfo]
    records: list[dict[str, Any]]
    expected_total: int | None
    extracted_total: int
    by_gender: dict[str, int]
    by_group: dict[str, int]
    warnings: list[str] = field(default_factory=list)
    extracted_at: datetime | None = None


@dataclass(slots=True)
class EventSummary:
    name: str
    event_date: date | None
    city: str
    state: str
    event_url: str
    event_slug: str
    event_id: str | None = None
    end_date: date | None = None
    country: str = "BR"
    expected_total: int | None = None
    modalities: list[dict[str, Any]] = field(default_factory=list)
    raw_metadata: dict[str, Any] = field(default_factory=dict)
    catalog_id: int | None = None
    id_status: str = "pending"
    metadata_status: str = "pending"
    discovered_at: datetime | None = None
    updated_at: datetime | None = None
    metadata_fetched_at: datetime | None = None


@dataclass(slots=True)
class CatalogDiscoveryResult:
    events: list[EventSummary]
    date_from: date
    date_to: date | None
    pages_loaded: int
    advertised_total: int | None
    warnings: list[str] = field(default_factory=list)


EXPORT_COLUMNS: list[tuple[str, str]] = [
    ("event_id", "event_id"),
    ("event", "Evento"),
    ("event_date", "Data do evento"),
    ("city", "Cidade"),
    ("state", "UF"),
    ("modality", "Modalidade"),
    ("distance_km", "Distância em km"),
    ("gender", "Gênero"),
    ("overall_position", "Posição geral"),
    ("category_position", "Posição na categoria"),
    ("category", "Categoria"),
    ("bib", "Número"),
    ("name", "Nome"),
    ("team", "Equipe"),
    ("pace", "Pace"),
    ("time", "Tempo"),
    ("gap", "Gap"),
    ("source_url", "URL de origem"),
    ("extracted_at", "Data e hora da extração"),
]
