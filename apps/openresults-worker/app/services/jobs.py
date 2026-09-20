from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

import pandas as pd

from app.config import Settings
from app.models import EventSummary, ExtractionResult, JobCapacityError, ScraperError, ScopeValidationError
from app.services.exporter import export_result_parts, export_xlsx
from app.services.openresults.catalog import EventCatalog
from app.services.openresults.metadata import EventMetadataService
from app.services.scraper import OpenResultsScraper
from app.services.url_validation import validate_event_url
from app.storage import SQLiteStorage


logger = logging.getLogger(__name__)

TERMINAL_STATES = {"completed", "completed_with_warnings", "failed"}
SORTABLE_FIELDS = {
    "event",
    "event_date",
    "city",
    "state",
    "modality",
    "distance_km",
    "gender",
    "overall_position",
    "category_position",
    "category",
    "bib",
    "name",
    "team",
    "pace",
    "time",
    "gap",
    "extracted_at",
}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(slots=True)
class JobRecord:
    id: str
    source_url: str
    status: str = "queued"
    stage: str = "Na fila"
    progress: int = 0
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)
    expires_at: datetime | None = None
    result: ExtractionResult | None = None
    error: str | None = None
    file_path: Path | None = None
    filename: str | None = None
    job_type: str = "legacy_results"
    scope: dict[str, Any] = field(default_factory=dict)
    counters: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    current_event: str | None = None
    current_modality: str | None = None
    current_gender: str | None = None

    def as_status(self) -> dict[str, Any]:
        result = self.result
        return {
            "job_id": self.id,
            "status": self.status,
            "stage": self.stage,
            "progress": self.progress,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
            "job_type": self.job_type,
            "scope": self.scope,
            "event": result.metadata.name if result else self.current_event,
            "modalities": [item.name for item in result.modalities] if result else [],
            "modality_count": len(result.modalities) if result else 0,
            "total_expected": result.expected_total if result else None,
            "total_extracted": result.extracted_total if result else self.counters.get("athletes_extracted", 0),
            "by_gender": result.by_gender if result else {},
            "by_group": result.by_group if result else {},
            "warnings": result.warnings if result else self.warnings,
            "counters": self.counters,
            "current_event": self.current_event,
            "current_modality": self.current_modality,
            "current_gender": self.current_gender,
            "error": self.error,
            "download_ready": bool(self.file_path and self.file_path.exists()),
        }


