from __future__ import annotations

import asyncio
from collections import Counter
from datetime import datetime, timezone
from inspect import isawaitable
from typing import Any, Awaitable, Callable

from app.config import Settings
from app.models import (
    AccessBlockedError,
    EventDiscovery,
    EventNotFoundError,
    ExtractionResult,
    NoResultsError,
    ScraperError,
    StructureChangedError,
)
from app.services.openresults_client import (
    OpenResultsClient,
    build_endpoint_url,
)
from app.services.parser import (
    deduplicate_records,
    normalize_gender,
    parse_event_page,
    sort_records,
)
from app.services.playwright_fallback import ProgressCallback, run_playwright_fallback
from app.services.url_validation import validate_event_url, validate_internal_url
from app.services.source_requests import SourceBudgetDeferred, SourceCircuitOpen, CapacityDeferred
from app.services.result_pages import parse_result_page


class OpenResultsScraper:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def _emit(self, callback: ProgressCallback | None, stage: str, progress: int) -> None:
        if callback is None:
            return
        result = callback(stage, progress)
        if isawaitable(result):
            await result

    async def scrape(
        self,
        url: str,
        progress: ProgressCallback | None = None,
        *,
        checkpoint: Any = None,
    ) -> ExtractionResult:
        await self._emit(progress, "Validando URL", 2)
        canonical_url = validate_event_url(url, self.settings.allowed_host)
        extracted_at = datetime.now(timezone.utc)
        if checkpoint is not None:
            ready = await asyncio.to_thread(checkpoint.ready)
            if ready is not None:
                return ready

        async with OpenResultsClient(self.settings) as client:
            await self._emit(progress, "Carregando evento", 7)
            discovery: EventDiscovery | None = None
            direct_error: ScraperError | None = None
            try:
                html = await client.get_event_page(canonical_url)
                await self._emit(progress, "Descobrindo modalidades", 10)
                discovery = parse_event_page(html, canonical_url)
            except (AccessBlockedError, EventNotFoundError, SourceBudgetDeferred, SourceCircuitOpen, CapacityDeferred):
                raise
            except ScraperError as exc:
                direct_error = exc

            if discovery is None or not discovery.endpoint_url:
                outcome = await run_playwright_fallback(canonical_url, self.settings, progress)
                discovery = outcome.discovery
                client.update_cookies(outcome.cookies)
                if outcome.records is not None:
                    if not outcome.records:
                        raise direct_error or NoResultsError("A página não possui resultados disponíveis.")
                    return await self._finalize(
                        discovery,
                        outcome.records,
                        outcome.warnings,
                        {},
                        extracted_at,
                        progress,
                    )

            if not discovery.endpoint_url:
                raise StructureChangedError("Nenhum endpoint de resultados utilizável foi encontrado.")
            endpoint = validate_internal_url(
                discovery.endpoint_url,
                self.settings.allowed_host,
                base_url=canonical_url,
            )
            if checkpoint is not None:
                discovery.endpoint_url = endpoint
                discovery, extracted_at = await asyncio.to_thread(checkpoint.start, discovery, extracted_at)
                for modality in discovery.modalities:
                    for gender in ("F", "M"):
                        group = await asyncio.to_thread(checkpoint.group, modality, gender)
                        if group is None:
                            raise StructureChangedError("result_groups_invalid")
                        if group['status'] == 'completed':
                            continue
                        offset = group['nextOffset']
                        for _ in range(group['pageCount'], self.settings.max_endpoint_pages):
                            request_url = build_endpoint_url(endpoint, modality=modality.value, gender=gender,
                                offset=offset, limit=self.settings.endpoint_page_size, allowed_host=self.settings.allowed_host)
                            payload = await client.get_endpoint_page(request_url, discovery.metadata.source_url)
                            page = parse_result_page(payload, discovery, modality, gender, offset, extracted_at)
                            await asyncio.to_thread(checkpoint.save_page, modality, gender, offset, page)
                            await self._emit(progress, "Página confirmada", 50)
                            if not page.has_more:
                                break
                            offset = page.next_offset
                        else:
                            raise StructureChangedError("result_page_limit")
                return await asyncio.to_thread(checkpoint.finish)
            return await self._scrape_endpoint(
                client,
                discovery,
                endpoint,
                extracted_at,
                progress,
            )

    async def scrape_to_storage(
        self,
        url: str,
        *,
        job_id: str,
        catalog_id: int,
        event_id: str,
        storage: Any,
        progress: ProgressCallback | None = None,
    ) -> ExtractionResult:
        """Extrai e confirma cada página no SQLite para permitir retomada exata."""
        canonical_url = validate_event_url(url, self.settings.allowed_host)
        extracted_at = datetime.now(timezone.utc)
        async with OpenResultsClient(self.settings) as client:
            await self._emit(progress, "Carregando evento", 5)
            html = await client.get_event_page(canonical_url)
            discovery = parse_event_page(html, canonical_url)
            discovery.metadata.event_id = event_id
            if not discovery.endpoint_url:
                result = await self.scrape(canonical_url, progress)
                for record in result.records:
                    record["event_id"] = event_id
                await storage.insert_results(job_id, event_id, result.records)
                return result
            endpoint = validate_internal_url(
                discovery.endpoint_url, self.settings.allowed_host, base_url=canonical_url
            )
            specs = [(modality, gender) for modality in discovery.modalities for gender in ("F", "M")]
            semaphore = asyncio.Semaphore(self.settings.scrape_concurrency)
            completed = 0
            progress_lock = asyncio.Lock()

            async def group(modality: Any, gender: str) -> tuple[int, int | None, list[str]]:
                nonlocal completed
                try:
                    async with semaphore:
                        extracted, expected, warnings = await self._fetch_group_persistent(
                            client, discovery, endpoint, modality, gender, extracted_at,
                            job_id=job_id, catalog_id=catalog_id, event_id=event_id, storage=storage,
                        )
                except Exception as exc:
                    checkpoint = await storage.get_group(job_id, catalog_id, modality.value, gender)
                    await storage.upsert_group(
                        job_id, catalog_id, modality.value, modality.name, gender,
                        status="partial", next_offset=int(checkpoint["next_offset"] if checkpoint else 0),
                        expected_total=checkpoint["expected_total"] if checkpoint else None,
                        extracted_total=int(checkpoint["extracted_total"] if checkpoint else 0),
                        error=str(exc),
                    )
                    raise
                async with progress_lock:
                    completed += 1
                    await self._emit(
                        progress,
                        f"Extraído {modality.name} {normalize_gender(gender).lower()}",
                        10 + int(completed / max(1, len(specs)) * 75),
                    )
                return extracted, expected, warnings

            responses = await asyncio.gather(
                *(group(modality, gender) for modality, gender in specs), return_exceptions=True
            )
        warnings: list[str] = []
        by_group: dict[str, int] = {}
        endpoint_totals: dict[str, int] = {}
        first_error: BaseException | None = None
        for (modality, gender), response in zip(specs, responses, strict=True):
            if isinstance(response, (AccessBlockedError, SourceBudgetDeferred, SourceCircuitOpen, CapacityDeferred)):
                raise response
            name = f"{modality.name} | {normalize_gender(gender)}"
            if isinstance(response, BaseException):
                first_error = first_error or response
                warnings.append(f"{name}: {response}")
                continue
            extracted, expected, group_warnings = response
            by_group[name] = extracted
            if expected is not None:
                endpoint_totals[name] = expected
            warnings.extend(group_warnings)
        extracted_total = sum(by_group.values())
        if extracted_total == 0 and first_error:
            if isinstance(first_error, ScraperError):
                raise first_error
            raise NoResultsError("Nenhum resultado foi encontrado para o evento.")
        by_gender = {
            gender_name: sum(count for name, count in by_group.items() if name.endswith(f"| {gender_name}"))
            for gender_name in ("Feminino", "Masculino")
        }
        expected_total = discovery.metadata.expected_total
        if expected_total is not None and expected_total != extracted_total:
            warnings.append(f"Total geral: esperado {expected_total}, extraído {extracted_total}.")
        await self._emit(progress, "Resultados persistidos", 90)
        return ExtractionResult(
            metadata=discovery.metadata,
            modalities=discovery.modalities,
            records=[],
            expected_total=expected_total,
            extracted_total=extracted_total,
            by_gender=by_gender,
            by_group=by_group,
            warnings=list(dict.fromkeys(warnings)),
            extracted_at=extracted_at,
        )

    async def _fetch_group_persistent(
        self,
        client: OpenResultsClient,
        discovery: EventDiscovery,
        endpoint: str,
        modality: Any,
        gender_code: str,
        extracted_at: datetime,
        *,
        job_id: str,
        catalog_id: int,
        event_id: str,
        storage: Any,
    ) -> tuple[int, int | None, list[str]]:
        checkpoint = await storage.get_group(job_id, catalog_id, modality.value, gender_code)
        if checkpoint and checkpoint["status"] == "completed":
            return int(checkpoint["extracted_total"]), checkpoint["expected_total"], []
        offset = int(checkpoint["next_offset"] if checkpoint else 0)
        extracted = int(checkpoint["extracted_total"] if checkpoint else 0)
        expected = checkpoint["expected_total"] if checkpoint else None
        warnings: list[str] = []
        seen_offsets: set[int] = set()
        await storage.upsert_group(
            job_id, catalog_id, modality.value, modality.name, gender_code,
            status="processing", next_offset=offset, expected_total=expected,
            extracted_total=extracted, error=None,
        )
        for _ in range(self.settings.max_endpoint_pages):
            if offset in seen_offsets:
                raise StructureChangedError(
                    f"A paginação entrou em ciclo em {modality.name} {normalize_gender(gender_code)}."
                )
            seen_offsets.add(offset)
            request_url = build_endpoint_url(
                endpoint, modality=modality.value, gender=gender_code, offset=offset,
                limit=self.settings.endpoint_page_size, allowed_host=self.settings.allowed_host,
            )
            payload = await client.get_endpoint_page(request_url, discovery.metadata.source_url)
            page = parse_result_page(payload, discovery, modality, gender_code, offset, extracted_at)
            page_total = page.expected
            if expected is None:
                expected = page_total
            elif page_total is not None and page_total != expected:
                raise StructureChangedError("result_total_changed")
            rows = page.records
            for row in rows:
                row["event_id"] = event_id
            extracted += await storage.insert_results(job_id, event_id, rows)
            has_more = page.has_more
            next_offset = page.next_offset
            await storage.upsert_group(
                job_id, catalog_id, modality.value, modality.name, gender_code,
                status="processing" if has_more else "completed",
                next_offset=next_offset, expected_total=expected, extracted_total=extracted, error=None,
            )
            if not has_more:
                break
            if not rows or next_offset <= offset:
                raise StructureChangedError(
                    f"A paginação não avançou em {modality.name} {normalize_gender(gender_code)}."
                )
            offset = next_offset
        else:
            raise StructureChangedError("A paginação excedeu o limite de segurança.")
        summary_expected = modality.expected_by_gender.get(gender_code)
        if summary_expected is not None and expected is not None and summary_expected != expected:
            warnings.append(
                f"{modality.name} {normalize_gender(gender_code)}: resumo={summary_expected}, endpoint={expected}."
            )
        if expected is not None and extracted != expected:
            warnings.append(
                f"{modality.name} {normalize_gender(gender_code)}: esperado {expected}, extraído {extracted}."
            )
        return extracted, expected, warnings

    async def _scrape_endpoint(
        self,
        client: OpenResultsClient,
        discovery: EventDiscovery,
        endpoint: str,
        extracted_at: datetime,
        progress: ProgressCallback | None,
    ) -> ExtractionResult:
        semaphore = asyncio.Semaphore(self.settings.scrape_concurrency)
        progress_lock = asyncio.Lock()
        completed_groups = 0
        total_groups = max(1, len(discovery.modalities) * 2)

        async def scrape_group(modality: Any, gender_code: str) -> tuple[list[dict[str, object]], int | None, list[str]]:
            nonlocal completed_groups
            gender_name = normalize_gender(gender_code).lower()
            async with semaphore:
                await self._emit(progress, f"Extraindo {modality.name} {gender_name}", 15 + int(completed_groups / total_groups * 60))
                rows, expected, warnings = await self._fetch_group(
                    client,
                    discovery,
                    endpoint,
                    modality,
                    gender_code,
                    extracted_at,
                )
            async with progress_lock:
                completed_groups += 1
                await self._emit(
                    progress,
                    f"Extraído {modality.name} {gender_name}",
                    15 + int(completed_groups / total_groups * 60),
                )
            return rows, expected, warnings

        specs = [
            (modality, gender)
            for modality in discovery.modalities
            for gender in ("F", "M")
        ]
        responses = await asyncio.gather(
            *(scrape_group(modality, gender) for modality, gender in specs),
            return_exceptions=True,
        )

        records: list[dict[str, object]] = []
        endpoint_totals: dict[str, int] = {}
        warnings: list[str] = []
        first_error: Exception | None = None
        for (modality, gender), response in zip(specs, responses, strict=True):
            if isinstance(response, (AccessBlockedError, SourceBudgetDeferred, SourceCircuitOpen, CapacityDeferred)):
                raise response
            group_name = f"{modality.name} | {normalize_gender(gender)}"
            if isinstance(response, BaseException):
                first_error = first_error or response
                warnings.append(f"{group_name}: {response}")
                continue
            group_rows, expected, group_warnings = response
            records.extend(group_rows)
            if expected is not None:
                endpoint_totals[group_name] = expected
            warnings.extend(group_warnings)

        if not records:
            if isinstance(first_error, ScraperError):
                raise first_error
            raise NoResultsError("Nenhum resultado foi encontrado para o evento.")
        return await self._finalize(
            discovery,
            records,
            warnings,
            endpoint_totals,
            extracted_at,
            progress,
        )

    async def _fetch_group(
        self,
        client: OpenResultsClient,
        discovery: EventDiscovery,
        endpoint: str,
        modality: Any,
        gender_code: str,
        extracted_at: datetime,
    ) -> tuple[list[dict[str, object]], int | None, list[str]]:
        offset = 0
        expected: int | None = None
        rows: list[dict[str, object]] = []
        warnings: list[str] = []
        seen_offsets: set[int] = set()

        for _ in range(self.settings.max_endpoint_pages):
            if offset in seen_offsets:
                raise StructureChangedError(
                    f"A paginação entrou em ciclo em {modality.name} {normalize_gender(gender_code)}."
                )
            seen_offsets.add(offset)
            request_url = build_endpoint_url(
                endpoint,
                modality=modality.value,
                gender=gender_code,
                offset=offset,
                limit=self.settings.endpoint_page_size,
                allowed_host=self.settings.allowed_host,
            )
            payload = await client.get_endpoint_page(request_url, discovery.metadata.source_url)
            page = parse_result_page(payload, discovery, modality, gender_code, offset, extracted_at)
            page_total = page.expected
            if expected is None:
                expected = page_total
            elif page_total is not None and page_total != expected:
                raise StructureChangedError("result_total_changed")
            page_rows = page.records
            rows.extend(page_rows)
            has_more = page.has_more
            next_offset = page.next_offset
            if not has_more:
                break
            if not page_rows or next_offset <= offset:
                raise StructureChangedError(
                    f"A paginação não avançou em {modality.name} {normalize_gender(gender_code)}."
                )
            offset = next_offset
        else:
            raise StructureChangedError("A paginação excedeu o limite de segurança.")

        summary_expected = modality.expected_by_gender.get(gender_code)
        if summary_expected is not None and expected is not None and summary_expected != expected:
            warnings.append(
                f"{modality.name} {normalize_gender(gender_code)}: resumo={summary_expected}, endpoint={expected}."
            )
        return rows, expected, warnings

    async def _finalize(
        self,
        discovery: EventDiscovery,
        records: list[dict[str, object]],
        warnings: list[str],
        endpoint_totals: dict[str, int],
        extracted_at: datetime,
        progress: ProgressCallback | None,
    ) -> ExtractionResult:
        await self._emit(progress, "Consolidando resultados", 82)
        records, duplicates = deduplicate_records(records)
        if duplicates:
            warnings.append(f"Foram descartadas {duplicates} linha(s) duplicada(s).")
        records = sort_records(records)
        by_gender = dict(Counter(str(row.get("gender") or "") for row in records))
        by_group = dict(
            Counter(f"{row.get('modality')} | {row.get('gender')}" for row in records)
        )

        summary_totals: dict[str, int] = {}
        for modality in discovery.modalities:
            for gender_code, count in modality.expected_by_gender.items():
                summary_totals[f"{modality.name} | {normalize_gender(gender_code)}"] = count
        expected_groups = summary_totals or endpoint_totals
        for group_name, expected in expected_groups.items():
            actual = by_group.get(group_name, 0)
            if actual != expected:
                warnings.append(f"{group_name}: esperado {expected}, extraído {actual}.")

        expected_total = discovery.metadata.expected_total
        if expected_total is None and expected_groups:
            expected_total = sum(expected_groups.values())
        if expected_total is not None and len(records) != expected_total:
            warnings.append(f"Total geral: esperado {expected_total}, extraído {len(records)}.")
        warnings = list(dict.fromkeys(warnings))
        await self._emit(progress, "Resultados consolidados", 88)
        return ExtractionResult(
            metadata=discovery.metadata,
            modalities=discovery.modalities,
            records=records,
            expected_total=expected_total,
            extracted_total=len(records),
            by_gender=by_gender,
            by_group=by_group,
            warnings=warnings,
            extracted_at=extracted_at,
        )
