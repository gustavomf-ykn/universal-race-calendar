> Registro histórico arquivado em 19/10/2026. Descreve evidências e decisões da época, não o estado atual nem uma autorização para executar comandos. Para retomar, leia [CONTINUITY.md](../../CONTINUITY.md) e [AWS-HOSTING.md](../AWS-HOSTING.md). Credenciais, backups, logs privados e capturas não acompanham este arquivo.

# Catálogo nacional — progresso de 03/10/2026

Objetivo integral permanece ativo: percorrer e reconciliar as partes publicamente acessíveis das três fontes, cruzar informações e manter atualização semanal operável pelo painel. Cobertura 100% e operação semanal real ainda não comprovadas.

## Alterações enviadas

- Backend PR #12: `76061230944a1b19d930dddb3934de3b4191b7f4` implementa cruzamento global durável; `8aae0975218330cdf719999b49a55ad9e5916bfe` acrescenta prioridade compartilhada da fila.
- Frontend PR #3: `93054b5e689a000dfdfa0d42c2c9739023cf63ed` acrescenta controles de cruzamento; `0d66591fe48e277851552fa13ebfea3b9af0e6e0` impede indicar espera histórica em tarefas encerradas.
- Branches próprias, sem reescrever história. PRs permanecem em rascunho. Nenhum merge, deploy ou publicação.

## Cruzamento global

Início explícito pelo administrador, paginação de ciclos/decisões/candidatos, pausa/retomada/cancelamento, snapshot de criação, cursor/versão e continuidade em etapas pequenas. Apenas um ciclo não terminal; replay idempotente conserva pedido original. União de grupo de até três registros exige links reconhecidos de edição e compatibilidade de todos os pares; nome/homepage/fingerprint são sugestões para revisão, nunca identificação suficiente. Grupo conflitante não sofre união parcial.

Resultado, união, alias, auditoria, decisão e cursor são confirmados atomicamente sob lease. Registros depois do snapshot e alterações posteriores em registros já percorridos requerem nova varredura. O snapshot não congela todos os valores. Candidatos exibidos usam valores atuais; decisões mantêm histórico. Nenhuma consulta a fonte ou coleta de resultados pelo cruzamento.

Correções concretas: lock da tarefa antes do gate de união evita ordem inversa durante recuperação; hook genérico da API conserva schemas de parâmetros específicos, permitindo validar `action`; retry genérico de cruzamento é recusado para não copiar uma sequência antiga. Falha orienta controle do ciclo. Cancelamento exige nenhuma etapa running e conserva registros/histórico. RLS comprovado também com leitor explicitamente autorizado a SELECT, que não enxerga linhas operacionais.

Frontend salva motivo/chave por usuário antes do envio, congela payload após resposta incerta, coalesce cliques e permite reenviar a mesma intenção. Ciclo e tarefa têm estados distintos. Candidatos visuais abrem a união manual existente; término invalida consultas de calendário/detalhes/modalidades/resultados. Chave interna não entra no frontend.

## Seleção da fila

SQL compara todas as fontes elegíveis, evitando a precedência alfabética. Exportações classe 0; pedidos interativos classe 1; etapas nacionais/lotes classe 2. Após 15 minutos, elegíveis antigos passam à classe 0. Não é preempção ou SLA: estoque antigo e tarefa atual ainda podem atrasar novos pedidos. Idade nunca libera hold, bloqueio, delay ou seleção por IDs. Preservadas exclusão por fonte e conjunta dos executores TS, recuperação de lease e rejeição do token vencido. Clientes TypeScript e Python compartilham a mesma decisão PostgreSQL.

## Validações e falhas iniciais

Banco sintético local `race_global_catalog_test`, loopback `127.0.0.1:55436`. Quatro migrations novas desta rodada aplicadas somente nele: cruzamento, cancelamento, prioridade e correção de timestamp. Total local 26; repetição do comando não reaplicou migrations. A correção de timestamp foi adicional, sem editar checksum aplicado. Inicializador/preflight verifica o helper correto. Nenhuma migration Supabase.

Primeira suíte completa local do cruzamento: 295 aprovados/5 falhas, incluindo dois timeouts de 30s, parâmetros action descartados, fixture de falha que ainda tinha retry e dist anterior à correção de locks. Corrigidos e recompilados. As cinco suítes afetadas passaram com 51 testes; dois checks finais confirmaram linha sintética de resultado preservada e RLS com conteúdo. Prazo local maior para a máquina não altera o timeout versionado. CI completo posterior usa timeout normal e passou.

