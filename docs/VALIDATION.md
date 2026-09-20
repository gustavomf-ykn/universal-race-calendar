# Validação — 18/09/2026

## Base e ambiente

Calendário original: 46 testes passaram antes da implementação. OpenResults original: 43 testes offline passaram; teste externo completo não foi executado. Não foi identificado defeito preexistente nas suítes offline. Commits e evidências dos incidentes estão em UNIFICATION-BASELINE.md.

Validação da integração em Windows, Node 24.17/Python 3.12 e PostgreSQL 18 local, banco `race_backend_test`. O [CI remoto](https://github.com/gustavomf-ykn/universal-race-calendar/actions/runs/35394825908) também passou com Node 22, PostgreSQL 16 e Ubuntu no commit `0073f7d`: migrations, lint, tipos, build, as duas suítes e estabilidade do OpenAPI. Os testes destrutivos exigem host local e nome de banco terminado em `_test`. Nenhum teste foi executado contra banco ou bucket de produção.

## Executado

- Build de todos os pacotes e processos TypeScript: passou.
- Typecheck de todos os pacotes: passou.
- ESLint: passou (assets Python legados e caches não fazem parte do lint TS).
- Vitest: **63 testes passaram**, em 10 arquivos, incluindo 14 cenários integrados do backend.
- Pytest offline: **46 passaram**, 1 teste externo completo não selecionado; dois avisos de depreciação de dependências do servidor FastAPI legado.
- OpenAPI 2.0.0 gerado: 48 operações, todas com schema de resposta. Rotas administrativas de compatibilidade mantêm campos JSON flexíveis para diagnósticos de provedores; endpoints principais têm contratos explícitos.
- Histórico Prisma aplicado no PostgreSQL isolado; schema e migrations novos versionados. Reexecução usa migrate deploy, sem reset.

A primeira tentativa Pytest deste ciclo encontrou permissões incompatíveis no diretório temporário/cache do Windows. A execução com diretório temporário novo passou, sem alterar ou desativar testes. Uma fixture antiga cruzava edições com datas diferentes; corrigida para representar a mesma edição futura, mantendo a exigência de data exata no código.

## Cenário integrado com fixtures

1. Importador TicketSports existente descobre/publica uma edição sintética.
2. API cria inspeção OpenResults; processo Python separado persiste a pendência.
3. Associação manual aceita mesma data e recusa a edição do ano seguinte.
4. Extração solicitada por HTTP retorna 202; processo separado grava modalidades/resultados permanentes. Repetição mantém um conjunto/uma linha da fixture.
5. Nova falha ou extração parcial preserva o hash do último resultado válido.
6. API key com hash/escopos permite consulta; acesso administrativo é negado. Revogação, limite horário compartilhado e isolamento de dono são exercitados.
7. JWT real assinado com chave ES256 de teste valida JWKS local; audience errada, expiração e tentativa de usar user_metadata como administrador são rejeitadas.
8. Exportação gera bytes XLSX e envia ao servidor Storage simulado. API é fechada/recriada e a conexão Prisma reiniciada; resultados e link continuam disponíveis.
9. Exportação expirada perde o link e seus objetos são removidos do Storage simulado. Remover histórico da tarefa não remove resultados.
10. Duas aquisições concorrentes só obtêm uma tarefa; lease antigo não consegue heartbeat/finalização.
11. Um processo Python é terminado de verdade com a tarefa em andamento; o lease é adiantado apenas no banco isolado para não esperar 90 s; novo processo conclui com attempt=2 e sem duplicação.
12. Cópia SQLite sintética passa por dry-run e duas aplicações: mesmo ResultSet, contagem correta, arquivo de origem inalterado.
13. Papel PostgreSQL sem privilégio de bypass não consegue ler resultados mesmo recebendo GRANT SELECT, pois RLS continua ativa.
14. Testes de rede cobrem IPs privados/reservados, URLs perigosas, resposta DNS mista, fixação do IP, nome TLS, limite de corpo e fórmulas em células XLSX.

Storage/Auth desta suíte são servidores de teste locais; isso não equivale a validar configurações de um projeto Supabase real.

## Consultas reais limitadas

Sem gravar no banco e sem coleta completa:

- TicketSports: listagem com `quantity=1`, HTTP 200 (617 bytes).
- CorridasBR: uma página de calendário SC, HTTP 200 (70.049 bytes).
- OpenResults: uma página de metadados da edição `37007`, data 25/07/2026, quatro modalidades, total informado de 435. Não foram extraídos nem persistidos os resultados individuais.

A amostra OpenResults identificou erro no tipo passado como TLS SNI; foi corrigido para string e a consulta real repetida com sucesso. Os dois endpoints Render citados excederam o timeout de 15 s em consulta GET de versão. Isso não confirma a causa dos 404/500 históricos nem distingue serviço inativo de cold start/rede; requer acesso aos logs/configuração do deploy.

## Ainda não validado / aceite externo

- Login e permissões no projeto Supabase real, bucket/RLS/PostgREST e URLs assinadas reais: executar roteiro RUNBOOK em homologação.
- Transferência dos bancos antigos: não havia cópias persistidas disponíveis. Mecanismo e ensaio sintético entregues; contagens/amostras reais ainda devem ser comparadas.
- Docker build e runtime Linux/Playwright: Docker não estava disponível neste host. Receitas entregues; validar imagens e fallback Chromium em homologação. O caminho HTTP foi consultado de verdade; o caminho Chromium endurecido não foi executado contra site real nesta tarefa.
- Smoke test completo com uma edição real, reinício de serviços hospedados e expiração no Storage real: pendente da infraestrutura.
- Causa raiz de incidentes Render: pendente de URL efetiva, SHA e logs do servidor.
- Busca geográfica filtra antes da paginação e não corta os primeiros 200 candidatos; nesta versão calcula em memória com campos mínimos. Para catálogo muito grande, mover distância para consulta geoespacial/indexada.
- Cancelamento de tarefas running, exportação ZIP e migração de histórico operacional antigo não entram no contrato unificado inicial.

Contratos e fluxo integrado estão validados localmente para iniciar o trabalho do painel. A liberação operacional em Supabase/Render depende dos passos externos acima; não foi declarada produção pronta.

## Atualização de 19/09/2026

No commit `73844eb`, 67 testes TypeScript e 47 Python passaram. O CI adicional construiu e executou as imagens reais, aplicou migrations duas vezes em PostgreSQL descartável, iniciou API e ambos os workers e lançou Chromium com verificação de DOM/JavaScript. A pendência anterior de build/smoke das imagens foi resolvida. O fallback no site real e o fluxo integrado no Supabase ainda aguardam configuração; acompanhe [STAGING.md](STAGING.md).

## Homologação Supabase real em 19/09/2026

As pendências históricas de Auth, banco, Storage e fluxo real acima foram executadas em `race-platform-staging` com aplicação `753b2ba`: 11 migrations (reexecução aprovada), auditoria de 26 tabelas, login e autorização reais, 435 resultados da edição TicketSports 74857/OpenResults 37007, exportação/download, repetição e recuperação de executor após 93 segundos. Expiração removeu arquivos sem remover resultados. CorridasBR foi validado separadamente com uma edição. Scripts reproduzíveis e IDs em [STAGING.md](STAGING.md).

Os processos conectados ao Supabase eram locais/nativos; o CI executou as imagens Docker e Chromium separadamente. Não há API hospedada homologada nem ensaio com backups antigos. Esses limites permanecem pendentes e não autorizam produção.

## Workers finitos — 19/09/2026

71 testes TypeScript e 54 Python passaram, além de build, tipos e lint. O novo ensaio local contra Supabase real aprovou fila vazia, limite de tarefas/duração, preservação do modo contínuo, coleta de 435 resultados, exportação após encerramento e recuperação dos dois executores na tentativa 2. IDs e tempos em STAGING.md. OpenAPI foi regenerado sem diferenças.

CI inclui build das imagens, início contínuo, Chromium e saída batch com fila vazia em banco descartável. Isso não substitui os workflows batch contra Supabase, cuja execução e medição completa no Actions dependem de Secrets/configuração externa. API Render remota também permanece pendente. Limites dos planos e do uso permitido do Actions: BATCH-HOSTING.md.
