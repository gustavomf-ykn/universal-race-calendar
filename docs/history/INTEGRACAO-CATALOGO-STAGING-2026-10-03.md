> Registro histórico arquivado em 19/10/2026. Descreve evidências e decisões da época, não o estado atual nem uma autorização para executar comandos. Para retomar, leia [CONTINUITY.md](../../CONTINUITY.md) e [AWS-HOSTING.md](../AWS-HOSTING.md). Credenciais, backups, logs privados e capturas não acompanham este arquivo.

# Integração do catálogo nacional — preparada, aguardando autorização

Estado histórico de 03/10. A autorização e a integração posteriores estão registradas em [INTEGRACAO-CATALOGO-STAGING-2026-10-07.md](INTEGRACAO-CATALOGO-STAGING-2026-10-07.md).

Somente race-platform-staging, ref sggrijhyblejlgimgzzc. Não autoriza produção, contratação, coleta em massa, schedules GitHub, autostart ou pings para manter a API acordada. A agenda semanal permanece desativada na integração; sua habilitação será uma decisão separada após pilotos reais.

## Versões e evidências atuais

| Componente | Estado conferido |
|---|---|
| Backend PR #12 | 224b47fcd75eb522c08c98ad032ffaf2f23708ed; código 3274d04; aberto/rascunho/mergeable |
| CI backend | run37165833383, jobs111328406322/111328406204 aprovados e logs conferidos: 348 TS/45 arquivos, 228 Python/1 externo desmarcado/1 aviso, lint/tipos/build/OpenAPI/preflights/lifecycle, três imagens/processos, 29 migrations repetidas e Chromium |
| Frontend PR #3 | 587cdefdee84cd9bf521d036943353dc8117f419; código 1fd8d93; aberto/rascunho/mergeable |
| CI frontend | run37165839330/job111328422422 aprovado e logs conferidos: 48 testes/tipos/build |
| API publicada | /v1/version confirmou 91e9941c91ac7a4230ddd55ae3e11876aeb3c1d1, backend2.0.0, curadoria1.2.0, adaptadores1.0.0; ainda anterior ao catálogo nacional |
| Supabase | Inventário protegido somente leitura: 16 migrations concluídas; CatalogWeeklySchedule/CatalogCapacity ainda ausentes |
| Fila staging | Dois pedidos queued protegidos: TicketSports120 ID5e8fe9d7-d889-4cd5-b427-972498115f2b e TicketSports15 ID8278a9e1-9eaa-41ea-8e72-856d8b631665. Nenhum running e nenhuma presença recente. Isso não comprova que não exista um processo local sem comunicação |
| Checkouts operacionais | Backend main ecbbe898ae9c71b7523a58813a3a0c5e2c778a0b, dois documentos não rastreados a preservar; frontend main49643f893d6e1d046250b6fb022576e02523b34c limpo. Branches nacionais enviadas limpas |
| Recursos locais | Última medição1059840000 bytes livres (~1011 MiB), menor que1024MiB padrão; local_disk_limit. Memória disponível medida~9.3GiB. Liberar espaço com folga antes de coleta, sem reduzir margem para mascarar o problema |

URLs: https://github.com/gustavomf-ykn/universal-race-calendar/pull/12 ; https://github.com/gustavomf-ykn/runfinder-rithmy/pull/3 ; https://universal-race-calendar.onrender.com ; https://runfinder-rithmy.lovable.app . CI sintético/queue_empty não comprovam coleta ou aceite no navegador. Versão publicada do frontend ainda não foi identificada nesta rodada.

## Migrations aditivas conferidas

Treze adicionadas em relação à main, ausentes no inventário staging desta rodada. Não editar checksums, usar reset ou importar dados antigos. Prisma deploy reaplica somente as pendentes; depois repetir e comprovar ausência de novas aplicações.

1. 20261001000100_source_observations
2. 20261001000200_source_request_controls
3. 20261001000300_catalog_capacity
4. 20261001000400_result_checkpoints
5. 20261002000000_source_match_country
6. 20261002000100_event_reconciliation
7. 20261002000200_catalog_reconciliation
8. 20261002000300_catalog_reconciliation_cancel
9. 20261003000100_queue_priority
10. 20261003000200_queue_priority_timestamp
11. 20261003000300_local_resources
12. 20261003000400_local_resources_checkpoint
13. 20261004000000_catalog_weekly

