from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.background import BackgroundTask

from app.config import Settings, get_settings
from app.models import JobCapacityError, ScopeValidationError, URLValidationError
from app.schemas import DiscoverEventsRequest, MetadataRequest, ResultsRequest, ScrapeAccepted, ScrapeRequest
from app.services.exporter import export_events_xlsx
from app.services.jobs import JobManager, TERMINAL_STATES, query_job_results
from app.services.rate_limit import SlidingWindowRateLimiter
from app.services.scraper import OpenResultsScraper


BASE_DIR = Path(__file__).resolve().parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
OPENAPI_TAGS = [
    {"name": "System", "description": "Saúde, identificação e interface da API."},
    {"name": "Events", "description": "Descoberta, consulta, metadados e exportação do catálogo de provas."},
    {"name": "Results", "description": "Criação de extrações de atletas e compatibilidade com a API v1."},
    {"name": "Jobs", "description": "Progresso, retomada, resultados paginados e arquivos dos trabalhos."},
]


def create_app(
    settings: Settings | None = None,
    scraper_factory: Callable[[Settings], Any] = OpenResultsScraper,
) -> FastAPI:
    configured = settings or get_settings()
    logging.basicConfig(
        level=logging.DEBUG if configured.debug else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        jobs = JobManager(configured, scraper_factory=scraper_factory)
        application.state.jobs = jobs
        await jobs.start()
        try:
            yield
        finally:
            await jobs.shutdown()

    application = FastAPI(
        title="scraper-openresults API",
        summary="Catálogo, metadados e resultados públicos do Open Results.",
        description=(
            "API aberta para descobrir provas, coletar metadados e consolidar resultados. "
            "Os trabalhos são assíncronos e os clientes devem acompanhar `/api/jobs/{job_id}`. "
            "Não há autenticação por padrão; consulte `docs/API.md` e `docs/DEPLOYMENT.md`."
        ),
        version="2.0.0",
        openapi_tags=OPENAPI_TAGS,
        license_info={
            "name": "MIT",
            "url": "https://github.com/gustavomf-ykn/scraper-openresults/blob/main/LICENSE",
        },
        contact={
            "name": "scraper-openresults",
            "url": "https://github.com/gustavomf-ykn/scraper-openresults",
        },
        lifespan=lifespan,
    )
    application.add_middleware(
        CORSMiddleware,
        allow_origins=list(configured.allowed_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Accept", "Content-Type"],
        expose_headers=["Content-Disposition", "Retry-After"],
        max_age=600,
    )
    application.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
    rate_limiter = SlidingWindowRateLimiter(configured.rate_limit_requests, configured.rate_limit_window_seconds)

    def manager(request: Request) -> JobManager:
        return request.app.state.jobs

    def enforce_rate_limit(request: Request) -> None:
        forwarded = request.headers.get("x-forwarded-for", "") if configured.trust_proxy_headers else ""
        client_ip = forwarded.split(",", 1)[0].strip() or (request.client.host if request.client else "unknown")
        allowed, retry_after = rate_limiter.check(client_ip)
        if not allowed:
            raise HTTPException(
                status_code=429,
                detail="Muitas extrações foram solicitadas. Aguarde antes de tentar novamente.",
                headers={"Retry-After": str(retry_after)},
            )

    def accepted(job: Any) -> ScrapeAccepted:
        return ScrapeAccepted(job_id=job.id, status=job.status, status_url=f"/api/jobs/{job.id}")

    @application.get("/", response_class=HTMLResponse, tags=["System"], summary="Interface web")
    async def index(request: Request) -> HTMLResponse:
        return templates.TemplateResponse(request=request, name="index.html", context={"app_name": configured.app_name})

    @application.get("/healthz", tags=["System"], summary="Health check")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @application.get("/api", tags=["System"], summary="Informações e links da API")
    async def api_information(request: Request) -> dict[str, Any]:
        base = str(request.base_url).rstrip("/")
        return {
            "name": "scraper-openresults",
            "version": "2.0.0",
            "license": "MIT",
            "documentation": f"{base}/docs",
            "redoc": f"{base}/redoc",
            "openapi": f"{base}/openapi.json",
            "health": f"{base}/healthz",
        }

    @application.post(
        "/api/scrape", response_model=ScrapeAccepted, status_code=status.HTTP_202_ACCEPTED,
        tags=["Results"], summary="Extrair uma prova (compatibilidade v1)", deprecated=True,
    )
    async def create_scrape(payload: ScrapeRequest, request: Request) -> ScrapeAccepted:
        enforce_rate_limit(request)
        try:
            job = manager(request).create_job(payload.url)
        except URLValidationError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except JobCapacityError as exc:
            raise HTTPException(status_code=429, detail=str(exc), headers={"Retry-After": "60"}) from exc
        return accepted(job)

    @application.post(
        "/api/events/discover", response_model=ScrapeAccepted, status_code=202,
        tags=["Events"], summary="Descobrir e atualizar o catálogo",
    )
    async def discover_events(payload: DiscoverEventsRequest, request: Request) -> ScrapeAccepted:
        enforce_rate_limit(request)
        try:
            job = await manager(request).create_catalog_job(
                date_from=payload.date_from.isoformat() if payload.date_from else None,
                date_to=payload.date_to.isoformat() if payload.date_to else None,
            )
        except JobCapacityError as exc:
            raise HTTPException(status_code=429, detail=str(exc), headers={"Retry-After": "60"}) from exc
        return accepted(job)

    @application.post(
        "/api/events/metadata", response_model=ScrapeAccepted, status_code=202,
        tags=["Events"], summary="Atualizar metadados de um escopo",
    )
    async def fetch_metadata(payload: MetadataRequest, request: Request) -> ScrapeAccepted:
        enforce_rate_limit(request)
        try:
            job = await manager(request).create_metadata_job(
                payload.scope.model_dump(mode="json"), enrich_roadrunners=payload.enrich_roadrunners
            )
        except (JobCapacityError, ScopeValidationError, URLValidationError) as exc:
            code = 429 if isinstance(exc, JobCapacityError) else 400
            raise HTTPException(status_code=code, detail=str(exc)) from exc
        return accepted(job)

    @application.post(
        "/api/results/scrape", response_model=ScrapeAccepted, status_code=202,
        tags=["Results"], summary="Extrair resultados de um escopo",
    )
    async def scrape_results(payload: ResultsRequest, request: Request) -> ScrapeAccepted:
        enforce_rate_limit(request)
        try:
            job = await manager(request).create_results_job(payload.scope.model_dump(mode="json"))
        except (JobCapacityError, ScopeValidationError, URLValidationError) as exc:
            code = 429 if isinstance(exc, JobCapacityError) else 400
            raise HTTPException(status_code=code, detail=str(exc)) from exc
        return accepted(job)

    @application.get("/api/events", tags=["Events"], summary="Listar provas do catálogo")
    async def list_events(
        request: Request,
        page: int = Query(1, ge=1),
        limit: int = Query(50, ge=1, le=200),
        date_from: date | None = None,
        date_to: date | None = None,
        search: str = Query("", max_length=200),
        state: str = Query("", max_length=2),
        id_status: str = Query("", max_length=30),
    ) -> dict[str, Any]:
        return await manager(request).storage.list_events(
            page=page, limit=limit,
            date_from=date_from.isoformat() if date_from else None,
            date_to=date_to.isoformat() if date_to else None,
            search=search, state=state, id_status=id_status,
        )

    async def event_export(
        request: Request, *, full: bool, date_from: date | None, date_to: date | None
    ) -> FileResponse:
        storage = manager(request).storage
        listing = await storage.list_events(
            page=1, limit=100_000,
            date_from=date_from.isoformat() if date_from else None,
            date_to=date_to.isoformat() if date_to else None,
            ascending=True,
        )
        rows = listing["items"]
        if full:
            detailed: list[dict[str, Any]] = []
            for item in rows:
                row = await storage.get_event_by_catalog_id(item["catalog_id"])
                detailed.append(await storage.get_event_detail(row) if row is not None else item)
            rows = detailed
        output_dir = configured.temp_dir / "exports" / str(uuid4())
        path, filename = await asyncio.to_thread(export_events_xlsx, rows, output_dir, full=full)

        def remove_export() -> None:
            root = (configured.temp_dir / "exports").resolve()
            target = path.resolve()
            if root in target.parents:
                target.unlink(missing_ok=True)
                try:
                    target.parent.rmdir()
                except OSError:
                    pass

        return FileResponse(
            path=path,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            filename=filename,
            background=BackgroundTask(remove_export),
        )

    @application.get("/api/events/export/simple", tags=["Events"], summary="Exportar catálogo simples")
    async def export_events_simple(
        request: Request, date_from: date | None = None, date_to: date | None = None
    ) -> FileResponse:
        return await event_export(request, full=False, date_from=date_from, date_to=date_to)

    @application.get("/api/events/export/full", tags=["Events"], summary="Exportar catálogo completo")
    async def export_events_full(
        request: Request, date_from: date | None = None, date_to: date | None = None
    ) -> FileResponse:
        return await event_export(request, full=True, date_from=date_from, date_to=date_to)

    @application.get("/api/catalog/events/{catalog_id}", tags=["Events"], summary="Consultar prova pelo ID local")
    async def catalog_event(catalog_id: int, request: Request) -> dict[str, Any]:
        row = await manager(request).storage.get_event_by_catalog_id(catalog_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Prova não encontrada.")
        return await manager(request).storage.get_event_detail(row)

    @application.get("/api/events/{event_id}", tags=["Events"], summary="Consultar prova pelo id_evento")
    async def event_by_id(event_id: str, request: Request) -> dict[str, Any]:
        row = await manager(request).storage.get_event_by_id(event_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Prova não encontrada.")
        return await manager(request).storage.get_event_detail(row)

    @application.get("/api/jobs/{job_id}", tags=["Jobs"], summary="Consultar estado de um trabalho")
    async def job_status(job_id: str, request: Request) -> dict[str, Any]:
        payload = await manager(request).get_status(job_id)
        if payload is None:
            raise HTTPException(status_code=404, detail="Trabalho não encontrado ou expirado.")
        return payload

    @application.post("/api/jobs/{job_id}/resume", status_code=202, tags=["Jobs"], summary="Retomar trabalho parcial")
    async def resume_job(job_id: str, request: Request) -> dict[str, Any]:
        enforce_rate_limit(request)
        try:
            return await manager(request).resume_job(job_id)
        except ScopeValidationError as exc:
            raise HTTPException(status_code=409 if "estado" in str(exc) else 404, detail=str(exc)) from exc

    @application.get("/api/jobs/{job_id}/events", tags=["Jobs"], summary="Listar provas de um trabalho")
    async def job_events(job_id: str, request: Request) -> dict[str, Any]:
        if await manager(request).get_status(job_id) is None:
            raise HTTPException(status_code=404, detail="Trabalho não encontrado ou expirado.")
        items = await manager(request).storage.get_job_events(job_id)
        return {"items": items, "total": len(items)}

    @application.get("/api/jobs/{job_id}/results", tags=["Jobs"], summary="Consultar atletas paginados")
    async def job_results(
        job_id: str,
        request: Request,
        page: int = Query(1, ge=1),
        page_size: int = Query(25, ge=1, le=200),
        search: str = Query("", max_length=200),
        gender: str = Query("", max_length=100),
        modality: str = Query("", max_length=200),
        category: str = Query("", max_length=200),
        event_id: str = Query("", max_length=100),
        sort_by: str = Query("distance_km", max_length=50),
        sort_dir: str = Query("asc", pattern="^(asc|desc)$"),
    ) -> dict[str, Any]:
        job = manager(request).get(job_id)
        status_payload = await manager(request).get_status(job_id)
        if status_payload is None:
            raise HTTPException(status_code=404, detail="Trabalho não encontrado ou expirado.")
        if status_payload["status"] not in TERMINAL_STATES:
            raise HTTPException(status_code=409, detail="A extração ainda está em andamento.")
        if status_payload.get("job_type") == "results":
            try:
                return await manager(request).storage.query_results(
                    job_id, page=page, page_size=page_size, search=search, gender=gender,
                    modality=modality, category=category, event_id=event_id,
                    sort_by=sort_by, sort_dir=sort_dir,
                )
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        if job is None or job.result is None:
            raise HTTPException(status_code=409, detail=status_payload.get("error") or "O trabalho não possui resultados.")
        try:
            return query_job_results(
                job, page=page, page_size=page_size, search=search, gender=gender,
                modality=modality, category=category, sort_by=sort_by, sort_dir=sort_dir,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @application.get("/api/jobs/{job_id}/download", tags=["Jobs"], summary="Baixar XLSX ou ZIP")
    async def job_download(job_id: str, request: Request) -> FileResponse:
        job = manager(request).get(job_id)
        status_payload = await manager(request).get_status(job_id)
        if status_payload is None:
            raise HTTPException(status_code=404, detail="Trabalho não encontrado ou expirado.")
        file_path = job.file_path if job and job.file_path else (
            Path(status_payload["download_path"]) if status_payload.get("download_path") else None
        )
        filename = job.filename if job and job.filename else status_payload.get("filename")
        if not file_path or not file_path.exists() or not filename:
            raise HTTPException(status_code=409, detail="O arquivo ainda não está disponível.")
        return FileResponse(
            path=file_path,
            media_type=(
                "application/zip" if file_path.suffix.lower() == ".zip"
                else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            ),
            filename=filename,
        )

    return application


app = create_app()
