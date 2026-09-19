from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from inspect import isawaitable
from typing import Any, Awaitable, Callable
from urllib.parse import urlencode

from app.config import Settings
from app.models import EventDiscovery, RequestFailedError, StructureChangedError
from app.services.parser import deduplicate_records, parse_event_page, parse_result_rows
from app.services.url_validation import validate_internal_url
import httpx
from app.services.safe_network import public_ip, bounded_get


ProgressCallback = Callable[[str, int], Awaitable[None] | None]


@dataclass(slots=True)
class PlaywrightOutcome:
    discovery: EventDiscovery
    cookies: dict[str, str] = field(default_factory=dict)
    records: list[dict[str, object]] | None = None
    warnings: list[str] = field(default_factory=list)


async def _emit(callback: ProgressCallback | None, stage: str, progress: int) -> None:
    if callback is None:
        return
    result = callback(stage, progress)
    if isawaitable(result):
        await result


async def run_playwright_fallback(
    canonical_url: str,
    settings: Settings,
    progress: ProgressCallback | None = None,
) -> PlaywrightOutcome:
    try:
        from playwright.async_api import Error as PlaywrightError
        from playwright.async_api import TimeoutError as PlaywrightTimeoutError
        from playwright.async_api import async_playwright
    except ImportError as exc:
        raise RequestFailedError(
            "O fallback exige Playwright. Instale as dependências e execute 'playwright install chromium'."
        ) from exc

    await _emit(progress, "Abrindo fallback do navegador", 12)
    try:
        async with async_playwright() as playwright:
            address = await public_ip(settings.allowed_host)
            browser = await playwright.chromium.launch(headless=True, args=[f"--host-resolver-rules=MAP {settings.allowed_host} {address}, MAP * ~NOTFOUND"])
            context = await browser.new_context(user_agent=settings.user_agent, locale="pt-BR", service_workers="block", accept_downloads=False)
            page = await context.new_page()

            async def block_heavy(route: Any) -> None:
                try:
                    validate_internal_url(route.request.url, settings.allowed_host)
                except Exception:
                    await route.abort()
                    return
                if route.request.resource_type in {"image", "media", "font"}:
                    await route.abort()
                else:
                    # Stream through the same pinned, bounded HTTP transport. Every
                    # redirect is intercepted again before any browser network access.
                    if route.request.method != 'GET':
                        await route.abort()
                        return
                    try:
                        async with httpx.AsyncClient(follow_redirects=False, trust_env=False) as client:
                            response = await bounded_get(client, route.request.url,
                                await route.request.all_headers(), settings.request_timeout)
                        await route.fulfill(status=response.status_code,
                            headers=dict(response.headers), body=response.content)
                    except Exception:
                        await route.abort()

            await page.route("**/*", block_heavy)
            await page.goto(canonical_url, wait_until="domcontentloaded", timeout=int(settings.request_timeout * 1_000))
            discovery = parse_event_page(await page.content(), canonical_url)
            cookies = {item["name"]: item["value"] for item in await context.cookies()}
            if discovery.endpoint_url:
                await browser.close()
                return PlaywrightOutcome(discovery=discovery, cookies=cookies)

            extracted_at = datetime.now(timezone.utc)
            records: list[dict[str, object]] = []
            warnings: list[str] = []
            total_groups = max(1, len(discovery.modalities) * 2)
            completed = 0
            for modality in discovery.modalities:
                for gender_code, gender_name in (("F", "feminino"), ("M", "masculino")):
                    completed += 1
                    await _emit(
                        progress,
                        f"Extraindo {modality.name} {gender_name} pelo navegador",
                        15 + int((completed - 1) / total_groups * 65),
                    )
                    query = urlencode({"modalidade": modality.value, "genero": gender_code})
                    await page.goto(
                        f"{canonical_url}?{query}",
                        wait_until="domcontentloaded",
                        timeout=int(settings.request_timeout * 1_000),
                    )
                    loading = page.locator("#loading")
                    if await loading.count():
                        try:
                            await loading.wait_for(state="hidden", timeout=int(settings.request_timeout * 1_000))
                        except PlaywrightTimeoutError:
                            pass
                    table = page.locator("#tableResultados")
                    if not await table.count():
                        warnings.append(f"{modality.name} {gender_name}: tabela não encontrada no fallback.")
                        continue

                    previous_count = -1
                    stalled = 0
                    while True:
                        current_count = await table.locator("tbody tr").count()
                        status = ""
                        status_node = page.locator("#resultadosInfiniteStatus")
                        if await status_node.count():
                            status = (await status_node.inner_text()).strip()
                        if "todos os" in status.casefold() and "carregados" in status.casefold():
                            break

                        next_button = page.locator(
                            ".dataTables_paginate .next:not(.disabled), button[aria-label='Next']:not([disabled])"
                        )
                        if await next_button.count() == 1 and await next_button.is_visible():
                            await next_button.click()
                            await page.wait_for_function(
                                "previous => document.querySelectorAll('#tableResultados tbody tr').length !== previous",
                                current_count,
                                timeout=5_000,
                            )
                            continue

                        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                        try:
                            await page.wait_for_function(
                                "previous => document.querySelectorAll('#tableResultados tbody tr').length > previous || "
                                "(document.querySelector('#resultadosInfiniteStatus')?.textContent || '').toLowerCase().includes('todos os')",
                                current_count,
                                timeout=5_000,
                            )
                        except PlaywrightTimeoutError:
                            stalled += 1
                        new_count = await table.locator("tbody tr").count()
                        if new_count == current_count:
                            stalled += 1
                        else:
                            stalled = 0
                        if stalled >= 2 or new_count == previous_count:
                            break
                        previous_count = new_count

                    headers = [
                        (await node.inner_text()).strip()
                        for node in await table.locator("thead th").all()
                    ]
                    fragment = await table.locator("tbody").inner_html()
                    records.extend(
                        parse_result_rows(
                            fragment,
                            headers,
                            discovery.metadata,
                            modality,
                            gender_code,
                            extracted_at,
                        )
                    )
            await browser.close()
            records, duplicates = deduplicate_records(records)
            if duplicates:
                warnings.append(f"O fallback descartou {duplicates} linha(s) duplicada(s).")
            return PlaywrightOutcome(
                discovery=discovery,
                cookies=cookies,
                records=records,
                warnings=warnings,
            )
    except StructureChangedError:
        raise
    except PlaywrightTimeoutError as exc:
        raise RequestFailedError("O fallback do navegador excedeu o tempo de espera.") from exc
    except PlaywrightError as exc:
        if "Executable doesn't exist" in str(exc):
            raise RequestFailedError(
                "O Chromium do Playwright não está instalado. Execute 'playwright install chromium'."
            ) from exc
        raise RequestFailedError("O navegador do fallback não pôde ser iniciado.") from exc
    except Exception as exc:
        raise RequestFailedError("Não foi possível extrair os resultados com o fallback do navegador.") from exc
