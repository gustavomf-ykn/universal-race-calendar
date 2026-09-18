# Operação do backend unificado

## Processos e autoridade dos dados

Fastify serve HTTP; `apps/worker/src/queue.ts` executa TicketSports/CorridasBR/curadoria; `apps/openresults-worker/worker.py` executa OpenResults e XLSX. Nenhum worker inicia FastAPI. A interface Python antiga foi incorporada como compatibilidade histórica, não é publicada pelos containers novos.

PostgreSQL é a autoridade de eventos, edições, referências, resultados e tarefas. Prisma é a única autoridade de migrations. Supabase Auth emite JWT; Fastify verifica assinatura/JWKS, issuer, audience e expiração. Administrador exige `app_metadata.role=admin`, definido pelo servidor Auth; `user_metadata` não confere privilégios. Storage usa bucket privado `race-exports` e URLs assinadas por até 60 segundos.

Cada Event representa uma edição. IDs externos ficam em EventSourceReference. ResultSet identifica a edição na fonte; RaceDiscipline e RaceResult pertencem ao conjunto. Nome de atleta não cria identidade global. Somente identificação exata e mesma data permitem associação automática; semelhança fica em revisão. Uma mudança de ano em um ID já usado é rejeitada para proteger a edição anterior.

## Desenvolvimento local

Requisitos: Node 22, pnpm 9.15.4, Python 3.12, PostgreSQL 16+; Docker Compose é opcional. Na raiz:

```sh
cp .env.example .env
pnpm install --frozen-lockfile
pnpm db:generate
docker compose -f compose.backend.yaml up -d postgres
# Carregue .env no ambiente do shell antes dos comandos seguintes.
pnpm db:migrate
pnpm build
python -m venv .venv
# Linux: . .venv/bin/activate; Windows: .venv\Scripts\Activate.ps1
pip install -r apps/openresults-worker/requirements-worker.txt
python -m playwright install chromium
pnpm start:api
# Outro terminal, com o mesmo ambiente:
pnpm start:worker
# Terceiro terminal, com o mesmo ambiente:
cd apps/openresults-worker
python -m worker
```

Exporte as variáveis de `.env` no shell para Prisma, Node e Python; os comandos de pacote executam em diretórios diferentes. Use o gerenciador de processos ou `node --env-file=.env ...` para Node. O worker Python não carrega automaticamente um arquivo `.env`. Sem Docker, crie o banco `race_backend_test` em seu PostgreSQL e ajuste as três URLs.

Alternativa em containers, após criar `.env`:

```sh
docker compose -f compose.backend.yaml build
docker compose -f compose.backend.yaml up -d postgres
docker compose -f compose.backend.yaml run --rm api pnpm db:migrate
docker compose -f compose.backend.yaml up -d api calendar-worker results-worker
```

Esse compose é **somente local** e sobrescreve as URLs para o serviço `postgres`. Não o use para apontar para produção. Resultados e coletas funcionam com PostgreSQL local; login Supabase e exportações exigem projeto/bucket isolado configurado, ou o servidor simulado da suíte integrada.

## Variáveis

| Variável | Uso | Exposição |
|---|---|---|
| DATABASE_URL | Prisma/API/worker TS; SSL em ambiente remoto | segredo de servidor |
| DIRECT_URL | migrations; conexão direta ou session pooler | segredo de servidor |
| WORKER_DATABASE_URL | psycopg; URI libpq, sem `?schema=public` | segredo de servidor |
| SUPABASE_URL | issuer/JWKS e Storage | pública |
| SUPABASE_SERVICE_ROLE_KEY | upload/limpeza/assinatura de artefatos | segredo de servidor |
| INTERNAL_API_KEY | scheduler e administração interna; use valor aleatório | segredo de servidor |
| CORS_ORIGINS | origens exatas do painel, separadas por vírgula | configuração |
| GIT_SHA | commit da imagem; Render usa RENDER_GIT_COMMIT | pública |
| AI_* | curadoria opcional; padrão mock/desativado | API key secreta |

Apenas SUPABASE_URL e a chave publicável Supabase entram na Lovable. Chaves de clientes externos são retornadas uma vez, persistidas como SHA-256, revogáveis e limitadas por hora no banco. Não são chaves administrativas. Não enviar secrets em query strings.

## Supabase e implantação, na ordem

