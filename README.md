# Universal Race Calendar API

API universal para transformar paginas de eventos de corrida de rua/trail em dados canonicos, confiaveis e simples de consumir por sites, apps e calendarios.

O catalogo usa duas fontes reais: TicketSports como fonte prioritaria e CorridasBR como fonte independente para provas ausentes. A IA continua opcional; parsers deterministicos sustentam importacao, deduplicacao e publicacao.

## Stack

- TypeScript, Node.js e pnpm workspaces
- Fastify REST API
- Zod para contratos
- Prisma + PostgreSQL
- Vitest
- Docker Compose
- GitHub Actions

## Rodando localmente

Requisitos: Node.js 22 e pnpm 9.

```bash
corepack enable
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm dev:api
```

Por padrao, `.env.example` usa:

```bash
AI_PROVIDER=mock
```

Isso permite rodar o pipeline completo sem API paga.

## API basica

```bash
curl http://localhost:3000/health
curl http://localhost:3000/v1/events
curl -H "X-API-Key: dev-internal-key" http://localhost:3000/v1/sources
```

Cadastrar uma fonte mock:

```bash
curl -X POST http://localhost:3000/v1/sources \
  -H "Content-Type: application/json" \
  -H "X-API-Key: dev-internal-key" \
  -d '{"name":"Corrida Mock","url":"mock://corrida-floripa","type":"registration_page","country":"BR","state":"SC","city":"Florianopolis"}'
```

Executar check:

```bash
curl -X POST -H "X-API-Key: dev-internal-key" http://localhost:3000/v1/sources/{sourceId}/check
```

O retorno ja tem formato de job, mesmo no MVP sincrono:

```json
{
  "jobId": "job_123",
  "status": "success",
  "eventId": "evt_123",
  "sourceId": "src_123",
  "createdAt": "2026-06-23T00:00:00.000Z",
  "finishedAt": "2026-06-23T00:00:01.000Z",
  "reasons": []
}
```

