from __future__ import annotations

import asyncio
import random
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
from app.services.safe_network import bounded_get

from app.config import Settings
from app.models import (
    AccessBlockedError,
    EventNotFoundError,
    RequestFailedError,
    RequestTimeoutError,
    StructureChangedError,
)
from app.services.url_validation import validate_internal_url, validate_redirect_url


RETRYABLE_STATUS = {429, 500, 502, 503, 504}


class OpenResultsClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(settings.request_timeout),
            follow_redirects=False,
            trust_env=False,
            headers={
                "User-Agent": settings.user_agent,
                "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.5",
            },
        )

    async def __aenter__(self) -> "OpenResultsClient":
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.client.aclose()

    def update_cookies(self, cookies: dict[str, str]) -> None:
        self.client.cookies.update(cookies)

    async def _request(
        self,
        url: str,
        *,
        accept: str,
        referer: str | None = None,
        event_only: bool = False,
    ) -> httpx.Response:
        current_url = validate_internal_url(url, self.settings.allowed_host)
        headers = {"Accept": accept}
        if referer:
            headers["Referer"] = referer

        for redirect_count in range(self.settings.max_redirects + 1):
            response: httpx.Response | None = None
            last_error: Exception | None = None
            for attempt in range(self.settings.request_attempts):
                try:
                    response = await bounded_get(self.client, current_url, headers, self.settings.request_timeout)
                except TimeoutError as exc:
                    last_error = httpx.TimeoutException(str(exc))
                except httpx.TimeoutException as exc:
                    last_error = exc
                except httpx.RequestError as exc:
                    last_error = exc
                else:
                    if response.status_code not in RETRYABLE_STATUS:
                        break
                    if response.status_code == 429 and attempt == self.settings.request_attempts - 1:
                        raise AccessBlockedError(
                            "O Open Results limitou temporariamente as requisições. Tente novamente mais tarde."
                        )
                if attempt < self.settings.request_attempts - 1:
                    retry_after = response.headers.get("retry-after") if response is not None else None
                    try:
                        delay = float(retry_after) if retry_after else 0.5 * (2**attempt)
                    except ValueError:
                        delay = 0.5 * (2**attempt)
                    if delay > 30:
                        raise AccessBlockedError("A fonte solicitou espera longa; reagende manualmente após o prazo informado.")
                    await asyncio.sleep(max(0.0, delay) + random.uniform(0.05, 0.25))

            if response is None:
                if isinstance(last_error, httpx.TimeoutException):
                    raise RequestTimeoutError("O Open Results demorou demais para responder.") from last_error
                raise RequestFailedError("Não foi possível conectar ao Open Results.") from last_error

            if response.status_code in {301, 302, 303, 307, 308}:
                if redirect_count >= self.settings.max_redirects:
                    raise RequestFailedError("O site excedeu o limite seguro de redirecionamentos.")
                location = response.headers.get("location")
                if not location:
                    raise RequestFailedError("O site retornou um redirecionamento inválido.")
                current_url = validate_redirect_url(
                    location,
                    current_url,
                    self.settings.allowed_host,
                    event_only=event_only,
                )
                continue

            if response.status_code == 404:
                raise EventNotFoundError("O evento informado não foi encontrado.")
            if response.status_code in {401, 403, 429}:
                raise AccessBlockedError(
                    "O acesso foi bloqueado ou limitado pelo Open Results. Não tentaremos contornar a proteção."
                )
            if response.status_code >= 400:
                raise RequestFailedError(f"O Open Results retornou HTTP {response.status_code}.")
            return response

        raise RequestFailedError("Não foi possível concluir a requisição ao Open Results.")

    async def get_event_page(self, url: str) -> str:
        response = await self._request(url, accept="text/html", event_only=True)
        return response.text

    async def get_endpoint_page(self, url: str, referer: str) -> dict[str, Any]:
        response = await self._request(url, accept="application/json", referer=referer)
        try:
            payload = response.json()
        except ValueError as exc:
            raise StructureChangedError("O endpoint de resultados deixou de retornar JSON válido.") from exc
        if not isinstance(payload, dict):
            raise StructureChangedError("O endpoint retornou uma estrutura JSON inesperada.")
        return payload

    async def get_catalog_page(self, page: int) -> dict[str, Any] | str:
        url = (
            f"https://{self.settings.allowed_host}/api/eventos.cfm"
            f"?filtro=&page={max(1, int(page))}&distancia=0%2C99999&tempo=0%2C999"
        )
        response = await self._request(url, accept="application/json, text/html;q=0.9")
        content_type = response.headers.get("content-type", "").lower()
        if "json" in content_type:
            try:
                payload = response.json()
            except ValueError as exc:
                raise StructureChangedError("O catálogo deixou de retornar JSON válido.") from exc
            if not isinstance(payload, dict):
                raise StructureChangedError("O catálogo retornou uma estrutura inesperada.")
            return payload
        try:
            payload = response.json()
        except ValueError:
            return response.text
        return payload if isinstance(payload, dict) else response.text


def build_endpoint_url(
    endpoint_url: str,
    *,
    modality: str,
    gender: str,
    offset: int,
    limit: int,
    allowed_host: str = "openresults.run",
) -> str:
    safe_url = validate_internal_url(endpoint_url, allowed_host)
    parsed = urlsplit(safe_url)
    params = dict(parse_qsl(parsed.query, keep_blank_values=True))
    params.update(
        {
            "modalidade": modality,
            "genero": gender,
            "offset": str(offset),
            "limit": str(limit),
            "busca": "",
        }
    )
    for filter_name in ("categoria", "equipe", "termo"):
        if filter_name in params:
            params[filter_name] = ""
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(params), ""))


def payload_value(payload: dict[str, Any], name: str, default: Any = None) -> Any:
    wanted = name.casefold()
    for key, value in payload.items():
        if str(key).casefold() == wanted:
            return value
    return default
