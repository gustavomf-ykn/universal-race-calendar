# API

## Publicos

- `GET /health`
- `GET /v1/events`
- `GET /v1/events/:id`
- `GET /v1/events/slug/:slug`
- `GET /v1/events/nearby`
- `GET /v1/openapi.json`

`GET /v1/events` retorna apenas eventos publicados.

Filtros:

- `country`, `state`, `city`
- `from`, `to`
- `distanceMin`, `distanceMax`
- `modality`
- `status`
- `search`
- `sourceType`
- `page`, `limit`, `sort`

## Internos

Exigem `X-API-Key`.

- `GET /v1/sources`
- `POST /v1/sources`
- `POST /v1/sources/:id/check`
- `POST /v1/imports/ticketsports/run`
- `GET /v1/extraction-jobs/:id`

`POST /v1/sources/:id/check` responde como job mesmo quando executa sincrono.

Quando o conteudo nao mudou desde o ultimo check, o endpoint retorna `status = success`, `eventId = null` e `reasons = ["unchanged_content"]`.

`POST /v1/imports/ticketsports/run` descobre corridas de rua na TicketSports, cria/atualiza sources por `adapter + externalId`, roda o pipeline sincrono e retorna um resumo de importacao.