class JobManager:
    def __init__(
        self,
        settings: Settings,
        scraper_factory: Callable[[Settings], Any] = OpenResultsScraper,
    ) -> None:
        self.settings = settings
        self.scraper_factory = scraper_factory
        self.jobs: dict[str, JobRecord] = {}
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self.job_semaphore = asyncio.Semaphore(settings.max_parallel_jobs)
        self.cleanup_task: asyncio.Task[None] | None = None
        defaults = Settings()
        database_path = settings.database_path
        if settings.temp_dir != defaults.temp_dir and settings.database_path == defaults.database_path:
            database_path = settings.temp_dir / "scraper-openresults.sqlite3"
        self.storage = SQLiteStorage(database_path)
        self.catalog = EventCatalog(settings)
        self.metadata_service = EventMetadataService(settings)

    async def start(self) -> None:
        self.settings.temp_dir.mkdir(parents=True, exist_ok=True)
        await self.storage.start()
        self.cleanup_task = asyncio.create_task(self._cleanup_loop(), name="openresults-cleanup")

    async def shutdown(self) -> None:
        if self.cleanup_task:
            self.cleanup_task.cancel()
        for task in self.tasks.values():
            if not task.done():
                task.cancel()
        pending = [task for task in [self.cleanup_task, *self.tasks.values()] if task]
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        await self.storage.close()

    def create_job(self, source_url: str) -> JobRecord:
        if not self.has_capacity():
            raise JobCapacityError(
                "O serviço atingiu o limite temporário de extrações. Tente novamente em alguns minutos."
            )
        canonical = validate_event_url(source_url, self.settings.allowed_host)
        job = JobRecord(id=str(uuid4()), source_url=canonical)
        self.jobs[job.id] = job
        self.tasks[job.id] = asyncio.create_task(self._run_job(job), name=f"openresults-{job.id}")
        return job

    async def create_catalog_job(self, *, date_from: str | None, date_to: str | None) -> JobRecord:
        scope = {
            "mode": "all",
            "date_from": date_from or self.settings.events_min_date,
            "date_to": date_to,
        }
        job = await self._register_persistent("catalog", scope)
        self.tasks[job.id] = asyncio.create_task(self._run_catalog_job(job), name=f"catalog-{job.id}")
        return job

    async def create_metadata_job(self, scope: dict[str, Any], *, enrich_roadrunners: bool) -> JobRecord:
        normalized = self._normalize_scope(scope)
        normalized["enrich_roadrunners"] = bool(enrich_roadrunners)
        job = await self._register_persistent("metadata", normalized)
        self.tasks[job.id] = asyncio.create_task(self._run_metadata_job(job), name=f"metadata-{job.id}")
        return job

    async def create_results_job(self, scope: dict[str, Any]) -> JobRecord:
        normalized = self._normalize_scope(scope)
        job = await self._register_persistent("results", normalized)
        self.tasks[job.id] = asyncio.create_task(self._run_results_job(job), name=f"results-{job.id}")
        return job

    async def resume_job(self, job_id: str) -> dict[str, Any]:
        stored = await self.storage.get_job(job_id)
        if stored is None:
            raise ScopeValidationError("Trabalho não encontrado ou expirado.")
        if stored["job_type"] != "results":
            raise ScopeValidationError("Somente trabalhos de resultados podem ser retomados.")
        if stored["status"] not in {"interrupted", "failed", "completed_with_warnings"}:
            raise ScopeValidationError("Este trabalho não está em um estado retomável.")
        job = self.jobs.get(job_id) or JobRecord(
            id=job_id,
            source_url="",
            job_type="results",
            scope=stored["scope"],
            counters=stored["counters"],
            warnings=stored["warnings"],
        )
        job.status = "queued"
        job.stage = "Na fila para retomada"
        job.error = None
        self.jobs[job_id] = job
        await self.storage.update_job(job_id, status="queued", stage=job.stage, error=None, expires_at=None)
        self.tasks[job_id] = asyncio.create_task(self._run_results_job(job, resume=True), name=f"resume-{job.id}")
        return job.as_status()

    async def get_status(self, job_id: str) -> dict[str, Any] | None:
        job = self.jobs.get(job_id)
        if job is not None:
            payload = job.as_status()
            if job.job_type == "results" and job.result is None:
                payload.update(await self.storage.result_summary(job_id))
            return payload
        return await self.storage.get_job(job_id)

    async def _register_persistent(self, job_type: str, scope: dict[str, Any]) -> JobRecord:
        if not self.has_capacity() or await self.storage.pending_job_count() >= self.settings.max_queued_jobs:
            raise JobCapacityError(
                "O serviço atingiu o limite temporário de extrações. Tente novamente em alguns minutos."
            )
        job = JobRecord(id=str(uuid4()), source_url="", job_type=job_type, scope=scope)
        self.jobs[job.id] = job
        await self.storage.create_job(job.id, job_type, scope)
        return job

    def _normalize_scope(self, scope: dict[str, Any]) -> dict[str, Any]:
        normalized = dict(scope)
        mode = normalized.get("mode", "all")
        normalized["mode"] = mode
        normalized["date_from"] = (
            normalized.get("date_from") or self.settings.events_min_date
            if mode == "all"
            else normalized.get("date_from")
        )
        normalized["date_to"] = normalized.get("date_to")
        normalized["event_ids"] = [str(value).strip() for value in normalized.get("event_ids", []) if str(value).strip()]
        urls = list(normalized.get("event_urls", []))
        if normalized.get("url"):
            urls.append(normalized["url"])
        normalized["event_urls"] = [validate_event_url(value, self.settings.allowed_host) for value in urls]
        normalized.pop("url", None)
        if mode == "selected" and not (normalized["event_ids"] or normalized["event_urls"]):
            raise ScopeValidationError("Selecione pelo menos uma prova.")
        if mode == "single" and len(normalized["event_urls"]) != 1:
            raise ScopeValidationError("O escopo single exige exatamente uma URL de prova.")
        return normalized

    async def _scope_events(self, scope: dict[str, Any]) -> list[dict[str, Any]]:
        for event_url in scope.get("event_urls", []):
            if await self.storage.get_event_by_url(event_url) is None:
                slug = event_url.rstrip("/").split("/")[-1]
                await self.storage.upsert_events(
                    [EventSummary(name=slug.replace("-", " ").title(), event_date=None, city="", state="", event_url=event_url, event_slug=slug)]
                )
        identifiers = scope.get("event_ids", []) if scope.get("mode") != "all" else []
        urls = scope.get("event_urls", []) if scope.get("mode") != "all" else []
        return await self.storage.events_for_scope(
            date_from=scope.get("date_from"),
            date_to=scope.get("date_to"),
            event_ids=identifiers,
            event_urls=urls,
        )

    async def _metadata_cache_hit(
        self, event: dict[str, Any] | EventSummary, *, require_related: bool = False
    ) -> bool:
        fetched = (
            event.get("metadata_fetched_at") if isinstance(event, dict)
            else event.metadata_fetched_at
        )
        if not fetched:
            return False
        try:
            timestamp = datetime.fromisoformat(str(fetched))
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=timezone.utc)
        except ValueError:
            return False
        if utcnow() - timestamp > timedelta(seconds=self.settings.metadata_cache_ttl_seconds):
            return False
        if not require_related:
            return True
        catalog_id = event.get("catalog_id") if isinstance(event, dict) else event.catalog_id
        row = await self.storage.get_event_by_catalog_id(int(catalog_id))
        if row is None:
            return False
        detail = await self.storage.get_event_detail(row)
        return bool(detail.get("related_metadata_included"))

    async def _set_progress(
        self,
        job: JobRecord,
        stage: str,
        progress: int,
        *,
        counters: dict[str, Any] | None = None,
        current_event: str | None = None,
        current_modality: str | None = None,
        current_gender: str | None = None,
    ) -> None:
        job.stage = stage
        job.progress = max(job.progress, min(99, int(progress)))
        job.updated_at = utcnow()
        if counters is not None:
            job.counters.update(counters)
        if current_event is not None:
            job.current_event = current_event
        job.current_modality = current_modality
        job.current_gender = current_gender
        await self.storage.update_job(
            job.id,
            status=job.status,
            stage=job.stage,
            progress=job.progress,
            counters=job.counters,
            current_event=job.current_event,
            current_modality=job.current_modality,
            current_gender=job.current_gender,
            warnings=job.warnings,
        )

    async def _run_catalog_job(self, job: JobRecord) -> None:
        async with self.job_semaphore:
            job.status = "running"
            try:
                date_from = datetime.fromisoformat(job.scope["date_from"]).date()
                date_to = datetime.fromisoformat(job.scope["date_to"]).date() if job.scope.get("date_to") else None

                async def progress(stage: str, value: int, counters: dict[str, int]) -> None:
                    await self._set_progress(job, stage, value, counters=counters)

                result = await self.catalog.discover(date_from=date_from, date_to=date_to, progress=progress)
                stored = await self.storage.upsert_events(result.events)
                job.warnings.extend(result.warnings)
                total = len(stored)
                job.counters.update({
                    "events_found": total,
                    "pages_loaded": result.pages_loaded,
                    "advertised_total": result.advertised_total,
                    "metadata_completed": 0,
                })
                queue: asyncio.Queue[EventSummary] = asyncio.Queue()
                for event in stored:
                    queue.put_nowait(event)

                async def worker() -> None:
                    while True:
                        try:
                            event = queue.get_nowait()
                        except asyncio.QueueEmpty:
                            return
                        try:
                            if not await self._metadata_cache_hit(event):
                                metadata, modalities = await self.metadata_service.fetch(event.event_url)
                                await self.storage.update_event_resolution(
                                    int(event.catalog_id),
                                    event_id=metadata.event_id,
                                    id_status="resolved" if metadata.event_id else "unavailable",
                                    metadata=metadata,
                                    modalities=modalities,
                                )
                                await self.storage.save_metadata(
                                    int(event.catalog_id), metadata, modalities, related_metadata_included=False
                                )
                        except Exception as exc:
                            logger.warning("Falha ao resolver %s: %s", event.event_url, exc)
                            await self.storage.update_event_resolution(
                                int(event.catalog_id), event_id=None, id_status="error"
                            )
                            job.warnings.append(f"{event.name}: metadados indisponíveis.")
                        finally:
                            job.counters["metadata_completed"] += 1
                            done = job.counters["metadata_completed"]
                            await self._set_progress(
                                job,
                                f"Resolvendo IDs e metadados ({done}/{total})",
                                75 + int(23 * done / max(1, total)),
                            )
                            queue.task_done()

                await asyncio.gather(*(worker() for _ in range(self.settings.catalog_concurrency)))
                await self._finish_persistent(job)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await self._fail_persistent(job, exc)

    async def _run_metadata_job(self, job: JobRecord) -> None:
        async with self.job_semaphore:
            job.status = "running"
            try:
                events = await self._scope_events(job.scope)
                if not events:
                    raise ScopeValidationError("Nenhuma prova encontrada para o escopo informado.")
                job.counters = {"events_total": len(events), "events_completed": 0, "events_failed": 0}
                queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
                for event in events:
                    queue.put_nowait(event)
                counter_lock = asyncio.Lock()

                async def worker() -> None:
                    while True:
                        try:
                            event = queue.get_nowait()
                        except asyncio.QueueEmpty:
                            return
                        try:
                            include_related = bool(job.scope.get("enrich_roadrunners"))
                            if not await self._metadata_cache_hit(event, require_related=include_related):
                                metadata, modalities = await self.metadata_service.fetch(
                                    event["event_url"], enrich_roadrunners=include_related
                                )
                                await self.storage.update_event_resolution(
                                    event["catalog_id"], event_id=metadata.event_id,
                                    id_status="resolved" if metadata.event_id else "unavailable",
                                    metadata=metadata, modalities=modalities,
                                )
                                await self.storage.save_metadata(
                                    event["catalog_id"], metadata, modalities,
                                    related_metadata_included=include_related,
                                )
                            succeeded = True
                        except Exception as exc:
                            succeeded = False
                            job.warnings.append(f"{event['name']}: {exc}")
                        async with counter_lock:
                            key = "events_completed" if succeeded else "events_failed"
                            job.counters[key] += 1
                            done = job.counters["events_completed"] + job.counters["events_failed"]
                            await self._set_progress(
                                job, f"Metadados processados ({done}/{len(events)})",
                                int(done / len(events) * 95), current_event=event["name"],
                            )
                        queue.task_done()

                await asyncio.gather(*(worker() for _ in range(self.settings.metadata_concurrency)))
                await self._finish_persistent(job)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await self._fail_persistent(job, exc)

    async def _run_results_job(self, job: JobRecord, *, resume: bool = False) -> None:
        async with self.job_semaphore:
            job.status = "running"
            try:
                events = await self._scope_events(job.scope)
                if not events:
                    raise ScopeValidationError("Nenhuma prova encontrada para o escopo informado.")
                await self.storage.add_job_events(job.id, events)
                pending_ids = {
                    row["catalog_id"] for row in await self.storage.get_job_events(job.id, resumable_only=resume)
                } if resume else {event["catalog_id"] for event in events}
                selected = [event for event in events if event["catalog_id"] in pending_ids]
                completed_before = len(events) - len(selected)
                job.counters.update({
                    "events_total": len(events), "events_completed": completed_before,
                    "events_failed": 0, "events_skipped": 0,
                    "athletes_extracted": await self.storage.result_count(job.id),
                })
                for event in selected:
                    catalog_id = event["catalog_id"]
                    await self.storage.update_job_event(
                        job.id, catalog_id, status="processing", started_at=utcnow().isoformat(), error=None
                    )
                    base = job.counters["events_completed"] + job.counters["events_failed"] + job.counters["events_skipped"]

                    async def progress(stage: str, value: int) -> None:
                        overall = int((base + value / 100) / max(1, len(events)) * 90)
                        await self._set_progress(job, stage, overall, current_event=event["name"])

                    try:
                        metadata, modalities = await self.metadata_service.fetch(event["event_url"])
                        event_id = metadata.event_id or event.get("event_id")
                        if not event_id:
                            job.counters["events_skipped"] += 1
                            warning = f"{event['name']}: id_evento ainda não está disponível; prova ignorada."
                            job.warnings.append(warning)
                            await self.storage.update_event_resolution(catalog_id, event_id=None, id_status="unavailable", metadata=metadata, modalities=modalities)
                            await self.storage.update_job_event(job.id, catalog_id, status="skipped", error=warning, completed_at=utcnow().isoformat())
                            continue
                        await self.storage.update_event_resolution(catalog_id, event_id=event_id, id_status="resolved", metadata=metadata, modalities=modalities)
                        await self.storage.save_metadata(catalog_id, metadata, modalities, related_metadata_included=False)
                        scraper = self.scraper_factory(self.settings)
                        before_count = await self.storage.result_count(job.id)
                        if hasattr(scraper, "scrape_to_storage"):
                            result = await scraper.scrape_to_storage(
                                event["event_url"], job_id=job.id, catalog_id=catalog_id,
                                event_id=event_id, storage=self.storage, progress=progress,
                            )
                            inserted = (await self.storage.result_count(job.id)) - before_count
                        else:
                            result = await scraper.scrape(event["event_url"], progress)
                            for record in result.records:
                                record["event_id"] = event_id
                            inserted = await self.storage.insert_results(job.id, event_id, result.records)
                            for modality in result.modalities:
                                for gender in ("F", "M"):
                                    await self.storage.upsert_group(
                                        job.id, catalog_id, modality.value, modality.name, gender,
                                        status="completed", next_offset=modality.expected_by_gender.get(gender, 0),
                                        expected_total=modality.expected_by_gender.get(gender),
                                        extracted_total=sum(
                                            1 for row in result.records
                                            if row.get("modality_value") == modality.value
                                            and row.get("gender") == ("Feminino" if gender == "F" else "Masculino")
                                        ),
                                    )
                        job.counters["athletes_extracted"] += inserted
                        job.warnings.extend(f"{event['name']}: {warning}" for warning in result.warnings)
                        groups = await self.storage.get_groups(job.id, catalog_id)
                        incomplete_groups = [group for group in groups if group["status"] != "completed"]
                        event_status = "partial" if incomplete_groups else "completed"
                        if incomplete_groups:
                            job.counters["events_failed"] += 1
                        else:
                            job.counters["events_completed"] += 1
                        await self.storage.update_job_event(
                            job.id, catalog_id, event_id=event_id, status=event_status,
                            groups_total=len(result.modalities) * 2,
                            groups_completed=sum(1 for group in groups if group["status"] == "completed"),
                            athletes_extracted=result.extracted_total,
                            completed_at=utcnow().isoformat() if not incomplete_groups else None,
                            error="Há grupos incompletos; o trabalho pode ser retomado." if incomplete_groups else None,
                        )
                    except Exception as exc:
                        logger.exception("Falha ao extrair a prova %s", event["event_url"])
                        job.counters["events_failed"] += 1
                        job.warnings.append(f"{event['name']}: {exc}")
                        await self.storage.update_job_event(job.id, catalog_id, status="partial", error=str(exc))
                    await self._set_progress(job, f"Processadas {base + 1} de {len(events)} provas", int((base + 1) / len(events) * 90))
                total = await self.storage.result_count(job.id)
                if total:
                    await self._set_progress(job, "Gerando arquivo de resultados", 94)
                    part_size = self.settings.results_rows_per_workbook
                    parts = [
                        await self.storage.fetch_result_chunk(job.id, offset, part_size)
                        for offset in range(0, total, part_size)
                    ]
                    path, filename = await asyncio.to_thread(export_result_parts, parts, self.settings.temp_dir / job.id)
                    job.file_path, job.filename = path, filename
                else:
                    job.warnings.append("Nenhum atleta foi extraído no escopo informado.")
                await self._finish_persistent(job)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await self._fail_persistent(job, exc)

    async def _finish_persistent(self, job: JobRecord) -> None:
        job.warnings = list(dict.fromkeys(job.warnings))
        job.status = "completed_with_warnings" if job.warnings else "completed"
        job.stage = "Concluído com avisos" if job.warnings else "Concluído"
        job.progress = 100
        job.updated_at = utcnow()
        job.expires_at = job.updated_at + timedelta(seconds=self.settings.job_ttl_seconds)
        await self.storage.update_job(
            job.id, status=job.status, stage=job.stage, progress=100, counters=job.counters,
            warnings=job.warnings, expires_at=job.expires_at.isoformat(),
            download_path=str(job.file_path) if job.file_path else None, filename=job.filename,
        )

    async def _fail_persistent(self, job: JobRecord, error: Exception) -> None:
        logger.exception("Falha no trabalho persistente %s", job.id)
        job.status = "failed"
        job.stage = "Falha"
        job.error = str(error) if isinstance(error, ScraperError) else "Ocorreu um erro inesperado durante o processamento."
        job.updated_at = utcnow()
        job.expires_at = job.updated_at + timedelta(seconds=self.settings.job_ttl_seconds)
        await self.storage.update_job(
            job.id, status="failed", stage="Falha", error=job.error, counters=job.counters,
            warnings=job.warnings, expires_at=job.expires_at.isoformat(),
        )

    def has_capacity(self) -> bool:
        pending = sum(1 for job in self.jobs.values() if job.status not in TERMINAL_STATES)
        return pending < self.settings.max_queued_jobs and len(self.jobs) < self.settings.max_retained_jobs

    def get(self, job_id: str) -> JobRecord | None:
        return self.jobs.get(job_id)

    async def _run_job(self, job: JobRecord) -> None:
        async with self.job_semaphore:
            job.status = "running"
            job.stage = "Iniciando extração"
            job.updated_at = utcnow()

            async def progress(stage: str, value: int) -> None:
                job.stage = stage
                job.progress = max(job.progress, min(99, int(value)))
                job.updated_at = utcnow()

            try:
                scraper = self.scraper_factory(self.settings)
                result = await scraper.scrape(job.source_url, progress)
                job.result = result
                await progress("Gerando Excel", 93)
                job_dir = self.settings.temp_dir / job.id
                path, filename = await asyncio.to_thread(export_xlsx, result, job_dir)
                job.file_path = path
                job.filename = filename
                job.status = "completed_with_warnings" if result.warnings else "completed"
                job.stage = "Concluído com avisos" if result.warnings else "Concluído"
                job.progress = 100
            except asyncio.CancelledError:
                raise
            except ScraperError as exc:
                logger.exception("Falha no trabalho %s", job.id)
                job.status = "failed"
                job.stage = "Falha"
                job.error = str(exc)
            except Exception:
                logger.exception("Erro inesperado no trabalho %s", job.id)
                job.status = "failed"
                job.stage = "Falha"
                job.error = "Ocorreu um erro inesperado durante a extração. Consulte os logs do servidor."
            finally:
                job.updated_at = utcnow()
                if job.status in TERMINAL_STATES:
                    job.expires_at = job.updated_at + timedelta(seconds=self.settings.job_ttl_seconds)

    async def _cleanup_loop(self) -> None:
        while True:
            await asyncio.sleep(self.settings.cleanup_interval_seconds)
            await self.cleanup_expired()

    async def cleanup_expired(self) -> None:
        now = utcnow()
        expired = [
            job_id
            for job_id, job in self.jobs.items()
            if job.expires_at is not None and job.expires_at <= now
        ]
        for job_id in expired:
            job = self.jobs.pop(job_id, None)
            self.tasks.pop(job_id, None)
            if job and job.file_path:
                self._remove_job_file(job.file_path)
        for stored_path in await self.storage.delete_expired_jobs(now.isoformat()):
            if stored_path:
                self._remove_job_file(Path(stored_path))

    def _remove_job_file(self, file_path: Path) -> None:
        try:
            root = self.settings.temp_dir.resolve()
            target = file_path.resolve()
            if root not in target.parents:
                logger.error("Recusando remover arquivo fora da pasta temporária: %s", target)
                return
            target.unlink(missing_ok=True)
            try:
                target.parent.rmdir()
            except OSError:
                pass
        except OSError:
            logger.exception("Não foi possível remover o arquivo temporário %s", file_path)


