# Architecture

Fluxo principal:

```text
TicketSports ou fonte futura
-> SourceAdapter
-> RawSourceExtraction
-> AIProvider / MockAIProvider
-> RaceEventExtraction
-> validacao Zod
-> normalizacao
-> evaluatePublishability
-> dedupe fingerprint
-> CanonicalRaceEvent
-> banco
-> API publica
```

## Pacotes

- `packages/sources`: integracoes especificas, como `TicketSportsAdapter` e `MockSourceAdapter`.
- `packages/scraper`: HTTP client, timeout, retry, user-agent, limpeza de HTML, extracao de texto, links e hash.
- `packages/ai`: interface `AIProvider`, `MockAIProvider` obrigatorio e stubs nomeados para `OllamaProvider`, `OpenRouterProvider` e `GeminiProvider`.
- `packages/curation`: pipeline de curadoria, normalizacao, publicacao e execucao de check.
- `packages/schemas`: schemas Zod e tipos compartilhados.
- `packages/database`: Prisma schema, client e helpers de persistencia.
- `apps/api`: API REST publica e endpoints internos.
- `apps/worker`: CLI operacional simples.

## Status

`eventStatus` representa a corrida: `scheduled`, `postponed`, `cancelled`, `sold_out`, `finished`, `unknown`.

`publicationStatus` representa decisao editorial: `draft`, `pending_review`, `published`, `hidden`, `rejected`.

A API publica lista apenas eventos com `publicationStatus = published`.
