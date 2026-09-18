import pytest

from app.services.parser import clean_text, extract_distance_km, normalize_gender


@pytest.mark.parametrize(
    ("value", "expected"),
    [("5k", 5.0), ("21 km", 21.0), ("Trail 7,5 km", 7.5), ("Kids", None)],
)
def test_extract_distance(value: str, expected: float | None) -> None:
    assert extract_distance_km(value) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [("F", "Feminino"), ("feminina", "Feminino"), ("M", "Masculino"), ("masc", "Masculino")],
)
def test_normalize_gender(value: str, expected: str) -> None:
    assert normalize_gender(value) == expected


def test_clean_text_preserves_accents_and_removes_extra_spaces() -> None:
    assert clean_text("  ANA   ÁVILA\xa0 ") == "ANA ÁVILA"