CI backend `7606123`: https://github.com/gustavomf-ykn/universal-race-calendar/actions/runs/37158754253 . Jobs test111307541769/containers111307541867 terminais sucesso, logs conferidos: 301 TypeScript/40 arquivos, 204 Python/1 externo desmarcado/1 aviso, lint/tipos/build/OpenAPI, preflights/lifecycle, três imagens/processos, 24 migrations repetidas e Chromium. Saída queue_empty comprova apenas encerramento dos batches, não coleta real.

CI frontend `0d66591`: https://github.com/gustavomf-ykn/runfinder-rithmy/actions/runs/37158721895 . Job111307442764 sucesso e logs conferidos: 38 testes, tipos e build. Lint dos arquivos alterados e build também locais. Não é aceite no navegador publicado.

Primeira rodada da prioridade teve 10 aprovados/9 falhas pela assinatura TIMESTAMP incompatível com TIMESTAMPTZ da tabela de fila. Corrigida por migration adicional. Rodada final: 19 testes/3 arquivos aprovados, incluindo cliente Python real adquirindo tarefa sintética sem acessar fonte, holds/circuitos/seleção, concorrência e fencing. Tipos/lint/sintaxe do launcher e preflight local aprovados. CI do HEAD backend `8aae097` em acompanhamento: https://github.com/gustavomf-ykn/universal-race-calendar/actions/runs/37159283873 . O CI verde de `7606123` não valida automaticamente esse commit posterior.

## Ambiente e próximos passos

Sem credenciais protegidas de staging acessadas nesta rodada, coleta real, runner coletor, consumo da fila staging, alteração de tarefas protegidas, controle dos executores independentes do usuário, Supabase migration, agenda, contratação ou produção. Processos próprios de testes/build concluíram; PostgreSQL local de testes permanece disponível. Não houve validação autenticada no navegador nem nova consulta das versões publicadas. Nenhuma mudança desta rodada foi publicada pelo agente.

Documentação das branches: `docs/CATALOG-RECONCILIATION.md`, `docs/QUEUE-PRIORITY.md`, `docs/NATIONAL-CATALOG.md`, `docs/LOVABLE-INTEGRATION.md` e OpenAPI; frontend `docs/CATALOG-RECONCILIATION.md`. Plano completo: `PLANO-COBERTURA-E-ATUALIZACAO-SEMANAL.md` na raiz do workspace.

Continuam executáveis: limites locais de memória/disco, agenda persistida com fuso/concorrência/consolidação offline e controles no painel; revisão/CI dos commits finais. Depois, integração autorizada em staging na ordem migrations → API/executores → frontend. Finalmente pilotos seletivos, varredura real progressiva das três fontes/27 UFs/histórico, conciliação de todos os IDs observados, cruzamento real, exportação aberta e aceite no navegador. Habilitar agenda depende de autorização própria e acompanhamento da primeira ocorrência real. Não declarar cobertura total por número solicitado, limite atingido, CI verde ou fila vazia.

## CI final e estado confirmado

CI do HEAD backend `8aae0975218330cdf719999b49a55ad9e5916bfe` aprovado: run37159283873, jobs111309131412/111309131523 terminais sucesso, logs conferidos. 308 TypeScript/41 arquivos, 204 Python/1 externo desmarcado/1 aviso; lint/tipos/build/OpenAPI, preflights/lifecycle de duas partidas/paradas/rejeição de inicializador duplicado/heartbeat ocioso, três imagens/processos, 26 migrations repetidas sem pendência e Chromium. Batches queue_empty comprovam somente saída. O status em acompanhamento acima é o registro anterior, substituído por esta conferência final.

Frontend final `0d66591` permanece aprovado com 38 testes/tipos/build. PR12/PR3 atualizados e ainda abertos/em rascunho. Checkouts limpos após envio. Remotos main confirmados sem mudança: backend `ecbbe898ae9c71b7523a58813a3a0c5e2c778a0b`, frontend `49643f893d6e1d046250b6fb022576e02523b34c`. Serviços publicados não atualizados pelo agente. Nenhum consumidor de staging iniciado. Meta integral permanece ativa, ainda sem comprovação de cobertura total ou rotina semanal.

## Rodada posterior: recursos locais e relógio semanal

