from __future__ import annotations

from datetime import date, datetime, timezone
from pathlib import Path

import pytest

from app.models import EventMetadata, ExtractionResult, ModalityInfo


@pytest.fixture
def fixture_dir() -> Path:
    return Path(__file__).parent / "fixtures"


@pytest.fixture
def sample_result() -> ExtractionResult:
    metadata = EventMetadata(
        name="CORRIDA TESTE 2026",
        event_date=date(2026, 7, 25),
        city="Florianópolis",
        state="SC",
        source_url="https://openresults.run/evento/corrida-teste-2026/",
        slug="corrida-teste-2026",
        expected_total=2,
    )
    modality = ModalityInfo("5k", "5k", {"F": 1, "M": 1})
    extracted_at = datetime(2026, 8, 3, 14, 30, tzinfo=timezone.utc)
    base = {
        "event": metadata.name,
        "event_date": metadata.event_date.isoformat(),
        "city": metadata.city,
        "state": metadata.state,
        "modality": "5k",
        "modality_value": "5k",
        "distance_km": 5.0,
        "overall_position": 1,
        "category_position": None,
        "category": "F1829",
        "category_code": "F1829",
        "team": "",
        "pace": "05:47",
        "time": "00:28:59",
        "gap": "",
        "source_url": metadata.source_url,
        "extracted_at": extracted_at.isoformat(),
    }
    female = {**base, "gender": "Feminino", "bib": "007", "name": "ANA ÁVILA"}
    male = {
        **base,
        "gender": "Masculino",
        "bib": "18",
        "name": "BRUNO SOUZA",
        "overall_position": 1,
        "category": "M3039",
        "category_code": "M3039",
        "time": "00:25:00",
    }
    return ExtractionResult(
        metadata=metadata,
        modalities=[modality],
        records=[female, male],
        expected_total=2,
        extracted_total=2,
        by_gender={"Feminino": 1, "Masculino": 1},
        by_group={"5k | Feminino": 1, "5k | Masculino": 1},
        warnings=[],
        extracted_at=extracted_at,
    )
