from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except ValueError:
        return default


def _env_csv(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    raw = os.getenv(name)
    if raw is None:
        return default
    values = tuple(value.strip().rstrip("/") for value in raw.split(",") if value.strip())
    return values or default


@dataclass(frozen=True, slots=True)
class Settings:
    app_name: str = "Extrator de Resultados Open Results"
    allowed_host: str = "openresults.run"
    request_timeout: float = 20.0
    request_attempts: int = 3
    max_redirects: int = 3
    scrape_concurrency: int = 3
    endpoint_page_size: int = 100
    max_endpoint_pages: int = 10_000
    events_min_date: str = "2025-01-01"
    catalog_concurrency: int = 3
    metadata_concurrency: int = 3
    metadata_cache_ttl_seconds: int = 604_800
    catalog_max_pages: int = 1_000
    results_rows_per_workbook: int = 1_048_575
    job_ttl_seconds: int = 3_600
    cleanup_interval_seconds: int = 60
    max_parallel_jobs: int = 2
    max_queued_jobs: int = 20
    max_retained_jobs: int = 100
    rate_limit_requests: int = 5
    rate_limit_window_seconds: int = 600
    allowed_origins: tuple[str, ...] = (
        "https://gustavomf-ykn.github.io",
        "http://127.0.0.1:8000",
        "http://localhost:8000",
    )
    user_agent: str = "scraper-openresults/1.0 (local result export tool)"
    trust_proxy_headers: bool = False
    temp_dir: Path = Path(tempfile.gettempdir()) / "scraper-openresults"
    database_path: Path = Path(tempfile.gettempdir()) / "scraper-openresults" / "scraper-openresults.sqlite3"
    debug: bool = False

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            request_timeout=_env_float("OPENRESULTS_TIMEOUT", 20.0),
            request_attempts=_env_int("OPENRESULTS_RETRIES", 3),
            max_redirects=_env_int("OPENRESULTS_MAX_REDIRECTS", 3),
            scrape_concurrency=max(1, _env_int("OPENRESULTS_CONCURRENCY", 3)),
            endpoint_page_size=max(1, _env_int("OPENRESULTS_PAGE_SIZE", 100)),
            events_min_date=os.getenv("EVENTS_MIN_DATE", "2025-01-01"),
            catalog_concurrency=max(1, _env_int("OPENRESULTS_CATALOG_CONCURRENCY", 3)),
            metadata_concurrency=max(1, _env_int("OPENRESULTS_METADATA_CONCURRENCY", 3)),
            metadata_cache_ttl_seconds=max(60, _env_int("OPENRESULTS_METADATA_TTL", 604_800)),
            catalog_max_pages=max(1, _env_int("OPENRESULTS_CATALOG_MAX_PAGES", 1_000)),
            results_rows_per_workbook=min(
                1_048_575,
                max(1, _env_int("OPENRESULTS_RESULTS_ROWS_PER_WORKBOOK", 1_048_575)),
            ),
            job_ttl_seconds=max(60, _env_int("OPENRESULTS_JOB_TTL", 3_600)),
            cleanup_interval_seconds=max(10, _env_int("OPENRESULTS_CLEANUP_INTERVAL", 60)),
            max_parallel_jobs=max(1, _env_int("OPENRESULTS_MAX_JOBS", 2)),
            max_queued_jobs=max(1, _env_int("OPENRESULTS_MAX_QUEUED_JOBS", 20)),
            max_retained_jobs=max(1, _env_int("OPENRESULTS_MAX_RETAINED_JOBS", 100)),
            rate_limit_requests=max(1, _env_int("OPENRESULTS_RATE_LIMIT_REQUESTS", 5)),
            rate_limit_window_seconds=max(1, _env_int("OPENRESULTS_RATE_LIMIT_WINDOW", 600)),
            allowed_origins=_env_csv(
                "OPENRESULTS_ALLOWED_ORIGINS",
                (
                    "https://gustavomf-ykn.github.io",
                    "http://127.0.0.1:8000",
                    "http://localhost:8000",
                ),
            ),
            user_agent=os.getenv(
                "OPENRESULTS_USER_AGENT",
                "scraper-openresults/1.0 (local result export tool)",
            ),
            trust_proxy_headers=os.getenv("OPENRESULTS_TRUST_PROXY_HEADERS", "0").lower()
            in {"1", "true", "yes"},
            temp_dir=Path(
                os.getenv(
                    "OPENRESULTS_TEMP_DIR",
                    str(Path(tempfile.gettempdir()) / "scraper-openresults"),
                )
            ),
            database_path=Path(
                os.getenv(
                    "OPENRESULTS_DATABASE_PATH",
                    str(Path(tempfile.gettempdir()) / "scraper-openresults" / "scraper-openresults.sqlite3"),
                )
            ),
            debug=os.getenv("OPENRESULTS_DEBUG", "0").lower() in {"1", "true", "yes"},
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings.from_env()