## Scripts

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm db:migrate
pnpm dev:api
pnpm --filter @race-calendar/worker check-source <sourceId>
pnpm --filter @race-calendar/worker curate:ai --limit=10 --dry-run
pnpm --filter @race-calendar/worker audit:curation
pnpm --filter @race-calendar/worker import-ticketsports --quantity=25
pnpm --filter @race-calendar/worker import-corridasbr --states=SP,RJ --quantity=25
```

## Deploy de produto

O caminho simples para teste com site real e dados persistentes e:

- Neon Postgres para o banco.
- Render Web Service para a API.
- GitHub Actions para importacao recorrente TicketSports -> CorridasBR.

No Neon, configure duas connection strings:

```bash
DATABASE_URL="postgresql://...-pooler.../neondb?sslmode=require"
DIRECT_URL="postgresql://.../neondb?sslmode=require"
```

No Render, crie um Web Service apontando para este repositorio:

```bash
Build Command: pnpm install --frozen-lockfile --prod=false && pnpm db:generate && pnpm db:migrate && pnpm build
Start Command: pnpm start:api
Health Check Path: /health
```

Env vars recomendadas no Render:

```bash
NODE_ENV=production
DATABASE_URL=...
DIRECT_URL=...
INTERNAL_API_KEY=...
CORS_ORIGINS=*
AI_PROVIDER=mock
AI_CURATION_ENABLED=false
AI_CURATION_REQUIRED=false
TICKETSPORTS_IMPORT_QUANTITY=1000
TICKETSPORTS_IMPORT_CONCURRENCY=3
TICKETSPORTS_IMPORT_DELAY_MS=300
TICKETSPORTS_IMPORT_QUICK_FILTER=corrida-de-rua
CORRIDASBR_IMPORT_QUANTITY=5000
CORRIDASBR_IMPORT_CONCURRENCY=2
CORRIDASBR_IMPORT_DELAY_MS=500
OFFICIAL_PAGE_ENRICHMENT_ENABLED=true
```

Para curadoria real com NVIDIA NIM, troque as variaveis da IA no Render:

```bash
AI_PROVIDER=nvidia-nim
AI_BASE_URL=https://integrate.api.nvidia.com/v1
AI_API_KEY=...
AI_MODEL=nvidia/llama-3.3-nemotron-super-49b-v1.5
AI_CURATION_ENABLED=true
AI_CURATION_REQUIRED=false
```

Se o plano gratuito nao liberar o modelo Nemotron Super, use `meta/llama-3.3-70b-instruct`.

Depois do deploy, configure estes secrets no GitHub:

```bash
PRODUCTION_API_BASE_URL=https://sua-api.onrender.com
PRODUCTION_INTERNAL_API_KEY=mesmo-valor-do-INTERNAL_API_KEY
```

Para importar o catalogo completo, rode **Catalog Import** na aba Actions. TicketSports sempre e processada primeiro; CorridasBR cria provas ausentes ou e vinculada como fonte complementar. Para consumir na vitrine:

```bash
curl "https://sua-api.onrender.com/v1/events?from=today&limit=100"
curl "https://sua-api.onrender.com/v1/events?sourceType=corridasbr&from=today&limit=100"
```

Para vitrines publicas, prefira `display.*`, especialmente `display.primaryAction`. A resposta tambem inclui `sources`; preco, lote, distancia e kit sem evidencia ficam ausentes.

O Blueprint [`render.yaml`](render.yaml) cria `universal-race-calendar-v2` no plano gratuito. Nesse plano a migration roda no build, porque o pre-deploy command do Render e pago. Valide primeiro com uma branch/backup Neon, atualize os secrets do GitHub e as URLs da vitrine/admin, e mantenha o servico anterior por 48 horas.

O workflow **Catalog Import** executa a importacao em lotes para evitar uma unica requisicao longa. O artifact `catalog-import-results` contem o resumo agregado e os JSONs de cada lote. Use o input `force=true` quando quiser reaplicar mudancas de parser/curadoria em eventos cujo conteudo bruto nao mudou.

## Site teste

Existe uma vitrine estatica em `apps/site`. Ela consome a API publica de producao por padrao:

```bash
start apps/site/index.html
```

Para apontar para outra API:

```text
apps/site/index.html?api=http://localhost:3000
```

## Auditoria minima

Endpoints internos para acompanhar qualidade e importacao:

```bash
curl -H "X-API-Key: dev-internal-key" "http://localhost:3000/v1/audit/events?publicationStatus=pending_review"
curl -H "X-API-Key: dev-internal-key" "http://localhost:3000/v1/imports/ticketsports/latest"
curl -H "X-API-Key: dev-internal-key" "http://localhost:3000/v1/audit/curation-summary"
curl -H "X-API-Key: dev-internal-key" "http://localhost:3000/v1/admin/catalog-summary"
```

## Simulacao de catalogo

```bash
curl -X POST http://localhost:3000/v1/admin/import-runs \
  -H "X-API-Key: dev-internal-key" -H "Content-Type: application/json" \
  -d '{"mode":"simulate","sources":["ticketsports","corridasbr"],"states":["SP"],"from":"today","candidateLimit":100,"enrichOfficialPages":true}'

curl -X POST -H "X-API-Key: dev-internal-key" \
  -H "Content-Type: application/json" -d '{"limit":25}' \
  http://localhost:3000/v1/admin/import-runs/{runId}/process
```

Detalhes de proveniencia, deduplicacao e operacao estao em [`docs/MULTI_SOURCE_CATALOG.md`](docs/MULTI_SOURCE_CATALOG.md).

## Curadoria IA

Por padrao a producao continua segura com `AI_CURATION_ENABLED=false`, usando os parsers deterministicos da TicketSports, CorridasBR e paginas oficiais. Para testar a camada nova sem alterar eventos:

```bash
AI_PROVIDER=mock pnpm --filter @race-calendar/worker curate:ai --limit=10 --dry-run
```

Para usar um endpoint real compativel com OpenAI Chat Completions:

```bash
AI_CURATION_ENABLED=true
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://seu-provider.example/v1
AI_API_KEY=...
AI_MODEL=...
```

Para NVIDIA NIM:

```bash
AI_CURATION_ENABLED=true
AI_PROVIDER=nvidia-nim
AI_API_KEY=...
AI_MODEL=nvidia/llama-3.3-nemotron-super-49b-v1.5
```

Use `AI_CURATION_REQUIRED=true` apenas quando eventos sem curadoria IA/cache valido devem ficar em `pending_review`.