Estado enviado: Backend `9580b68f9976adff97f0dcca9b53b5a93d7edeb8`, seguido por correção/cálculo `d21540b63bc2b1732cf7d68de97c3f4314ed5ef5`; Frontend `9ba0f9b7d3a3ac962d6e5df792f743f9cf408fc0`. PR12/PR3 seguem abertos/em rascunho, sem integração ou publicação. Commits anteriores/CI acima são históricos e não validam estes HEADs.

Proteção TS/Python antes de aquisição/etapas/requisições/Chromium/planilhas. Métricas fixas sanitizadas; limites validados de memória disponível, disco temporário/trabalho e RSS (Python inclui descendentes). Cgroups Linux conferidos quando visíveis; medição desconhecida não autoriza aquisição. Presença resource_wait distinta de executor desconectado. Durante tarefa, função PostgreSQL retém queued/hold sem gastar tentativa, preserva progress/checkpoint/resultados e exige lease válido. Liberação administrativa auditada; não automática. Resumo autenticado expõe só motivo. São medições periódicas, não reserva de RAM ou hard limit imposto pelo SO.

Migrations aditivas local_resources/local_resources_checkpoint aplicadas/repetidas somente em PostgreSQL local `race_global_catalog_test`, total 28. Segunda conserva campos persistidos do progress; não editado checksum aplicado. Regressão confirma ACL sem EXECUTE PUBLIC/anon/authenticated. Inicializador verifica schema e psutil; adia smoke quando recursos insuficientes, sem chamar navegador validado. XLSX selecionados dividem partes por linhas/conteúdo textual, conservando cabeçalhos/estilos/linhas, com teto de artefato; workbook ainda em memória.

Validação local final: 18 testes TS em quatro arquivos, incluindo subprocessos próprios reais TS/Python em espera, claimed=0, tarefa sintética inalterada e parada normal; 35 Python de recursos/capacidade/planilhas; 41 frontend; 7 relógio semanal. Build/tipos/lint/OpenAPI aprovados. Banco sintético e seleção de IDs; nenhum consumidor de staging iniciado. O primeiro teste de presença falhou 401 porque o comando não tinha INTERNAL_API_KEY de teste; corrigido no ambiente sintético, sem relaxar autorização. Primeira execução Python teve fixtures de capacidade interceptadas por disco real baixo e erros do tmp_path padrão; testes de capacidade passaram a isolar a política específica, mantendo regressões reais de pressão, e basetemp novo verificado dentro do workspace. Uma execução Vitest foi bloqueada na leitura de diretório ancestral pelo sandbox; execução autorizada posterior aprovou.

CI intermediário `9580b68`, run37162182688: job containers111317722987 aprovado, 28 migrations repetidas, três imagens/processos e smoke real Chromium com RSS de descendentes medido. Job test111317723105 falhou no preflight: regprocedure não desserializável pelo Prisma. Reproduzido localmente com saída sanitizada, corrigido com cast para text, preflight local posterior aprovado. CI do HEAD `d21540b`: run37162551681, jobs111318816419/111318816545 em acompanhamento neste registro; não repetir workflow sem falha terminal. Frontend `9ba0f9b`: CI37162203569/job111317785641 aprovado, logs conferidos com 41 testes/tipos/build.

Cálculo semanal puro implementado/testado: America/Sao_Paulo, segunda 08:00 proposta, semana local, ocorrência exata, horário inexistente/repetido e consolidação offline. Não persiste configuração, enfileira ou habilita agenda. Próxima implementação: persistência/locks/unicidade por versão/ocorrência, coordinator e acompanhamento pelo painel. Escopo continua três fontes/27 UFs/histórico/IDs/cruzamento e aceite real, sem redefinir cobertura em função dos testes.

Medição real local posterior: 1000 MiB livres, abaixo da margem padrão 1024 MiB; motivo local_disk_limit. Antes de coleta com os novos executores, liberar espaço suficiente (recomendável ao menos 2 GiB livres para folga inicial) sem apagar dados/backups automaticamente. Isso não bloqueia desenvolvimento/CI descartável, mas não deve ser contornado baixando a margem. Nenhum Chromium real local iniciado sob pressão.

Nenhuma credencial protegida de staging acessada, task protegida alterada, fonte externa consultada, coleta de runner, migration Supabase, agenda, merge/deploy/publicação/contratação/produção. Executores independentes do usuário não controlados. PostgreSQL local próprio segue disponível; subprocessos de regressão encerrados. Docs novas: backend/ frontend LOCAL-RESOURCES e backend CATALOG-WEEKLY. Meta integral permanece ativa.