1. Criar projeto de **homologação** e guardar credenciais fora do Git. Ativar chave JWT assimétrica ES256 ou RS256. HS256 legado não é aceito.
2. Configurar as três URLs com SSL e credencial backend privilegiada. Usar conexão direta/session para workers e migrations; não usar transaction pooler para este primeiro deploy. RLS não substitui autorização Fastify.
3. Executar `pnpm db:migrate` explicitamente em homologação. A migration SQL habilita RLS/revoga anon/authenticated nas tabelas públicas; este backend pressupõe projeto dedicado. As funções da fila não permitem execução por PUBLIC. O backend usa papel proprietário/BYPASSRLS; nunca compartilhar essa credencial.
4. Verificar bucket privado `race-exports`, criado pela migration quando schema Storage existe. Se migrou primeiro PostgreSQL comum e depois o transferiu, reaplicar somente o SQL idempotente de `20260918000200_storage/migration.sql` no projeto Supabase. Não abrir políticas públicas no bucket.
5. Implantar as imagens `Dockerfile.backend` (API e worker TS com comandos distintos) e `apps/openresults-worker/Dockerfile.worker` (Python). API porta 3000 atrás de HTTPS. Configurar reinício automático, logs e limites de memória/CPU. Não iniciar os servidores antigos.
6. Criar usuário de teste Supabase e atribuir `app_metadata.role=admin` pela administração Auth. Testar usuário comum e admin, inclusive token expirado e acesso direto negado pelo PostgREST.
7. Executar o roteiro integrado da Lovable com uma prova, concorrência 1. Confirmar XLSX no bucket privado, URL assinada, expiração e persistência após reinício. Esse teste em Supabase real ainda não foi executado nesta entrega.
8. Validar backup/restauração e procedimentos de MIGRATIONS.md antes de decidir corte de produção. Migrations não rodam no build Render; auto deploy está desativado. Nada nesta tarefa autoriza o corte.
9. Depois do deploy aprovado, ajustar secret `PRODUCTION_API_BASE_URL` do GitHub para o serviço correto e `PRODUCTION_INTERNAL_API_KEY`. Conferir os nomes efetivos no workflow. Só `catalog-import.yml` tem agendamento diário 08:17 UTC; os outros workflows são manuais. Cada chamada responde 202 e encerra; progresso está na API.

## Fila e recuperação

Estados: queued, running, completed, partial, failed, cancelled. Tentativas padrão 3; espera exponencial 60/120 segundos e teto 30 minutos. Lease 90 segundos; heartbeat 20 segundos; limite total de execução 30 minutos. Uma tarefa por fonte; TicketSports, CorridasBR e maintenance são serializados entre si para proteger o calendário. OpenResults e exports podem rodar em paralelo.

Aquisição usa locks transacionais e `SKIP LOCKED`; token de lease protege commits permanentes. Execução é pelo menos uma vez, com operações idempotentes. Em falha ou contagem incompleta, o último ResultSet válido permanece. Tarefa parcial é terminal e exige inspeção antes de nova solicitação com outra Idempotency-Key. Reutilizar a chave repete a resposta original; trocar payload com a mesma chave retorna 409.

Se um processo morrer, o novo worker recupera tarefas após expirar o lease. Não mude manualmente o token de um worker vivo. Cancelamento pela API só é permitido enquanto queued. Interrupção emergencial de tarefa running: parar o processo, investigar, aguardar lease; o supervisor pode reiniciar e reprocessar. Bloqueios/limitações explícitos OpenResults encerram as tentativas; não há bypass de CAPTCHA ou desafios.

Progresso comum tem stage, percent ou processed/failed/requested; catálogo inclui runId para consultar candidatos. ErrorCode é sanitizado. Logs de falhas não devem incluir resultados nominais, tokens ou payloads brutos.

## Retenção

Eventos e resultados permanecem até ação administrativa deliberada; não têm TTL. Exclusão de CollectionTask não apaga ResultSet/RaceResult. Exportações expiram 24h após solicitação; API deixa de assinar imediatamente. Worker percorre artefatos expirados em lotes e apaga objetos, inclusive uploads órfãos de leases antigos. Se Storage ficar indisponível, acesso continua expirado e limpeza física será repetida. Histórico operacional recomendado: 30 dias; chave de idempotência deixa de existir quando o histórico é removido.

Limpeza controlada, com workers ativos e sem remover tarefas queued/running:

```sql
DELETE FROM "ApiUsage" WHERE "window" < now() - interval '48 hours';
DELETE FROM "CollectionTask" WHERE status IN ('completed','partial','failed','cancelled')
  AND "finishedAt" < now() - interval '30 days';
```

Os registros ExportArtifact são mantidos para permitir nova varredura de uploads tardios. Não apagar resultados nem a edição ao fazer manutenção de tarefas.

## Diagnóstico e rollback

`GET /health` verifica processo, não banco. `GET /v1/version` identifica SHA e backendVersion=2.0.0; compare com imagem/branch antes de disparar coletas. `/docs` e `/v1/openapi.json` documentam o serviço.

404 em rota existente: conferir API_BASE_URL, proxy, SHA e serviço antigo versus v2. 500: correlacionar horário/ID da requisição com logs do servidor e status das migrations; não atribuir automaticamente ao parser. Os logs históricos disponíveis não permitem afirmar a causa dos incidentes de 18/09.

Backlog parado: verificar processos, conectividade, permissões das funções SQL, lease e availableAt. Falhas repetidas da fonte: interromper novas solicitações, respeitar o prazo da fonte e usar fixture para diagnosticar parser. Não aumentar concorrência para contornar bloqueio.

Rollback de aplicação: parar workers, manter backup, reinstalar imagem anterior **compatível com schema**, verificar versão e leitura antes de retomar. As migrations novas são aditivas; não executar DROP como rollback automático. O código antigo faz importação dentro do HTTP, então não reativar seus cron jobs. Reversão de banco exige restauração ensaiada em outro banco e corte explícito.
