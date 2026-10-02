# Curation Pipeline

O pipeline recebe `RawSourceExtraction` e produz `CanonicalRaceEvent`.

1. Se `AI_CURATION_ENABLED=true`, `AIProvider.extractRaceEvent` retorna `RaceEventExtraction`.
2. Se existir cache por `contentHash + schemaVersion + curationVersion + provider + model`, o resultado validado e reutilizado e um `CurationJob` novo fica como `skipped_cached`.
3. Com `AI_CURATION_ENABLED=false`, TicketSports continua usando normalizacao deterministica.
4. `MockAIProvider` permanece obrigatorio para desenvolvimento, testes, CI e GitHub Actions sem chave externa.
5. Provider real usa `AI_PROVIDER=nvidia-nim` ou `AI_PROVIDER=openai-compatible` e endpoint `/chat/completions`.
6. Zod valida o JSON.
7. Normalizacao converte datas, horarios, precos, lotes, distancias e URLs.
8. `evaluatePublishability` decide `publicationStatus`.
9. `generateEventFingerprint` cria base de deduplicacao.
10. O banco salva raw extraction, extraction job, curation job, evento, relacoes e versao.

Antes da curadoria, o worker compara `contentHash` com `sources.lastHash`. Se o conteudo nao mudou, o job termina com `status = success`, `eventId = null` e `reasons = ["unchanged_content"]`, sem criar novo evento.

## Publishability

Publica automaticamente se:

- tem nome;
- tem data;
- tem país BR confirmado na extração;
- tem modalidade road/trail comprovada no título/texto da fonte;
- tem cidade não vazia, UF entre as 27 brasileiras e país BR; nome do local não substitui cidade/UF;
- tem `registrationUrl` ou `officialUrl`;
- tem referência reconhecida da edição em TicketSports, CorridasBR ou OpenResults, com identidade e UF compatíveis quando verificáveis;
- `confidence >= AUTO_PUBLISH_MIN_CONFIDENCE`;
- nao tem warning critico.

Caso contrario, `publicationStatus = pending_review`.

Curadoria 1.6.0 aplica os requisitos estruturais compartilhados com a publicação administrativa. Data impossível, cidade com navegação/caracteres corrompidos, UF inválida, homepage e URL de edição incompatível não permitem publicação. PATCH e rota antiga de publicação relêem edição e referências sob lock. Revisão manual pode confirmar modalidades fora do escopo automático com motivo e auditoria, mas não pode ignorar esses requisitos estruturais. Os campos propostos pelo modelo ainda precisam de validação completa de proveniência de data/localização; não tratar estrutura válida como prova de extração correta.

Curadoria 1.4.0 não classifica nomes genéricos (corrida, run, maratona), endereços com Rua/asfalto ou links de navegação como corrida de rua. Texto gerado pelo modelo não é evidência de modalidade. Rua+trail vira mixed para revisão; kids/walk/unknown também permanecem candidatos em revisão. Em edições mistas, modalidade de distância precisa de trecho presente na fonte com a quilometragem correspondente. Esses controles não completam a política de localização/referência nem os caminhos Python ainda em desenvolvimento. Não corrigem registros históricos em massa.

Warnings criticos iniciais incluem data/local conflitante e cidade suspeita. Na TicketSports, endereco que parece rua, avenida, parque ou venue sem cidade clara nao deve virar `city`; o evento fica para revisao.

Curadoria 1.5.0 também confere o país contra dados recebidos da fonte, independentemente do valor/citação propostos pelo modelo. `country_evidence_mismatch` é crítico; campos desconhecidos não ganham BR. CorridasBR preserva rótulos País/Country, sem usar UF/domínio como confirmação. Página oficial vinculada só confirma país via JSON-LD quando data/cidade/UF são compatíveis. Texto composto de páginas diferentes não confirma país. ISO com horário separado por T preserva o dia informado. Países/rótulos não reconhecidos ficam em revisão. Confirmação humana auditada é uma decisão administrativa, não uma alteração da observação original.

Distancias extraidas de texto sao canonizadas por quilometragem. Variantes como `5K`, `5 km` e `5 Km` viram uma unica distancia `5 km`.

A API publica monta um objeto `display` conservador. Precos, lotes, distancias, kits e localizacao so entram em `display` quando ha evidencia e confianca suficiente; dados duvidosos seguem disponiveis apenas em endpoints internos/admin para auditoria.

## Versoes

Valores iniciais:

- `ADAPTER_VERSION_TICKETSPORTS=1.0.0`
- `CANONICAL_SCHEMA_VERSION=1.0.0`
- `CURATION_PIPELINE_VERSION=1.6.0`

## Dry-run e batch

Comandos:

```bash
pnpm --filter @race-calendar/worker curate:ai --event-id=<id> --dry-run
pnpm --filter @race-calendar/worker curate:ai --limit=10 --dry-run
pnpm --filter @race-calendar/worker curate:ai --limit=25
pnpm --filter @race-calendar/worker curate:ai --force --limit=25
pnpm --filter @race-calendar/worker curate:ai --only=not_curated --limit=50
pnpm --filter @race-calendar/worker audit:curation
```

Endpoints internos:

```bash
POST /v1/curation/events/:id/run
POST /v1/curation/events/batch
GET /v1/curation/jobs/:id
GET /v1/audit/curation-summary
```

O dry-run cria `CurationJob` com `isDryRun=true` e diff estruturado, mas nao altera o evento.

## Deduplicacao inicial

O MVP gera `canonicalFingerprint` com nome normalizado, data, cidade, estado e pais. Se outro evento ativo tiver o mesmo fingerprint, o novo evento fica com `dedupeStatus = possible_duplicate`, `publicationStatus = pending_review` e `duplicateOfEventId` apontando para o primeiro evento.
