> Registro histórico arquivado em 19/10/2026. Descreve evidências e decisões da época, não o estado atual nem uma autorização para executar comandos. Para retomar, leia [CONTINUITY.md](../../CONTINUITY.md) e [AWS-HOSTING.md](../AWS-HOSTING.md). Credenciais, backups, logs privados e capturas não acompanham este arquivo.

# Runfinder: aceite operacional em homologação — 01/10/2026

Destino exclusivo: **race-platform-staging**, referência `sggrijhyblejlgimgzzc`. Este relatório substitui as pendências registradas em STAGING-PROGRESS-2026-09-30.md. Não constitui aprovação de produção nem cobertura completa das fontes.

## Versões e implantação

| Componente | Versão comprovada |
|---|---|
| API pública Render | `91e9941c91ac7a4230ddd55ae3e11876aeb3c1d1`, confirmado por `/v1/version`; `/health` 200 |
| Frontend publicado pela Lovable | `49643f893d6e1d046250b6fb022576e02523b34c`; sincronização/publicação verificadas, fluxos abaixo exercitados no site público |
| Backend main e executores locais | `ecbbe898ae9c71b7523a58813a3a0c5e2c778a0b`, merge do PR #11 |

PRs backend #9/#10 já integrados e API atualizada. PR #11 integrado após autorização específica; último commit revisado `4e96594e3e1c33113bb2cc9fae77f7a56c6156bd`, CI aprovado: https://github.com/gustavomf-ykn/universal-race-calendar/actions/runs/36804382273 . PR: https://github.com/gustavomf-ykn/universal-race-calendar/pull/11 . PR #11 altera migration, diagnóstico de Storage, testes e documentação; não exige novo deploy da API/frontend.

Migrations operacionais aplicadas em 25/09: `20260922000000_worker_presence`, `20260922000100_panel_catalog`, `20260922000200_administrative_review`, `20260924000000_selective_execution`. Em 01/10, aplicada `20261001000000_storage_zip`: adiciona MIME ZIP preservando bucket privado, demais formatos e limite 50 MiB. Segunda execução não reaplicou mudanças. Banco tem 16 migrations concluídas, sem reset/importação antiga. Backup de configuração efetivamente usado: `universal-race-calendar/.secrets/backups/storage-zip-20261001T135404Z/before.json`, SHA256 `a7341ae7f1e63289136c522e70244966623a60f68792676c9ffde389d41b8dcb`.

## Evidências e critérios

