import time

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_job_api_filters_and_downloads(tmp_path, sample_result) -> None:
    class FakeScraper:
        def __init__(self, settings):
            pass

        async def scrape(self, url, progress):
            await progress("Extraindo teste", 50)
            return sample_result

    settings = Settings(temp_dir=tmp_path, cleanup_interval_seconds=600)
    application = create_app(settings, scraper_factory=FakeScraper)
    with TestClient(application) as client:
        home = client.get("/")
        assert home.status_code == 200
        assert "Extrator de Resultados Open Results" in home.text
        assert client.get("/static/app.js").status_code == 200
        assert client.get("/healthz").json() == {"status": "ok"}

        preflight = client.options(
            "/api/scrape",
            headers={
                "Origin": "https://gustavomf-ykn.github.io",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        assert preflight.status_code == 200
        assert preflight.headers["access-control-allow-origin"] == "https://gustavomf-ykn.github.io"

        response = client.post("/api/scrape", json={"url": "https://openresults.run/evento/corrida-teste-2026/#resultado"})
        assert response.status_code == 202
        job_id = response.json()["job_id"]
        status_payload = None
        for _ in range(50):
            status_payload = client.get(f"/api/jobs/{job_id}").json()
            if status_payload["status"] in {"completed", "completed_with_warnings", "failed"}:
                break
            time.sleep(0.02)
        assert status_payload["status"] == "completed"
        assert status_payload["download_ready"] is True

        results = client.get(
            f"/api/jobs/{job_id}/results",
            params={"gender": "Feminino", "search": "007", "sort_by": "name"},
        )
        assert results.status_code == 200
        assert results.json()["filtered_total"] == 1
        assert results.json()["items"][0]["bib"] == "007"

        download = client.get(f"/api/jobs/{job_id}/download")
        assert download.status_code == 200
        assert download.content[:2] == b"PK"


def test_api_rejects_external_url(tmp_path) -> None:
    application = create_app(Settings(temp_dir=tmp_path, cleanup_interval_seconds=600))
    with TestClient(application) as client:
        response = client.post("/api/scrape", json={"url": "https://example.com/evento/teste/"})
    assert response.status_code == 400
    assert "domínio" in response.json()["detail"].lower()


def test_api_rate_limits_job_creation(tmp_path, sample_result) -> None:
    class FakeScraper:
        def __init__(self, settings):
            pass

        async def scrape(self, url, progress):
            return sample_result

    settings = Settings(
        temp_dir=tmp_path,
        cleanup_interval_seconds=600,
        rate_limit_requests=1,
        rate_limit_window_seconds=600,
    )
    application = create_app(settings, scraper_factory=FakeScraper)
    payload = {"url": "https://openresults.run/evento/corrida-teste-2026/"}
    with TestClient(application) as client:
        assert client.post("/api/scrape", json=payload).status_code == 202
        limited = client.post("/api/scrape", json=payload)
    assert limited.status_code == 429
    assert int(limited.headers["retry-after"]) > 0


def test_untrusted_forwarded_for_does_not_bypass_rate_limit(tmp_path, sample_result) -> None:
    class FakeScraper:
        def __init__(self, settings):
            pass

        async def scrape(self, url, progress):
            return sample_result

    app = create_app(
        Settings(
            temp_dir=tmp_path,
            database_path=tmp_path / "proxy.sqlite3",
            cleanup_interval_seconds=600,
            rate_limit_requests=1,
            trust_proxy_headers=False,
        ),
        scraper_factory=FakeScraper,
    )
    payload = {"url": "https://openresults.run/evento/corrida-teste-2026/"}
    with TestClient(app) as client:
        assert client.post("/api/scrape", json=payload, headers={"X-Forwarded-For": "198.51.100.1"}).status_code == 202
        limited = client.post("/api/scrape", json=payload, headers={"X-Forwarded-For": "198.51.100.2"})
    assert limited.status_code == 429


def test_cors_does_not_allow_unlisted_origin(tmp_path) -> None:
    application = create_app(Settings(temp_dir=tmp_path, cleanup_interval_seconds=600))
    with TestClient(application) as client:
        preflight = client.options(
            "/api/scrape",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "POST",
            },
        )
    assert "access-control-allow-origin" not in preflight.headers
