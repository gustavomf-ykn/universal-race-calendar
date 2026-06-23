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
- `GET /v1/imports/ticketsports/latest`
- `GET /v1/audit/events`
- `GET /v1/extraction-jobs/:id`

`POST /v1/sources/:id/check` responde como job mesmo quando executa sincrono.

Quando o conteudo nao mudou desde o ultimo check, o endpoint retorna `status = success`, `eventId = null` e `reasons = ["unchanged_content"]`.

`POST /v1/imports/ticketsports/run` descobre corridas de rua na TicketSports, cria/atualiza sources por `adapter + externalId`, roda o pipeline sincrono e retorna um resumo de importacao.

Parametros opcionais do corpo:

- `quantity`
- `offset`
- `concurrency`
- `delayMs`
- `quickFilter`
- `force`

`GET /v1/imports/ticketsports/latest` retorna o ultimo resumo persistido da importacao TicketSports, incluindo duracao e contadores.

`GET /v1/audit/events` lista eventos internos por `publicationStatus`, com `pending_review` como padrao. Retorna warnings, razoes de publicacao, dedupe e dados de origem para revisao.

## Producao

`GET /v1/events?sourceType=ticketsports&limit=100` e o endpoint principal para sites consumirem o catalogo publico inicial.

Em producao, `POST /v1/imports/ticketsports/run` deve ser chamado pelo workflow **Production Import** com:

- `PRODUCTION_API_BASE_URL`
- `PRODUCTION_INTERNAL_API_KEY`

O banco deve ser persistente. Reimportacoes da TicketSports atualizam eventos existentes por `sourceType + sourceExternalId`, criam nova `EventVersion` e evitam duplicar a API publica.

O workflow de producao chama o endpoint em lotes configuraveis por `chunk_size`, evitando uma unica requisicao longa. Use `force=true` quando uma mudanca de parser/curadoria precisar reprocessar eventos cujo HTML bruto nao mudou.
