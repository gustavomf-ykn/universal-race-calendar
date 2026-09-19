from __future__ import annotations

import asyncio
import json
from dataclasses import asdict
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

import aiosqlite

from app.models import EventMetadata, EventSummary, ModalityInfo


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _json_default(value: object) -> str:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    raise TypeError(f"Tipo não serializável: {type(value)!r}")


def json_dumps(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=_json_default)


def json_loads(value: str | None, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


SCHEMA = """
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS catalog_events (
    catalog_id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE,
    event_slug TEXT NOT NULL,
    event_url TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    start_date TEXT,
    end_date TEXT,
    city TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT 'BR',
    expected_total INTEGER,
    modalities_json TEXT NOT NULL DEFAULT '[]',
    raw_catalog_json TEXT NOT NULL DEFAULT '{}',
    id_status TEXT NOT NULL DEFAULT 'pending',
    metadata_status TEXT NOT NULL DEFAULT 'pending',
    discovered_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata_fetched_at TEXT
);

CREATE INDEX IF NOT EXISTS ix_catalog_events_date ON catalog_events(start_date);
CREATE INDEX IF NOT EXISTS ix_catalog_events_name ON catalog_events(name);
CREATE INDEX IF NOT EXISTS ix_catalog_events_state ON catalog_events(state);

CREATE TABLE IF NOT EXISTS event_metadata (
    catalog_id INTEGER PRIMARY KEY REFERENCES catalog_events(catalog_id) ON DELETE CASCADE,
    normalized_json TEXT NOT NULL,
    raw_metadata_json TEXT NOT NULL DEFAULT '{}',
    related_metadata_included INTEGER NOT NULL DEFAULT 0,
    fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    scope_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    stage TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0,
    counters_json TEXT NOT NULL DEFAULT '{}',
    current_event TEXT,
    current_modality TEXT,
    current_gender TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT,
    error TEXT,
    warnings_json TEXT NOT NULL DEFAULT '[]',
    download_path TEXT,
    filename TEXT
);

CREATE INDEX IF NOT EXISTS ix_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS ix_jobs_updated ON jobs(updated_at);

CREATE TABLE IF NOT EXISTS job_events (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    catalog_id INTEGER NOT NULL REFERENCES catalog_events(catalog_id) ON DELETE CASCADE,
    event_id TEXT,
    event_name TEXT NOT NULL,
    event_url TEXT NOT NULL,
    event_date TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    groups_total INTEGER NOT NULL DEFAULT 0,
    groups_completed INTEGER NOT NULL DEFAULT 0,
    athletes_extracted INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    started_at TEXT,
    completed_at TEXT,
    PRIMARY KEY (job_id, catalog_id)
);

CREATE INDEX IF NOT EXISTS ix_job_events_status ON job_events(job_id, status);

CREATE TABLE IF NOT EXISTS job_groups (
    job_id TEXT NOT NULL,
    catalog_id INTEGER NOT NULL,
    modality_value TEXT NOT NULL,
    modality_name TEXT NOT NULL,
    gender TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    next_offset INTEGER NOT NULL DEFAULT 0,
    expected_total INTEGER,
    extracted_total INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    PRIMARY KEY (job_id, catalog_id, modality_value, gender),
    FOREIGN KEY (job_id, catalog_id) REFERENCES job_events(job_id, catalog_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS athlete_results (
    row_id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL REFERENCES catalog_events(event_id),
    event TEXT,
    event_date TEXT,
    city TEXT,
    state TEXT,
    modality TEXT,
    modality_value TEXT,
    distance_km REAL,
    gender TEXT,
    overall_position INTEGER,
    category_position INTEGER,
    category TEXT,
    bib TEXT,
    name TEXT,
    team TEXT,
    pace TEXT,
    time TEXT,
    gap TEXT,
    source_url TEXT,
    extracted_at TEXT,
    data_json TEXT NOT NULL,
    UNIQUE(job_id, event_id, modality_value, gender, bib, name, time)
);

CREATE INDEX IF NOT EXISTS ix_results_job ON athlete_results(job_id);
CREATE INDEX IF NOT EXISTS ix_results_event ON athlete_results(job_id, event_id);
CREATE INDEX IF NOT EXISTS ix_results_filters ON athlete_results(job_id, gender, modality, category);
"""


class SQLiteStorage:
    """Persistência local modular; um adapter futuro pode implementar a mesma API."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.connection: aiosqlite.Connection | None = None
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = await aiosqlite.connect(self.path)
        self.connection.row_factory = aiosqlite.Row
        await self.connection.executescript(SCHEMA)
        await self._ensure_result_columns()
        now = utcnow().isoformat()
        await self.connection.execute(
            "UPDATE jobs SET status='interrupted', stage='Interrompido; pronto para retomar', updated_at=? "
            "WHERE status='running'",
            (now,),
        )
        await self.connection.execute(
            "UPDATE job_events SET status='partial', error=COALESCE(error, 'Processamento interrompido') "
            "WHERE status='processing'"
        )
        await self.connection.execute(
            "UPDATE job_groups SET status='partial', error=COALESCE(error, 'Processamento interrompido') "
            "WHERE status='processing'"
        )
        await self.connection.commit()

    async def _ensure_result_columns(self) -> None:
        """Migração aditiva para bancos criados pelas versões anteriores."""
        cursor = await self._db().execute("PRAGMA table_info(athlete_results)")
        existing = {row["name"] for row in await cursor.fetchall()}
        columns = {
            "event": "TEXT", "city": "TEXT", "state": "TEXT",
            "category_position": "INTEGER", "pace": "TEXT", "gap": "TEXT",
            "source_url": "TEXT", "extracted_at": "TEXT",
        }
        for name, kind in columns.items():
            if name not in existing:
                await self._db().execute(f"ALTER TABLE athlete_results ADD COLUMN {name} {kind}")

    async def close(self) -> None:
        if self.connection is not None:
            await self.connection.close()
            self.connection = None

    def _db(self) -> aiosqlite.Connection:
        if self.connection is None:
            raise RuntimeError("O armazenamento ainda não foi iniciado.")
        return self.connection

    async def upsert_events(self, events: Sequence[EventSummary]) -> list[EventSummary]:
        if not events:
            return []
        now = utcnow().isoformat()
        async with self._lock:
            db = self._db()
            for event in events:
                discovered = (event.discovered_at or utcnow()).isoformat()
                await db.execute(
                    """
                    INSERT INTO catalog_events (
                        event_id, event_slug, event_url, name, start_date, end_date, city, state,
                        country, expected_total, modalities_json, raw_catalog_json, id_status,
                        metadata_status, discovered_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(event_url) DO UPDATE SET
                        event_id=COALESCE(excluded.event_id, catalog_events.event_id),
                        event_slug=excluded.event_slug,
                        name=excluded.name,
                        start_date=excluded.start_date,
                        end_date=COALESCE(excluded.end_date, catalog_events.end_date),
                        city=excluded.city,
                        state=excluded.state,
                        country=excluded.country,
                        expected_total=COALESCE(excluded.expected_total, catalog_events.expected_total),
                        modalities_json=excluded.modalities_json,
                        raw_catalog_json=excluded.raw_catalog_json,
                        id_status=CASE
                            WHEN excluded.event_id IS NOT NULL THEN 'resolved'
                            WHEN catalog_events.event_id IS NOT NULL THEN 'resolved'
                            ELSE excluded.id_status
                        END,
                        updated_at=excluded.updated_at
                    """,
                    (
                        event.event_id,
                        event.event_slug,
                        event.event_url,
                        event.name,
                        event.event_date.isoformat() if event.event_date else None,
                        event.end_date.isoformat() if event.end_date else None,
                        event.city,
                        event.state,
                        event.country,
                        event.expected_total,
                        json_dumps(event.modalities),
                        json_dumps(event.raw_metadata),
                        "resolved" if event.event_id else event.id_status,
                        event.metadata_status,
                        discovered,
                        now,
                    ),
                )
            await db.commit()
        hydrated: list[EventSummary] = []
        for event in events:
            stored = await self.get_event_by_url(event.event_url)
            if stored is not None:
                hydrated.append(self._summary_from_row(stored))
        return hydrated

    async def update_event_resolution(
        self,
        catalog_id: int,
        *,
        event_id: str | None,
        id_status: str,
        metadata: EventMetadata | None = None,
        modalities: Sequence[ModalityInfo] = (),
    ) -> None:
        now = utcnow().isoformat()
        metadata_status = "completed" if metadata is not None else "pending"
        values: list[Any] = [event_id, id_status, metadata_status, now]
        sql = (
            "UPDATE catalog_events SET event_id=COALESCE(?, event_id), id_status=?, "
            "metadata_status=CASE WHEN ?='completed' THEN 'completed' ELSE metadata_status END, updated_at=?"
        )
        if metadata is not None:
            sql += (
                ", name=?, start_date=?, end_date=?, city=?, state=?, country=?, expected_total=?, "
                "modalities_json=?, metadata_fetched_at=?"
            )
            values.extend(
                [
                    metadata.name,
                    metadata.event_date.isoformat() if metadata.event_date else None,
                    metadata.end_date.isoformat() if metadata.end_date else None,
                    metadata.city,
                    metadata.state,
                    metadata.country,
                    metadata.expected_total,
                    json_dumps([asdict(item) for item in modalities]),
                    (metadata.metadata_fetched_at or utcnow()).isoformat(),
                ]
            )
        sql += " WHERE catalog_id=?"
        values.append(catalog_id)
        async with self._lock:
            await self._db().execute(sql, tuple(values))
            await self._db().commit()

    async def save_metadata(
        self,
        catalog_id: int,
        metadata: EventMetadata,
        modalities: Sequence[ModalityInfo],
        *,
        related_metadata_included: bool,
    ) -> None:
        fetched_at = metadata.metadata_fetched_at or utcnow()
        normalized = asdict(metadata)
        normalized["modalities"] = [asdict(item) for item in modalities]
        async with self._lock:
            db = self._db()
            await db.execute(
                """
                INSERT INTO event_metadata (
                    catalog_id, normalized_json, raw_metadata_json, related_metadata_included, fetched_at
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(catalog_id) DO UPDATE SET
                    normalized_json=excluded.normalized_json,
                    raw_metadata_json=excluded.raw_metadata_json,
                    related_metadata_included=excluded.related_metadata_included,
                    fetched_at=excluded.fetched_at
                """,
                (
                    catalog_id,
                    json_dumps(normalized),
                    json_dumps(metadata.raw_metadata),
                    int(related_metadata_included),
                    fetched_at.isoformat(),
                ),
            )
            await db.execute(
                "UPDATE catalog_events SET metadata_status='completed', metadata_fetched_at=?, updated_at=? "
                "WHERE catalog_id=?",
                (fetched_at.isoformat(), utcnow().isoformat(), catalog_id),
            )
            await db.commit()

    async def get_event_by_url(self, url: str) -> aiosqlite.Row | None:
        cursor = await self._db().execute("SELECT * FROM catalog_events WHERE event_url=?", (url,))
        return await cursor.fetchone()

    async def get_event_by_id(self, event_id: str) -> aiosqlite.Row | None:
        cursor = await self._db().execute("SELECT * FROM catalog_events WHERE event_id=?", (event_id,))
        return await cursor.fetchone()

    async def get_event_by_catalog_id(self, catalog_id: int) -> aiosqlite.Row | None:
        cursor = await self._db().execute("SELECT * FROM catalog_events WHERE catalog_id=?", (catalog_id,))
        return await cursor.fetchone()

    async def get_event_detail(self, row: aiosqlite.Row) -> dict[str, Any]:
        item = self.event_row_to_dict(row)
        cursor = await self._db().execute(
            "SELECT normalized_json, raw_metadata_json, related_metadata_included, fetched_at "
            "FROM event_metadata WHERE catalog_id=?",
            (row["catalog_id"],),
        )
        metadata = await cursor.fetchone()
        if metadata:
            item.update(json_loads(metadata["normalized_json"], {}))
            item["raw_metadata"] = json_loads(metadata["raw_metadata_json"], {})
            item["related_metadata_included"] = bool(metadata["related_metadata_included"])
            item["metadata_fetched_at"] = metadata["fetched_at"]
        else:
            item["raw_metadata"] = {}
            item["related_metadata_included"] = False
        return item

    async def list_events(
        self,
        *,
        page: int = 1,
        limit: int = 50,
        date_from: str | None = None,
        date_to: str | None = None,
        search: str = "",
        state: str = "",
        id_status: str = "",
        ascending: bool = False,
    ) -> dict[str, Any]:
        where, params = self._event_filters(date_from, date_to, search, state, id_status)
        db = self._db()
        total_cursor = await db.execute(f"SELECT COUNT(*) AS total FROM catalog_events {where}", params)
        total = int((await total_cursor.fetchone())["total"])
        direction = "ASC" if ascending else "DESC"
        cursor = await db.execute(
            f"SELECT * FROM catalog_events {where} ORDER BY start_date {direction}, name ASC "
            "LIMIT ? OFFSET ?",
            (*params, limit, (page - 1) * limit),
        )
        rows = await cursor.fetchall()
        return {
            "items": [self.event_row_to_dict(row) for row in rows],
            "total": total,
            "page": page,
            "limit": limit,
        }

    async def events_for_scope(
        self,
        *,
        date_from: str | None = None,
        date_to: str | None = None,
        event_ids: Sequence[str] = (),
        event_urls: Sequence[str] = (),
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if date_from:
            clauses.append("start_date >= ?")
            params.append(date_from)
        if date_to:
            clauses.append("start_date <= ?")
            params.append(date_to)
        identifiers: list[str] = []
        if event_ids:
            placeholders = ",".join("?" for _ in event_ids)
            identifiers.append(f"event_id IN ({placeholders})")
            params.extend(event_ids)
        if event_urls:
            placeholders = ",".join("?" for _ in event_urls)
            identifiers.append(f"event_url IN ({placeholders})")
            params.extend(event_urls)
        if identifiers:
            clauses.append("(" + " OR ".join(identifiers) + ")")
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        cursor = await self._db().execute(
            f"SELECT * FROM catalog_events {where} ORDER BY start_date ASC, name ASC",
            tuple(params),
        )
        return [self.event_row_to_dict(row) for row in await cursor.fetchall()]

    async def catalog_stats(self, date_from: str | None = None, date_to: str | None = None) -> dict[str, Any]:
        where, params = self._event_filters(date_from, date_to, "", "", "")
        cursor = await self._db().execute(
            f"SELECT COUNT(*) AS total, MIN(start_date) AS oldest, MAX(start_date) AS newest, "
            f"SUM(CASE WHEN event_id IS NULL THEN 1 ELSE 0 END) AS unresolved FROM catalog_events {where}",
            params,
        )
        row = await cursor.fetchone()
        return dict(row) if row else {"total": 0, "oldest": None, "newest": None, "unresolved": 0}

    def _event_filters(
        self,
        date_from: str | None,
        date_to: str | None,
        search: str,
        state: str,
        id_status: str,
    ) -> tuple[str, tuple[Any, ...]]:
        clauses: list[str] = []
        params: list[Any] = []
        if date_from:
            clauses.append("start_date >= ?")
            params.append(date_from)
        if date_to:
            clauses.append("start_date <= ?")
            params.append(date_to)
        if search:
            clauses.append("(name LIKE ? OR event_id LIKE ? OR event_slug LIKE ?)")
            term = f"%{search}%"
            params.extend([term, term, term])
        if state:
            clauses.append("state = ?")
            params.append(state.upper())
        if id_status:
            clauses.append("id_status = ?")
            params.append(id_status)
        return (" WHERE " + " AND ".join(clauses) if clauses else "", tuple(params))

    def _summary_from_row(self, row: aiosqlite.Row) -> EventSummary:
        return EventSummary(
            name=row["name"],
            event_date=date.fromisoformat(row["start_date"]) if row["start_date"] else None,
            city=row["city"],
            state=row["state"],
            event_url=row["event_url"],
            event_slug=row["event_slug"],
            event_id=row["event_id"],
            end_date=date.fromisoformat(row["end_date"]) if row["end_date"] else None,
            country=row["country"],
            expected_total=row["expected_total"],
            modalities=json_loads(row["modalities_json"], []),
            raw_metadata=json_loads(row["raw_catalog_json"], {}),
            catalog_id=row["catalog_id"],
            id_status=row["id_status"],
            metadata_status=row["metadata_status"],
            discovered_at=datetime.fromisoformat(row["discovered_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
            metadata_fetched_at=(
                datetime.fromisoformat(row["metadata_fetched_at"])
                if row["metadata_fetched_at"] else None
            ),
        )

    def event_row_to_dict(self, row: aiosqlite.Row) -> dict[str, Any]:
        return {
            "catalog_id": row["catalog_id"],
            "event_id": row["event_id"],
            "event_slug": row["event_slug"],
            "event_url": row["event_url"],
            "name": row["name"],
            "start_date": row["start_date"],
            "end_date": row["end_date"],
            "city": row["city"],
            "state": row["state"],
            "country": row["country"],
            "expected_total": row["expected_total"],
            "modalities": json_loads(row["modalities_json"], []),
            "id_status": row["id_status"],
            "metadata_status": row["metadata_status"],
            "discovered_at": row["discovered_at"],
            "updated_at": row["updated_at"],
            "metadata_fetched_at": row["metadata_fetched_at"],
        }

    async def create_job(self, job_id: str, job_type: str, scope: dict[str, Any]) -> None:
        now = utcnow().isoformat()
        await self._db().execute(
            "INSERT INTO jobs (id, job_type, scope_json, status, stage, created_at, updated_at) "
            "VALUES (?, ?, ?, 'queued', 'Na fila', ?, ?)",
            (job_id, job_type, json_dumps(scope), now, now),
        )
        await self._db().commit()

    async def update_job(self, job_id: str, **values: Any) -> None:
        allowed = {
            "status",
            "stage",
            "progress",
            "counters",
            "current_event",
            "current_modality",
            "current_gender",
            "expires_at",
            "error",
            "warnings",
            "download_path",
            "filename",
        }
        assignments: list[str] = []
        params: list[Any] = []
        for key, value in values.items():
            if key not in allowed:
                continue
            column = {"counters": "counters_json", "warnings": "warnings_json"}.get(key, key)
            assignments.append(f"{column}=?")
            params.append(json_dumps(value) if key in {"counters", "warnings"} else value)
        if not assignments:
            return
        assignments.append("updated_at=?")
        params.append(utcnow().isoformat())
        params.append(job_id)
        await self._db().execute(f"UPDATE jobs SET {', '.join(assignments)} WHERE id=?", tuple(params))
        await self._db().commit()

    async def get_job(self, job_id: str) -> dict[str, Any] | None:
        cursor = await self._db().execute("SELECT * FROM jobs WHERE id=?", (job_id,))
        row = await cursor.fetchone()
        return self.job_row_to_dict(row) if row else None

    async def pending_job_count(self) -> int:
        cursor = await self._db().execute(
            "SELECT COUNT(*) AS total FROM jobs WHERE status IN ('queued','running','interrupted')"
        )
        return int((await cursor.fetchone())["total"])

    async def retained_job_count(self) -> int:
        cursor = await self._db().execute("SELECT COUNT(*) AS total FROM jobs")
        return int((await cursor.fetchone())["total"])

    def job_row_to_dict(self, row: aiosqlite.Row) -> dict[str, Any]:
        return {
            "job_id": row["id"],
            "job_type": row["job_type"],
            "scope": json_loads(row["scope_json"], {}),
            "status": row["status"],
            "stage": row["stage"],
            "progress": row["progress"],
            "counters": json_loads(row["counters_json"], {}),
            "current_event": row["current_event"],
            "current_modality": row["current_modality"],
            "current_gender": row["current_gender"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "expires_at": row["expires_at"],
            "error": row["error"],
            "warnings": json_loads(row["warnings_json"], []),
            "download_path": row["download_path"],
            "filename": row["filename"],
            "download_ready": bool(row["download_path"] and Path(row["download_path"]).exists()),
        }

    async def add_job_events(self, job_id: str, events: Sequence[dict[str, Any]]) -> None:
        if not events:
            return
        await self._db().executemany(
            """
            INSERT INTO job_events (
                job_id, catalog_id, event_id, event_name, event_url, event_date, status
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending')
            ON CONFLICT(job_id, catalog_id) DO UPDATE SET
                event_id=COALESCE(excluded.event_id, job_events.event_id),
                event_name=excluded.event_name,
                event_url=excluded.event_url,
                event_date=excluded.event_date
            """,
            [
                (
                    job_id,
                    event["catalog_id"],
                    event.get("event_id"),
                    event["name"],
                    event["event_url"],
                    event.get("start_date"),
                )
                for event in events
            ],
        )
        await self._db().commit()

    async def update_job_event(self, job_id: str, catalog_id: int, **values: Any) -> None:
        allowed = {
            "event_id",
            "status",
            "groups_total",
            "groups_completed",
            "athletes_extracted",
            "error",
            "started_at",
            "completed_at",
        }
        assignments: list[str] = []
        params: list[Any] = []
        for key, value in values.items():
            if key in allowed:
                assignments.append(f"{key}=?")
                params.append(value)
        if not assignments:
            return
        params.extend([job_id, catalog_id])
        await self._db().execute(
            f"UPDATE job_events SET {', '.join(assignments)} WHERE job_id=? AND catalog_id=?",
            tuple(params),
        )
        await self._db().commit()

    async def get_job_events(self, job_id: str, *, resumable_only: bool = False) -> list[dict[str, Any]]:
        where = " AND status NOT IN ('completed','no_results','skipped')" if resumable_only else ""
        cursor = await self._db().execute(
            "SELECT * FROM job_events WHERE job_id=?" + where + " ORDER BY event_date ASC, event_name ASC",
            (job_id,),
        )
        return [dict(row) for row in await cursor.fetchall()]

    async def upsert_group(
        self,
        job_id: str,
        catalog_id: int,
        modality_value: str,
        modality_name: str,
        gender: str,
        **values: Any,
    ) -> None:
        await self._db().execute(
            """
            INSERT INTO job_groups (
                job_id, catalog_id, modality_value, modality_name, gender, status,
                next_offset, expected_total, extracted_total, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(job_id, catalog_id, modality_value, gender) DO UPDATE SET
                modality_name=excluded.modality_name,
                status=excluded.status,
                next_offset=excluded.next_offset,
                expected_total=COALESCE(excluded.expected_total, job_groups.expected_total),
                extracted_total=excluded.extracted_total,
                error=excluded.error
            """,
            (
                job_id,
                catalog_id,
                modality_value,
                modality_name,
                gender,
                values.get("status", "pending"),
                values.get("next_offset", 0),
                values.get("expected_total"),
                values.get("extracted_total", 0),
                values.get("error"),
            ),
        )
        await self._db().commit()

    async def get_group(
        self, job_id: str, catalog_id: int, modality_value: str, gender: str
    ) -> dict[str, Any] | None:
        cursor = await self._db().execute(
            "SELECT * FROM job_groups WHERE job_id=? AND catalog_id=? AND modality_value=? AND gender=?",
            (job_id, catalog_id, modality_value, gender),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def get_groups(self, job_id: str, catalog_id: int) -> list[dict[str, Any]]:
        cursor = await self._db().execute(
            "SELECT * FROM job_groups WHERE job_id=? AND catalog_id=? "
            "ORDER BY modality_name, gender",
            (job_id, catalog_id),
        )
        return [dict(row) for row in await cursor.fetchall()]

    async def insert_results(self, job_id: str, event_id: str, records: Sequence[dict[str, Any]]) -> int:
        if not records:
            return 0
        async with self._lock:
            before = self._db().total_changes
            await self._db().executemany(
                """
                INSERT OR IGNORE INTO athlete_results (
                    job_id, event_id, event, event_date, city, state, modality, modality_value,
                    distance_km, gender, overall_position, category_position, category, bib,
                    name, team, pace, time, gap, source_url, extracted_at, data_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        job_id,
                        event_id,
                        record.get("event"),
                        record.get("event_date"),
                        record.get("city"),
                        record.get("state"),
                        record.get("modality"),
                        record.get("modality_value"),
                        record.get("distance_km"),
                        record.get("gender"),
                        record.get("overall_position"),
                        record.get("category_position"),
                        record.get("category"),
                        str(record.get("bib") or ""),
                        record.get("name"),
                        record.get("team"),
                        record.get("pace"),
                        record.get("time"),
                        record.get("gap"),
                        record.get("source_url"),
                        record.get("extracted_at"),
                        json_dumps(record),
                    )
                    for record in records
                ],
            )
            await self._db().commit()
            return self._db().total_changes - before

    async def delete_group_results(
        self, job_id: str, event_id: str, modality_value: str, gender: str
    ) -> None:
        await self._db().execute(
            "DELETE FROM athlete_results WHERE job_id=? AND event_id=? AND modality_value=? AND gender=?",
            (job_id, event_id, modality_value, gender),
        )
        await self._db().commit()

    async def result_count(self, job_id: str) -> int:
        cursor = await self._db().execute(
            "SELECT COUNT(*) AS total FROM athlete_results WHERE job_id=?", (job_id,)
        )
        return int((await cursor.fetchone())["total"])

    async def result_summary(self, job_id: str) -> dict[str, Any]:
        db = self._db()
        total = await self.result_count(job_id)
        gender_cursor = await db.execute(
            "SELECT gender, COUNT(*) AS total FROM athlete_results WHERE job_id=? GROUP BY gender",
            (job_id,),
        )
        group_cursor = await db.execute(
            "SELECT modality, gender, COUNT(*) AS total FROM athlete_results WHERE job_id=? "
            "GROUP BY modality, gender",
            (job_id,),
        )
        event_cursor = await db.execute(
            "SELECT COUNT(DISTINCT event_id) AS total FROM athlete_results WHERE job_id=?", (job_id,)
        )
        return {
            "total_extracted": total,
            "by_gender": {row["gender"]: row["total"] for row in await gender_cursor.fetchall()},
            "by_group": {
                f"{row['modality']} | {row['gender']}": row["total"]
                for row in await group_cursor.fetchall()
            },
            "events_with_results": int((await event_cursor.fetchone())["total"]),
        }

    async def query_results(
        self,
        job_id: str,
        *,
        page: int,
        page_size: int,
        search: str = "",
        gender: str = "",
        modality: str = "",
        category: str = "",
        event_id: str = "",
        sort_by: str = "distance_km",
        sort_dir: str = "asc",
    ) -> dict[str, Any]:
        sort_columns = {
            "event_id": "event_id",
            "event": "event",
            "event_date": "event_date",
            "city": "city",
            "state": "state",
            "modality": "modality",
            "distance_km": "distance_km",
            "gender": "gender",
            "overall_position": "overall_position",
            "category_position": "category_position",
            "category": "category",
            "bib": "bib",
            "name": "name",
            "team": "team",
            "pace": "pace",
            "time": "time",
            "gap": "gap",
            "source_url": "source_url",
            "extracted_at": "extracted_at",
        }
        if sort_by not in sort_columns:
            raise ValueError("Coluna de ordenação inválida.")
        if sort_dir not in {"asc", "desc"}:
            raise ValueError("Direção de ordenação inválida.")
        clauses = ["job_id=?"]
        params: list[Any] = [job_id]
        if search:
            clauses.append("(name LIKE ? OR bib LIKE ? OR team LIKE ?)")
            term = f"%{search}%"
            params.extend([term, term, term])
        for column, value in (
            ("gender", gender),
            ("modality", modality),
            ("category", category),
            ("event_id", event_id),
        ):
            if value:
                clauses.append(f"{column}=?")
                params.append(value)
        where = " WHERE " + " AND ".join(clauses)
        db = self._db()
        total_cursor = await db.execute(
            "SELECT COUNT(*) AS total FROM athlete_results WHERE job_id=?", (job_id,)
        )
        filtered_cursor = await db.execute(f"SELECT COUNT(*) AS total FROM athlete_results {where}", tuple(params))
        cursor = await db.execute(
            f"SELECT data_json FROM athlete_results {where} ORDER BY {sort_columns[sort_by]} "
            f"{sort_dir.upper()}, row_id ASC LIMIT ? OFFSET ?",
            (*params, page_size, (page - 1) * page_size),
        )
        facets: dict[str, list[str]] = {}
        for column, key in (("gender", "genders"), ("modality", "modalities"), ("category", "categories"), ("event_id", "events")):
            facet_cursor = await db.execute(
                f"SELECT DISTINCT {column} AS value FROM athlete_results "
                f"WHERE job_id=? AND {column} IS NOT NULL AND {column}<>'' ORDER BY {column}",
                (job_id,),
            )
            facets[key] = [row["value"] for row in await facet_cursor.fetchall()]
        return {
            "items": [json_loads(row["data_json"], {}) for row in await cursor.fetchall()],
            "page": page,
            "page_size": page_size,
            "total": int((await total_cursor.fetchone())["total"]),
            "filtered_total": int((await filtered_cursor.fetchone())["total"]),
            "facets": facets,
        }

    async def fetch_result_chunk(self, job_id: str, offset: int, limit: int) -> list[dict[str, Any]]:
        cursor = await self._db().execute(
            "SELECT data_json FROM athlete_results WHERE job_id=? "
            "ORDER BY event_date ASC, event_id ASC, distance_km ASC, modality ASC, gender ASC, "
            "overall_position ASC, row_id ASC LIMIT ? OFFSET ?",
            (job_id, limit, offset),
        )
        return [json_loads(row["data_json"], {}) for row in await cursor.fetchall()]

    async def delete_expired_jobs(self, before: str) -> list[str]:
        cursor = await self._db().execute(
            "SELECT id, download_path FROM jobs WHERE expires_at IS NOT NULL AND expires_at<=?", (before,)
        )
        rows = await cursor.fetchall()
        await self._db().executemany("DELETE FROM jobs WHERE id=?", [(row["id"],) for row in rows])
        await self._db().commit()
        return [row["download_path"] for row in rows if row["download_path"]]