def query_job_results(
    job: JobRecord,
    *,
    page: int,
    page_size: int,
    search: str = "",
    gender: str = "",
    modality: str = "",
    category: str = "",
    sort_by: str = "distance_km",
    sort_dir: str = "asc",
) -> dict[str, Any]:
    if job.result is None:
        return {
            "items": [],
            "page": page,
            "page_size": page_size,
            "total": 0,
            "filtered_total": 0,
            "facets": {"genders": [], "modalities": [], "categories": []},
        }
    available_fields = set(job.result.records[0]) if job.result.records else set()
    if sort_by not in SORTABLE_FIELDS and sort_by not in available_fields:
        raise ValueError("Coluna de ordenação inválida.")
    if sort_dir not in {"asc", "desc"}:
        raise ValueError("Direção de ordenação inválida.")

    frame = pd.DataFrame(job.result.records)
    total = len(frame)
    facets = {
        "genders": sorted(value for value in frame.get("gender", pd.Series(dtype=str)).dropna().unique() if value),
        "modalities": sorted(value for value in frame.get("modality", pd.Series(dtype=str)).dropna().unique() if value),
        "categories": sorted(value for value in frame.get("category", pd.Series(dtype=str)).dropna().unique() if value),
    }
    if search:
        mask = pd.Series(False, index=frame.index)
        for field_name in ("name", "bib", "team"):
            if field_name in frame.columns:
                mask |= frame[field_name].astype("string").str.contains(search, case=False, regex=False, na=False)
        frame = frame[mask]
    for field_name, value in (("gender", gender), ("modality", modality), ("category", category)):
        if value and field_name in frame.columns:
            frame = frame[frame[field_name] == value]

    filtered_total = len(frame)
    if sort_by in frame.columns:
        frame = frame.sort_values(
            by=sort_by,
            ascending=sort_dir == "asc",
            na_position="last",
            kind="mergesort",
        )
    start = (page - 1) * page_size
    page_frame = frame.iloc[start : start + page_size]
    items = page_frame.astype(object).where(pd.notna(page_frame), None).to_dict(orient="records")
    return {
        "items": items,
        "page": page,
        "page_size": page_size,
        "total": total,
        "filtered_total": filtered_total,
        "facets": facets,
    }
