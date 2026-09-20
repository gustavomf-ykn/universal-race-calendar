from datetime import datetime, timezone

from app.services.parser import parse_event_page, parse_result_rows


def test_discovers_event_modalities_totals_and_endpoint(fixture_dir) -> None:
    html = (fixture_dir / "event_page.html").read_text(encoding="utf-8")
    discovery = parse_event_page(html, "https://openresults.run/evento/corrida-teste-2026/")
    assert discovery.metadata.name == "CORRIDA TESTE 2026"
    assert discovery.metadata.city == "Florianópolis"
    assert discovery.metadata.state == "SC"
    assert discovery.metadata.expected_total == 6
    assert [item.value for item in discovery.modalities] == ["5k", "Trail 7,5 km"]
    assert discovery.modalities[0].expected_by_gender == {"F": 2, "M": 1}
    assert "id_evento=123" in discovery.endpoint_url


def test_parses_rows_without_inventing_category_position(fixture_dir) -> None:
    page = (fixture_dir / "event_page.html").read_text(encoding="utf-8")
    rows_html = (fixture_dir / "result_rows.html").read_text(encoding="utf-8")
    discovery = parse_event_page(page, "https://openresults.run/evento/corrida-teste-2026/")
    rows = parse_result_rows(
        rows_html,
        discovery.result_headers,
        discovery.metadata,
        discovery.modalities[0],
        "F",
        datetime(2026, 8, 3, tzinfo=timezone.utc),
    )
    assert len(rows) == 2
    assert rows[0]["bib"] == "007"
    assert rows[0]["name"] == "ANA ÁVILA"
    assert rows[0]["category"] == "F1829"
    assert rows[0]["category_position"] is None
    assert rows[0]["team"] == ""
