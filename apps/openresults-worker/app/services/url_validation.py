from __future__ import annotations

import ipaddress
import re
from urllib.parse import unquote, urljoin, urlsplit, urlunsplit

from app.models import URLValidationError


EVENT_PATH_RE = re.compile(r"^/evento/([^/]+)/?$", re.IGNORECASE)


def _validate_common(url: str, allowed_host: str) -> tuple[object, str]:
    try:
        parsed = urlsplit(url.strip())
    except (TypeError, ValueError) as exc:
        raise URLValidationError("A URL informada é inválida.") from exc

    if parsed.scheme.lower() != "https":
        raise URLValidationError("Use uma URL HTTPS do Open Results.")
    if parsed.username or parsed.password:
        raise URLValidationError("A URL não pode conter credenciais.")

    hostname = (parsed.hostname or "").lower().rstrip(".")
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        raise URLValidationError("Endereços IP não são permitidos.")

    if hostname != allowed_host:
        raise URLValidationError("O domínio permitido é openresults.run.")
    try:
        port = parsed.port
    except ValueError as exc:
        raise URLValidationError("A porta informada é inválida.") from exc
    if port not in (None, 443):
        raise URLValidationError("Portas personalizadas não são permitidas.")
    return parsed, hostname


def validate_event_url(url: str, allowed_host: str = "openresults.run") -> str:
    parsed, _ = _validate_common(url, allowed_host)
    decoded_path = unquote(parsed.path)
    match = EVENT_PATH_RE.fullmatch(decoded_path)
    if not match or match.group(1) in {".", ".."}:
        raise URLValidationError("A URL deve apontar para /evento/<nome-da-prova>/.")
    canonical_path = f"/evento/{match.group(1)}/"
    return urlunsplit(("https", allowed_host, canonical_path, "", ""))


def validate_internal_url(
    url: str,
    allowed_host: str = "openresults.run",
    *,
    base_url: str | None = None,
) -> str:
    absolute = urljoin(base_url or f"https://{allowed_host}/", url)
    parsed, _ = _validate_common(absolute, allowed_host)
    decoded_path = unquote(parsed.path)
    if not decoded_path.startswith("/") or ".." in decoded_path.split("/"):
        raise URLValidationError("O site informou um endereço interno inválido.")
    return urlunsplit(("https", allowed_host, parsed.path, parsed.query, ""))


def validate_redirect_url(
    location: str,
    current_url: str,
    allowed_host: str = "openresults.run",
    *,
    event_only: bool = False,
) -> str:
    target = validate_internal_url(location, allowed_host, base_url=current_url)
    if event_only and not EVENT_PATH_RE.fullmatch(unquote(urlsplit(target).path)):
        raise URLValidationError("O site redirecionou para uma página não permitida.")
    return target
