from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_openapi_and_api_information_are_public(tmp_path) -> None:
    app = create_app(Settings(temp_dir=tmp_path, database_path=tmp_path / "docs.sqlite3"))
    with TestClient(app) as client:
        info = client.get("/api")
        schema = client.get("/openapi.json")
        swagger = client.get("/docs")
        redoc = client.get("/redoc")
    assert info.status_code == 200
    assert info.json()["version"] == "2.0.0"
    assert info.json()["license"] == "MIT"
    assert schema.status_code == 200
    document = schema.json()
    assert document["info"]["license"]["name"] == "MIT"
    assert document["paths"]["/api/results/scrape"]["post"]["tags"] == ["Results"]
    assert document["paths"]["/api/scrape"]["post"]["deprecated"] is True
    assert swagger.status_code == redoc.status_code == 200


def test_repository_contains_self_hosting_documentation() -> None:
    root = Path(__file__).parents[1]
    required = [
        root / "LICENSE",
        root / "SECURITY.md",
        root / "CONTRIBUTING.md",
        root / "docs" / "API.md",
        root / "docs" / "DEPLOYMENT.md",
        root / "docs" / "QUICKSTART.md",
        root / "examples" / "python_client.py",
        root / "examples" / "javascript_client.mjs",
        root / "compose.yaml",
    ]
    assert all(path.is_file() and path.stat().st_size > 100 for path in required)
    api_docs = (root / "docs" / "API.md").read_text(encoding="utf-8")
    for route in (
        "/api/events/discover",
        "/api/events/metadata",
        "/api/results/scrape",
        "/api/jobs/{job_id}/resume",
        "/api/jobs/{job_id}/results",
        "/api/jobs/{job_id}/download",
    ):
        assert route in api_docs