### CI final da rodada de recursos

HEAD backend `d21540b63bc2b1732cf7d68de97c3f4314ed5ef5`: run37162551681 aprovado, jobs111318816419/111318816545 terminais sucesso, logs conferidos. 329 TypeScript/44 arquivos, 228 Python/1 externo desmarcado/1 aviso; lint/tipos/build/OpenAPI, preflights e lifecycle. Três imagens/processos, 28 migrations repetidas sem pendência, `local_resources_with_chromium_passed` e `chromium_launch_dom_javascript_passed`. Batches claimed=0/queue_empty não comprovam coleta. O registro anterior em acompanhamento foi substituído por esta verificação terminal, sem reiniciar o workflow.

Frontend `9ba0f9b7d3a3ac962d6e5df792f743f9cf408fc0`: run37162203569 aprovado com 41 testes/tipos/build. PRs abertos/em rascunho, HEADs e bases main conferidos pela API GitHub; main backend `ecbbe898ae9c71b7523a58813a3a0c5e2c778a0b`, frontend `49643f893d6e1d046250b6fb022576e02523b34c`. Nenhuma versão publicada alterada pelo agente. Checkouts enviados limpos nessa rodada anterior. PR12 atualizado com o CI final. Objetivo integral ativo.

## Rodada posterior: agenda persistida, ainda local

Backend com alterações locais não commitadas/enviadas sobre d21540b; frontend 9ba0f9b permanece sem alterações nesta rodada. Configuração semanal desativada, revisão/idempotência/auditoria, próxima ocorrência por fuso, histórico, unicidade/lock e consolidação offline. Coordenador contínuo TS cria atomicamente três ciclos/tarefas de descoberta; batch e seleção por IDs não criam agenda. Aguarda enriquecimento e cria um cruzamento único. Estados completos/parciais separados; coverageVerified/resultsCollected permanecem false. Desativar agenda acompanha o ciclo ativo sem criar outro; cancelamento recusa etapa running e conserva pedidos externos/dados/histórico. Novos retries/retomadas de ciclos cancelados são recusados.

Defeito concreto encontrado e corrigido: recibo terminal de cruzamento podia preceder confirmação da tarefa e causar sucesso semanal prematuro. Agora o coordenador também exige confirmação da fila, respeita holds e conserva falha/parcialidade sem lastSuccessAt.

Migration 20261004000000_catalog_weekly aplicada/repetida somente em race_global_catalog_test e banco novo race_weekly_catalog_test, ambos PostgreSQL loopback 127.0.0.1:55436; total 29. Sem reset ou importação antiga. Build, lint direcionado, OpenAPI exportado e preflight local aprovados. Suíte 20 testes/2 arquivos aprovada: 13 SQL/JWT e sete relógio, timeout versionado normal; concorrência, resposta perdida, capacidade/recursos, enriquecimento/holds, retry, cancelamento, autenticação 401/403/admin e algoritmo real de cruzamento contra catálogo sintético vazio. Nenhuma descoberta real ou cobertura nacional comprovada. CI dos commits anteriores não valida esta implementação local.

Controles de agenda no frontend, envio/revisão/CI do commit final, integração autorizada migrations/API/executores/frontend e testes reais de cobertura/cruzamento/navegador seguiam pendentes nessa rodada local anterior. Docs CATALOG-WEEKLY/NATIONAL-CATALOG/LOVABLE-INTEGRATION atualizadas. Nenhuma migration Supabase, agenda habilitada, fonte consultada, tarefa staging consumida, segredo protegido acessado, merge/deploy/publicação/serviço pago nessa rodada anterior. Não controlados executores independentes do usuário. PostgreSQL local próprio permanece disponível. Meta integral ativa, sem declaração de100%.

## Agenda concluída nas branches e inventário real somente leitura

Backend3274d04f99b381ac26b878a85d7ff41d1321a0ce implementa coordenador;224b47fcd75eb522c08c98ad032ffaf2f23708ed corrige distinção documental de branch/publicado. Frontend1fd8d93ec4732f8f580b2dde488de6b2377e4959 implementa controles;587cdefdee84cd9bf521d036943353dc8117f419 atualiza documentação. Checkouts nacionais enviados limpos; PR12/PR3 abertos/em rascunho/mergeable, main backendecbbe898ae9c71b7523a58813a3a0c5e2c778a0b e front49643f893d6e1d046250b6fb022576e02523b34c sem integração.

