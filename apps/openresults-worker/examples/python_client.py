"""Cliente mínimo da API scraper-openresults.

Uso:
    python examples/python_client.py https://openresults.run/evento/slug/
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import httpx


API_BASE = os.getenv(
    "SCRAPER_OPENRESULTS_API",
    "https://scraper-openresults-gustavomf-ykn.onrender.com",
).rstrip("/")
TERMINAL = {"completed", "completed_with_warnings", "failed"}


def main() -> int:
    if len(sys.argv) != 2:
        print("Informe uma URL https://openresults.run/evento/<slug>/")
        return 2
    event_url = sys.argv[1]
    with httpx.Client(base_url=API_BASE, timeout=120) as client:
        health = client.get("/healthz")
        health.raise_for_status()
        accepted = client.post(
            "/api/results/scrape",
            json={"scope": {"mode": "single", "url": event_url}},
        )
        accepted.raise_for_status()
        job_id = accepted.json()["job_id"]
        print(f"Trabalho: {job_id}")

        while True:
            response = client.get(f"/api/jobs/{job_id}")
            response.raise_for_status()
            job = response.json()
            print(f"{job['progress']:>3}% {job['status']}: {job['stage']}")
            if job["status"] in TERMINAL:
                break
            time.sleep(2)

        if job["status"] == "failed":
            print(job.get("error") or "Falha sem detalhe")
            return 1
        if not job.get("download_ready"):
            print("Concluído sem arquivo; consulte os avisos.")
            print("\n".join(job.get("warnings", [])))
            return 0

        download = client.get(f"/api/jobs/{job_id}/download")
        download.raise_for_status()
        disposition = download.headers.get("content-disposition", "")
        filename = "openresults_resultados.zip" if "zip" in download.headers.get("content-type", "") else "openresults_resultados.xlsx"
        if "filename=" in disposition:
            filename = disposition.split("filename=", 1)[1].strip('"; ')
        path = Path(filename)
        path.write_bytes(download.content)
        print(f"Salvo em {path.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
