from app.services.parser import deduplicate_records


def test_deduplicates_inside_same_group_but_preserves_other_modality() -> None:
    base = {"modality_value": "5k", "gender": "Feminino", "bib": "007", "name": "Ana", "time": "00:30:00"}
    other_modality = {**base, "modality_value": "10k"}
    records, duplicates = deduplicate_records([base, dict(base), other_modality])
    assert duplicates == 1
    assert len(records) == 2


def test_missing_bib_uses_safe_fallback() -> None:
    first = {"modality": "5k", "gender": "Feminino", "bib": "", "name": "Ana", "time": "00:30:00", "overall_position": 1}
    second = {**first, "overall_position": 2}
    records, duplicates = deduplicate_records([first, second])
    assert duplicates == 0
    assert len(records) == 2
