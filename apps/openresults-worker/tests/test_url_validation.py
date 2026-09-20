import pytest

from app.models import URLValidationError
from app.services.url_validation import validate_event_url, validate_redirect_url


def test_accepts_and_canonicalizes_event_url() -> None:
    assert validate_event_url(
        "https://openresults.run/evento/minha-prova/?modalidade=5k#resultado"
    ) == "https://openresults.run/evento/minha-prova/"


@pytest.mark.parametrize(
    "url",
    [
        "http://openresults.run/evento/prova/",
        "https://evil.example/evento/prova/",
        "https://dev.openresults.run/evento/prova/",
        "https://127.0.0.1/evento/prova/",
        "https://openresults.run:8443/evento/prova/",
        "https://user:pass@openresults.run/evento/prova/",
        "https://openresults.run/ranking/",
        "https://openresults.run/evento/../ranking/",
    ],
)
def test_blocks_unsafe_urls(url: str) -> None:
    with pytest.raises(URLValidationError):
        validate_event_url(url)


def test_blocks_external_redirect() -> None:
    with pytest.raises(URLValidationError):
        validate_redirect_url(
            "https://evil.example/steal",
            "https://openresults.run/evento/prova/",
            event_only=True,
        )