Formulário/admin/histórico/atraso/último ciclo sem falhas/UFs/fuso/limites, cancelamento do ciclo com motivo, revisão otimista e intenção persistida por usuário/operação/escopo/payload. Dados e chave congelados depois de resposta incerta, cliques coalescidos, replay relê configuração atual em vez de sobrescrever com snapshot antigo. Mensagens diferenciam estados/parcialidade/revisão e não afirmam cobertura/resultados novos. Horário usa explicitamente SaoPaulo. Nenhum segredo operacional entra no frontend; habilitação não acontece na publicação.

Defeitos concretos adicionais corrigidos: falha antiga do cruzamento recuperado não marca a tentativa vigente como falha; intervalo offline iniciado numa semana histórica conserva essa varredura; início semanal não segura capacidade antes do lock do início manual (evita inversão/deadlock); cancelamento bloqueia retries de metadados mesmo com descoberta já completed/limited, conservando seu recibo de sucesso. Testes agora26/2arquivos (19 SQL/JWT+7relógio), incluindo processos Node separados, pedido sintético externo500 intacto, RLS com conteúdo e SELECT concedido, cancelamento realJWT/metadataretry recusado e concorrência manual/semanal. Build/lint/tipos/OpenAPI/preflights/sintaxe aprovados.29 migrations locais, repetir não reaplicou.

CI final do backend224b47f: https://github.com/gustavomf-ykn/universal-race-calendar/actions/runs/37165833383 , jobs111328406322/test e111328406204/containers terminais sucesso, logs conferidos.348 TypeScript/45arquivos,228 Python/1externo desmarcado/1aviso; lint/tipos/build/OpenAPI, preflights, duas partidas/paradas do supervisor, rejeição de duplicado e heartbeat ocioso. Três imagens/processos,29migrations repetidas e local_resources_with_chromium_passed/chromium_launch_dom_javascript_passed. Batchesclaimed0/queue_empty comprovam só saída, não coleta. CI de código3274d04 também passou (37165530780), histórico anterior a documentação final.

CI frontend587cdef: https://github.com/gustavomf-ykn/runfinder-rithmy/actions/runs/37165839330 , job111328422422 terminal sucesso/logs conferidos,48 testes/tipos/build. Sete novos testes semanais; lint local dos arquivos alterados aprovado. CI do código1fd8d93 também passou (37165404442), histórico anterior a documentação final. Nenhum aceite autenticado no navegador.

Consulta pública /v1/version confirmou API91e9941c91ac7a4230ddd55ae3e11876aeb3c1d1, backend2.0.0/curadoria1.2.0/adaptadores1.0.0. Primeira tentativa restrita de rede não confirmou conexão; repetição permitida ao endpoint respondeu depois da espera. Não diagnosticada falha de API, não criado ping periódico.

Credenciais DPAPI existentes foram acessadas nesta rodada somente para inventário de staging, com validação de ref/host/porta/SSL e transação READ ONLY. Sem valores/impressão/commits de segredos. Resultado real:16 migrations concluídas; tabelas novas de agenda/capacidade ausentes;13aditivas do PR ainda não aplicadas. Dois queued protegidos, TicketSports120 ID5e8fe9d7-d889-4cd5-b427-972498115f2b e15 ID8278a9e1-9eaa-41ea-8e72-856d8b631665, semrunning; todas as presenças consultadas sem comunicação recente (últimas02/10). Não comprova inexistência de processo local sem comunicação. Não alterada nenhuma tarefa nem iniciados consumidores de staging.

Medição local atualizada1059840000bytes (~1011MiB) livres, abaixo1073741824 padrão; local_disk_limit. Memória disponível9966792704bytes. Liberar espaço com folga antes de coleta sem baixar proteção. Checkout operacional backend main limpo em arquivos rastreados, dois docs não rastreados preservados; arquivo DPAPI existe. Frontend operacional main limpo. Nenhum reset/limpeza.

Preparação concreta: INTEGRACAO-CATALOGO-STAGING-2026-10-03.md lista as13migrations e sequência backup/integração/schema/API/executores/frontend/capacidade/pilotos/aceite/carga progressiva. Aguarda autorização específica para novos PRs/migrations/atualização de homologação; autorizações anteriores dePR9/10/11não foram extrapoladas. Agenda permanece desativada, sem fonte externa consultada/coleta real/runner coletor/produção/contratação/merge/deploy/publicação. Meta integral ativa;100% e ocorrência semanal real não comprovadas.
