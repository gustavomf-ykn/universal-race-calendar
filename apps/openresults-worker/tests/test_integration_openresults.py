import os

import pytest

from app.config import Settings
from app.services.scraper import OpenResultsScraper


TEST_URL = "https://openresults.run/evento/2026-mountain-do-costao-do-santinho-2026/#resultado"


@pytest.mark.integration
@pytest.mark.asyncio
async def test_live_mountain_costao_expected_results() -> None:
    if os.getenv("RUN_OPENRESULTS_INTEGRATION") != "1":
        pytest.skip("Defina RUN_OPENRESULTS_INTEGRATION=1 para executar o teste externo.")
    result = await OpenResultsScraper(Settings()).scrape(TEST_URL)
    expected_groups = {
        "5k | Feminino": 52,
        "5k | Masculino": 39,
        "9k | Feminino": 94,
        "9k | Masculino": 66,
        "21k | Feminino": 52,
        "21k | Masculino": 83,
        "42k | Feminino": 5,
        "42k | Masculino": 44,
    }
    differences = {
        group: {"expected": expected, "actual": result.by_group.get(group, 0)}
        for group, expected in expected_groups.items()
        if result.by_group.get(group, 0) != expected
    }
    assert len(result.modalities) == 4, f"Modalidades atuais: {[item.name for item in result.modalities]}"
    assert not differences, f"Os totais do site mudaram: {differences}"
    assert result.extracted_total == 435, f"Total atual: {result.extracted_total}; grupos: {result.by_group}"
    assert not result.warnings, f"A extração completa gerou avisos inesperados: {result.warnings}"
    dedupe_keys = {
        (row["modality_value"], row["gender"], row["bib"], row["name"], row["time"])
        for row in result.records
    }
    assert len(dedupe_keys) == len(result.records)
    required = {"event", "modality", "gender", "overall_position", "category", "bib", "name", "time"}
    assert required.issubset(result.records[0])