| Cenário | Tarefa/edição | Evidência observada | Situação |
|---|---|---|---|
| Lote real TicketSports | `67e76b79-7909-4673-b34c-2dc7207457bc` | 5 examinados, 1 nova prova, 4 existentes; concluída. Quantity não promete cinco novas provas | Aprovado |
| CorridasBR e continuação | `4a971dce-d3a7-43ed-931f-b9e3a28aab4d` | Pedido pelo painel; checkpoint 10→15; 5 novas provas, primeira tentativa. Processou candidatos reais já capturados, sem nova consulta externa | Aprovado |
| OpenResults independente | `evt_b94d925f5427ad6c39949b2f`, fonte 45590 | Garuva Run, 27/09/2026, Garuva/SC, identidade verificada; revisão/publicação pelo navegador, sem associação forçada | Aprovado |
| Nova extração pelo painel | `82a5b2a9-ceda-47e1-918b-6f66273cdc85` | Worker local: completed, tentativa 1, processed 387; painel atualizado. Antes/depois 387 e conteúdo equivalente: atualização bem-sucedida, sem dados novos | Aprovado |
| Resultados, filtros e paginação | Garuva; Mountain Do `evt_91fe44bc51e94cf6acf036b6` | 387 e 435 persistidos; Garuva 3KM: 113, página 1/6 no navegador; total 822 | Aprovado |
| Revisão/catálogo/detalhes | 34 provas, 9 publicadas, 25 pendentes | Navegador autenticado: filtros, seleção, detalhes e publicação; descobertas incompletas não publicadas automaticamente | Aprovado |
| Correção de dados CorridasBR | Nove tarefas listadas abaixo | Atualização pelo painel em grupos 5+4; datas/cidades corrigidas, pending_review preservado, primeira tentativa | Aprovado |
| Catálogo completo, todas as páginas | `fd23010e-495a-4a1d-953c-eb2200673a7a` | Filtro de 25 provas, maior que página 20; download no Chrome e arquivo aberto: 25 linhas, 19 colunas | Aprovado |
| Catálogo simples, todas as páginas | `2f455a3f-9007-44ae-826f-bdb7e43b5a35` | Pedido pelo painel, execução automática local, download no Chrome e arquivo aberto: 25 linhas, 9 colunas | Aprovado |
| Resultados individuais/ZIP | `de6113ea-cb9c-42db-9d6d-dc9012ff2b91`; artefato `83684a4a-8157-4481-914f-1ce952a50050` | Mesmo pedido recuperado após corrigir MIME; terceiro processamento concluiu. Download no Chrome, ZIP aberto: duas planilhas de 435+387 linhas, 19 colunas, cabeçalho em negrito, congelamento A2 | Aprovado |
| Histórico de exportações | Minhas exportações | Histórico recuperado do servidor; arquivo pronto, falhas e expiração diferenciados no navegador | Aprovado |
| Cancelamento controlado | `88176d82-df42-456c-8b45-3f99ee58e211` | queued→cancelled pelo painel; histórico preservado, nenhum pedido antigo cancelado | Aprovado |
| Repetição e idempotência | Exportação ZIP acima; testes frontend/API | Retry preservou tarefa/histórico; sete regressões frontend passaram, incluindo timeout/resposta perdida/cliques concorrentes com uma tarefa, persistência e isolamento das chaves. Simulações automatizadas; não houve interceptação de rede do navegador nem coletas repetidas desnecessárias | Aprovado |
| Auth/autorização/CORS | API e relatórios protegidos | Admin JWT permitido, ausência/token inválido/member negados; escopo insuficiente e revogação testados; preflight PATCH 204 nas duas origens com Authorization/Idempotency-Key; admin sem credencial 401 | Aprovado |
| Storage e expiração | race-exports | Privado, chave validada, XLSX/ZIP permitidos; download assinado 200, público sem assinatura 400. Testes controlados verificaram renovação/expiração de link, expiração do artefato sem apagar resultados | Aprovado |
| Recuperação por lease | Relatórios staging-recovery/staging-batch | Interrupções controladas TS/Python: recuperação ~92–93s na tentativa 2, executor antigo impedido de gravar; coleta parcial preservou resultados | Aprovado |
| Inicializador real Windows | Iniciar executores.cmd | Geração/build, deps Python, Chromium DOM/JavaScript, conexão e dois workers; presença ociosa real; segunda instância recusada; parada por sinal suportado observada e reconexão validada | Aprovado |

As evidências de navegador referem-se ao site público autenticado. Auditorias SQL/HTTP e abertura com openpyxl são verificações técnicas separadas. Os testes de falha/idempotência são controlados; não se apresentam como novas coletas reais. CI/Docker/Chromium não substituem os fluxos reais descritos.

## Correções e recuperação de dados

PR #9 corrigiu a extração CorridasBR para obter a cidade da própria linha, delimitando o contexto anterior. PR #10 corrigiu CORS para PATCH administrativo. PR #11 corrigiu configuração versionada do bucket para ZIP e diagnóstico de formatos.

Snapshot antigo CorridasBR `938a5e45cb0d3693a4e4d813cb866bd29111e78adcd8e78cbcf7389b1f0d5449`: 142 cidades corrigidas usando texto original da própria prova; 129 identidades conferidas com HTML posterior. Preservados 147 candidatos, ordem/identidade, datas, URLs e cursor. Backup protegido `checkpoint-city-20261001T020051Z`. Após continuação, cursor é 15: não restaurar backup do cursor 10 sobre progresso posterior.

