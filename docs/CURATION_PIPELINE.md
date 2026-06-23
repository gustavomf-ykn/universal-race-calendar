# Curation Pipeline

O pipeline recebe `RawSourceExtraction` e produz `CanonicalRaceEvent`.

1. `AIProvider.extractRaceEvent` retorna `RaceEventExtraction`.
2. Zod valida o JSON.
3. Normalizacao converte datas, horarios, precos, distancias e URLs.
4. `evaluatePublishability` decide `publicationStatus`.
5. `generateEventFingerprint` cria base de deduplicacao.
6. O banco salva raw extraction, job, evento, relacoes e versao.

Antes da curadoria, o worker compara `contentHash` com `sources.lastHash`. Se o conteudo nao mudou, o job termina com `status = success`, `eventId = null` e `reasons = ["unchanged_content"]`, sem criar novo evento.

## Publishability

Publica automaticamente se:

- tem nome;
- tem data;
- tem cidade/estado/pais ou localizacao clara;
- tem `registrationUrl` ou `officialUrl`;
- `confidence >= AUTO_PUBLISH_MIN_CONFIDENCE`;
- nao tem warning critico.

Caso contrario, `publicationStatus = pending_review`.

## Versoes

Valores iniciais:

- `ADAPTER_VERSION_TICKETSPORTS=1.0.0`
- `CANONICAL_SCHEMA_VERSION=1.0.0`
- `CURATION_PIPELINE_VERSION=1.0.0`

## Deduplicacao inicial

O MVP gera `canonicalFingerprint` com nome normalizado, data, cidade, estado e pais. Se outro evento ativo tiver o mesmo fingerprint, o novo evento fica com `dedupeStatus = possible_duplicate`, `publicationStatus = pending_review` e `duplicateOfEventId` apontando para o primeiro evento.
