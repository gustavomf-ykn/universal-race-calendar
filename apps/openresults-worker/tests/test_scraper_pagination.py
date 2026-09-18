from datetime import date, datetime, timezone
from urllib.parse import parse_qs, urlsplit

import pytest

from app.config import Settings
from app.models import EventDiscovery, EventMetadata, EventSummary, ModalityInfo
from app.services.parser import parse_result_rows
from app.services.scraper import OpenResultsScraper
from app.storage import SQLiteStorage


class FakeClient:
    async def get_endpoint_page(self, url: str, referer: str):
        offset = int(parse_qs(urlsplit(url).query)["offset"][0])
        rows = [
            '<tr><td>1</td><td>F1829</td><td>007</td><td>ANA</td><td></td><td>05:00</td><td>00:25:00</td><td></td></tr>',
            '<tr><td>2</td><td>F3039</td><td>008</td><td>BEA</td><td>TIME</td><td>06:00</td><td>00:30:00</td><td>00:05:00</td></tr>',
        ]
        return {
            "ok": True,
            "recordsTotal": 2,
            "recordsFiltered": 2,
            "nextOffset": min(offset + 1, 2),
            "hasMore": offset < 1,
            "html": rows[offset] if offset < 2 else "",
        }


@pytest.mark.asyncio
async def test_fetch_group_walks_all_endpoint_pages() -> None:
    settings = Settings(endpoint_page_size=1)
    scraper = OpenResultsScraper(settings)
    metadata = EventMetadata("Teste", date(2026, 1, 1), "Cidade", "SC", "https://openresults.run/evento/teste/", "teste", 2)
    modality = ModalityInfo("5k", "5k", {"F": 2})
    discovery = EventDiscovery(
        metadata,
        [modality],
        "https://openresults.run/ajax_resultados_evento.cfm?id_evento=1",
        ["Geral", "Cat.", "Número", "Nome", "Equipe", "Pace", "Tempo", "Gap"],
    )
    rows, expected, warnings = await scraper._fetch_group(
        FakeClient(), discovery, discovery.endpoint_url, modality, "F", datetime.now(timezone.utc)
    )
    assert expected == 2
    assert warnings == []
    assert [row["bib"] for row in rows] == ["007", "008"]


@pytest.mark.asyncio
async def test_persistent_group_resumes_from_saved_offset(tmp_path) -> None:
    settings = Settings(endpoint_page_size=1)
    scraper = OpenResultsScraper(settings)
    metadata = EventMetadata(
        "Teste", date(2026, 1, 1), "Cidade", "SC",
        "https://openresults.run/evento/teste/", "teste", 2, event_id="1",
    )
    modality = ModalityInfo("5k", "5k", {"F": 2})
    discovery = EventDiscovery(
        metadata, [modality], "https://openresults.run/ajax_resultados_evento.cfm?id_evento=1",
        ["Geral", "Cat.", "Número", "Nome", "Equipe", "Pace", "Tempo", "Gap"],
    )
    storage = SQLiteStorage(tmp_path / "resume.sqlite3")
    await storage.start()
    stored = (
        await storage.upsert_events(
            [EventSummary("Teste", date(2026, 1, 1), "Cidade", "SC", metadata.source_url, "teste", event_id="1")]
        )
    )[0]
    await storage.create_job("job", "results", {"mode": "single"})
    row = storage.event_row_to_dict(await storage.get_event_by_catalog_id(stored.catalog_id))
    await storage.add_job_events("job", [row])
    first = parse_result_rows(
        '<tr><td>1</td><td>F1829</td><td>007</td><td>ANA</td><td></td><td>05:00</td><td>00:25:00</td><td></td></tr>',
        discovery.result_headers, metadata, modality, "F", datetime.now(timezone.utc),
    )
    first[0]["event_id"] = "1"
    await storage.insert_results("job", "1", first)
    await storage.upsert_group(
        "job", stored.catalog_id, "5k", "5k", "F",
        status="partial", next_offset=1, expected_total=2, extracted_total=1,
    )

    class TrackingClient(FakeClient):
        offsets = []

        async def get_endpoint_page(self, url: str, referer: str):
            self.offsets.append(int(parse_qs(urlsplit(url).query)["offset"][0]))
            return await super().get_endpoint_page(url, referer)

    client = TrackingClient()
    extracted, expected, warnings = await scraper._fetch_group_persistent(
        client, discovery, discovery.endpoint_url, modality, "F", datetime.now(timezone.utc),
        job_id="job", catalog_id=stored.catalog_id, event_id="1", storage=storage,
    )
    assert client.offsets == [1]
    assert extracted == expected == 2
    assert warnings == []
    assert await storage.result_count("job") == 2
    checkpoint = await storage.get_group("job", stored.catalog_id, "5k", "F")
    assert checkpoint["status"] == "completed"
    await storage.close()