Tarefas de metadados dos nove registros: `4a6c2fd2-13a2-4bf7-af3d-71873d5e7271`, `e8089fdc-06cb-4742-b591-3c03eb47d491`, `f5248057-eeff-4a14-b3c5-6cf602571996`, `887d0082-c965-4864-bd78-31d65282811a`, `20f2e49f-6d41-4c8f-99a8-b8fe51accf88`, `018fdef7-f914-4894-ba94-6f493f5f13c4`, `6387d6f7-eae7-415e-a543-c1f08b95338f`, `ac296e64-8453-4458-a83d-2738e57f23eb`, `d9cd973f-ca01-4520-8b26-1b8b357e47ec`. Maratona de Criciúma já havia sido corrigida pela tarefa `b7d44860-7176-48e9-832d-6cbde87a1c81`.

## Operação e pedidos preservados

| Pedido TicketSports | Quantidade | Estado final |
|---|---:|---|
| `5e8fe9d7-d889-4cd5-b427-972498115f2b` | 120 | queued, attempt 0, executionHold=true |
| `8278a9e1-9eaa-41ea-8e72-856d8b631665` | 15 | queued, attempt 0, executionHold=true |

Não foram processados, liberados ou cancelados. Fila elegível zero ao encerrar os testes. Não habilitados runners de coleta, agendamentos, auto deploy, serviços pagos ou autorun do Windows.

Inicializador: `<workspace>/universal-race-calendar\Iniciar executores.cmd`.

1. Abra esse arquivo uma vez; aguarde “Executores iniciados”. Se houver fila elegível, revise o escopo exibido antes de confirmar INICIAR.
2. Mantenha a janela e o computador ligados. Solicite coletas/planilhas no painel; não precisa de um comando por tarefa.
3. Para parar, Ctrl+C uma vez e aguarde a tarefa atual; a segunda interrupção força parada. A verificação desta rodada usou o arquivo de parada suportado, o mesmo mecanismo de encerramento dos workers, sem simular pressão física de Ctrl+C.

Logs sanitizados: `universal-race-calendar/.secrets/executors/operations.log`. Presence a cada 20s, desconexão após 75s sem heartbeat. Sem worker: calendário/resultados existentes continuam disponíveis, novas coletas/exportações aguardam, arquivos prontos não expirados ainda podem ser baixados. URL assinada até 60s; arquivo até 24h. Um novo link não recupera arquivo já expirado.

Estado final verificado em 01/10 às 14:27 UTC (11:27 de Brasília): ambos os executores disponíveis em `ecbbe898`, sem tarefa elegível; processos em árvore de janela CMD independente. Parada controlada às 14:23 foi refletida no navegador, reconexão às 14:25 também. Foram deixados ligados para uso cotidiano, sem sessão de ferramenta supervisionando sua vida útil. Isso não garante continuidade caso o usuário feche a janela ou o Windows suspenda/desligue. Captura: `executors-available-20261001.png`.

## Limites e parecer

Homologação operacional para o fluxo solicitado pelo painel. O catálogo é parcial: TicketSports limitado a snapshot de 250 candidatos, CorridasBR somente UFs consultadas, OpenResults páginas nativas. Há 25 provas aguardando revisão, não um defeito de paginação; o calendário público mostra somente as publicadas. Metadados não confirmados permanecem ausentes, nunca inventados.

O computador/janela precisam permanecer ligados e conectados; suspensão/encerramento do Windows interrompe execução. Render Free pode ter inicialização lenta; não foram configurados pings. Bloqueios externos devem falhar explicitamente e preservar resultados. Não há comprovação de prontidão de produção: executores locais, custos/capacidade, cobertura e ensaio dos dados antigos continuam sujeitos a uma etapa própria. Backups antigos não foram importados.

Documentos operacionais: `universal-race-calendar/docs/PANEL-OPERATIONS.md`, `docs/LOVABLE-INTEGRATION.md`, `docs/RUNBOOK.md`. Frontend usa somente API URL, Supabase URL e publishable key; jamais chave interna, credencial de banco ou secret privilegiado. Admin é validado por app_metadata.role no backend; alterações de papel exigem novo login/JWT.

Capturas: `exports-downloaded-20261001.png`, `executors-disconnected-20261001.png`, `njr-metadata-corrected-20261001.png`. Relatórios técnicos com credenciais protegidas permanecem em .secrets e não foram publicados.
