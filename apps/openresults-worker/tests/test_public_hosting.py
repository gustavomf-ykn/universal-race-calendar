from datetime import datetime, timezone
from pathlib import Path

from app.config import Settings
from app.services.jobs import JobManager, JobRecord
from app.services.rate_limit import SlidingWindowRateLimiter


def test_rate_limiter_releases_key_after_window() -> None:
    now = [100.0]
    limiter = SlidingWindowRateLimiter(2, 60, clock=lambda: now[0])
    assert limiter.check("client") == (True, 0)
    assert limiter.check("client") == (True, 0)
    allowed, retry_after = limiter.check("client")
    assert allowed is False
    assert retry_after > 0
    now[0] = 161.0
    assert limiter.check("client") == (True, 0)


def test_job_manager_enforces_global_pending_limit(tmp_path) -> None:
    manager = JobManager(Settings(temp_dir=tmp_path, max_queued_jobs=1))
    manager.jobs["running"] = JobRecord(
        id="running",
        source_url="https://openresults.run/evento/teste/",
        status="running",
        updated_at=datetime.now(timezone.utc),
    )
    assert manager.has_capacity() is False
    manager.jobs["running"].status = "completed"
    assert manager.has_capacity() is True


def test_pages_frontend_targets_public_render_api() -> None:
    root = Path(__file__).parents[1]
    page = (root / "pages" / "index.html").read_text(encoding="utf-8")
    script = (root / "app" / "static" / "app.js").read_text(encoding="utf-8")
    assert 'content="https://scraper-openresults-gustavomf-ykn.onrender.com"' in page
    assert 'src="./static/app.js"' in page
    assert 'meta[name="api-base"]' in script
    assert "apiUrl(`/api/jobs/${state.jobId}/download`)" in script