## Ordem após autorização específica

1. Revalidar PRs/HEADs/CI/base, identidade/finalidade staging, fila e executores. Confirmar encerramento das janelas antigas; não controlar processos independentes sem autorização. Os dois pedidos protegidos permanecem protegidos e não serão coletados.
2. Preservar documentos locais e credenciais DPAPI ignoradas pelo Git. Preparar backup protegido do banco/schema e configurações pertinentes antes de migrations; nunca imprimir dados pessoais ou conexão. Conferir espaço também para o backup. Não transferir para produção.
3. Integrar Backend #12 e conferir CI/main/commit integrado. Atualizar checkout operacional por avanço normal, sem reset/limpeza/reescrever história.
4. Com credenciais protegidas existentes, validar novamente ref/SSL e aplicar migrations somente em staging; repetir comando e auditar tabelas/índices/constraints/RLS/ACL/funções/bucket privado. Até aqui nenhum consumidor é iniciado.
5. Atualizar explicitamente o Web Service existente no Render Free pelo commit integrado em main. Manter auto deploy desligado. Se o agente não tiver acesso ao dashboard, ação manual: serviço universal-race-calendar → Manual Deploy → Deploy latest commit, depois comparar /v1/version com o SHA integrado. Nenhum worker/banco/serviço pago no Render.
6. Preparar Node/Prisma/build e dependências Python/Chromium no checkout atualizado, mantendo executores desligados. Reutilizar os secrets DPAPI existentes; não são necessárias novas credenciais para a agenda, cuja configuração fica no banco. Não copiar chaves administrativas ao frontend.
7. Integrar Frontend #3 somente após API compatível. Main conectada sincroniza o editor Lovable, mas não comprova publicação. Publicar explicitamente a atualização autorizada e identificar o artefato/versão efetivamente servido. CORS/origens e Supabase Auth existentes precisam ser conferidos, sem troca de secrets no chat.
8. Pelo painel JWT admin, medir/confirmar alocação de banco/Storage antes dos pilotos. Configuração de capacidade não libera tarefas antigas. Conferir agenda desativada; salvar desativada/recarregar/revisão antes de habilitar qualquer recorrência.
9. Informar as tarefas elegíveis e iniciar sessão seletiva aprovada para pilotos separados de até cinco candidatos por fonte. quantity/lote não equivalem a cinco registros novos. Validar IDs ausentes, persistência, atualizações, deduplicação e apresentação; repetir sem volume desnecessário. Não usar runners para coleta, contornar bloqueios ou retomar deliberadamente os pedidos protegidos.
10. Validar cruzamento real conservando edição/ano/local, resultados435 da edição indicada, coleta adicional somente com associação confiável e fonte acessível, exportação nova/XLSX ouZIP aberta, URL assinada/bucket privado, expiração e preservação. Separar teste controlado de falha/lease/idempotência de consultas reais.
11. No navegador autenticado: login, filtros/paginação/detalhes/resultados, administração visual, estados/holds/retries/cancelamento e download. Perda de resposta simulada deve reutilizar chave, sem repetir coletas reais.
12. Após pilotos, medir capacidade/duração e ampliar progressivamente a carga das três fontes, 27 UFs e histórico até reconciliar todos os IDs observados, com término verificável ou pendência explícita. Habilitar agenda somente por autorização própria e acompanhar primeira ocorrência real com os executores locais contínuos ativos.

## O que continua sem aceite

Cobertura total das fontes, cruzamento real das novas descobertas, publicação dos novos contratos, operação semanal real e uso autenticado dos controles novos no navegador. Não substituir esses critérios por CI verde, retorno202, fila vazia ou um lote limitado. Fallback DOM de resultados ainda não possui checkpoint por página; isso permanece distinto da descoberta nacional. Backups antigos/ensaio de migração seguem etapa separada, sem importação nesta integração.
