# Universal Race Calendar API

API universal para transformar paginas de eventos de corrida de rua/trail em dados canonicos, confiaveis e simples de consumir por sites, apps e calendarios.

O MVP suporta TicketSports como primeira fonte real e `MockAIProvider` como provider padrao para desenvolvimento, testes e CI sem chave externa.

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
```
