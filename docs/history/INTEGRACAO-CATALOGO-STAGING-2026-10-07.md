> Registro histórico arquivado em 19/10/2026. Descreve evidências e decisões da época, não o estado atual nem uma autorização para executar comandos. Para retomar, leia [CONTINUITY.md](../../CONTINUITY.md) e [AWS-HOSTING.md](../AWS-HOSTING.md). Credenciais, backups, logs privados e capturas não acompanham este arquivo.

# Integração do catálogo em homologação — 07/10/2026

Ambiente exclusivo: race-platform-staging, ref sggrijhyblejlgimgzzc. Este relatório substitui o estado de integração pendente registrado em 03/10. Nenhuma produção, contratação, agenda GitHub ou ping de manutenção foi alterado.

## Integração e publicação comprovadas

| Componente | Evidência |
|---|---|
| Backend #12 | Integrado em a8b360faa2b04224ba8b769035f6a425da3e9a34; checkout operacional atualizado preservando documentos locais |
| CI da main backend | [Execução 37704771030](https://github.com/gustavomf-ykn/universal-race-calendar/actions/runs/37704771030) aprovada: 348 testes TS, 228 Python, três imagens/processos, Chromium e migrations repetidas em banco sintético |
| Frontend #3 | Integrado em ebbabd4e991ac7af71f283389683c7539af7299c; árvore idêntica ao último commit aprovado do PR, 587cdefdee84cd9bf521d036943353dc8117f419 |
| CI frontend | Último CI do PR aprovado, 48 testes/tipos/build. Workflow executa em pull_request; não existe execução equivalente da main após merge |
| API Render Free | Deploy manual dep-db3dp5favr4c739btsg0 terminou Live. GET /v1/version confirmou exatamente a8b360faa2b04224ba8b769035f6a425da3e9a34; health 200. Auto deploy continua Off |
| Lovable | GitHub conectado a gustavomf-ykn/runfinder-rithmy, main, In sync. Publicação explícita terminou “Your website was updated”. Novos controles verificados no site publicado. Sem endpoint público de SHA do frontend para confirmação independente |
| Supabase | Backup público protegido por DPAPI antes das alterações; 13 migrations aditivas aplicadas, total 29 concluídas. Repetição sem pendências. Auditoria de 41 tabelas/RLS/ACL e preflights TS/Python aprovados |

PRs: [Backend #12](https://github.com/gustavomf-ykn/universal-race-calendar/pull/12), [Frontend #3](https://github.com/gustavomf-ykn/runfinder-rithmy/pull/3).
API: https://universal-race-calendar.onrender.com . Painel: https://runfinder-rithmy.lovable.app .

O backup local contempla schema/dados public da aplicação, não todos os serviços do projeto nem os arquivos Storage. A verificação de criptografia/arquivo não substitui ensaio de restauração.

## Testes na API e no navegador

| Cenário | Observado | Limitação |
|---|---|---|
| Admin sem credencial | API 401 | Não confundir com indisponibilidade |
| JWT de teste admin | API 200 | Identidade própria temporária removida após teste |
| JWT de teste membro | API 403 | Preservada restrição administrativa |
| CORS publicação/preview | Preflight 204, origens exatas, Authorization/Idempotency-Key permitidos | Nenhum token ou chave publicado |
| Storage | Chave protegida válida; race-exports privado, XLSX/ZIP aceitos, limite 50 MB por arquivo | Nenhuma nova exportação/download comprovado nesta integração |
| Calendário autenticado | 913 publicadas no Brasil, 20 por página, 46 páginas; próxima página funcionando | Catálogo público não inclui os candidatos pendentes |
| Filtro OpenResults | Duas provas publicadas, filtro retorna à primeira página | Não representa o total das três fontes |
| Detalhes da edição de referência | Carregados; nome com acento, Florianópolis/SC, Trail | Sem correção histórica em massa |
| Resultados evt_91fe44bc51e94cf6acf036b6 | 435 registros, página 2 de 22 funcionando; filtro 5 km com 91 registros em 5 páginas | Leitura dos dados preservados, não nova coleta |
| Administração | Controles de fontes, capacidade, descoberta, revisão e agenda presentes; executor desligado informado | Não substitui operação contínua de todos os fluxos |

As duas identidades temporárias do teste de JWT foram removidas. Não foram enviados convites.
Há divergência de configuração: a chave interna local recebe 401 no Render. JWT do painel funciona. Caso scripts internos remotos sejam necessários, alinhar a chave protegida local com INTERNAL_API_KEY do serviço pelos mecanismos de secrets; nunca usar essa chave no frontend nem enviá-la pelo chat.

## Capacidade, execução local e agenda

O Supabase confirmou a organização no plano Free, sem ultrapassar cotas. Usage mostrou aproximadamente 0,073/0,5 GB de banco, Storage abaixo de 1% de 1 GB e egress 0,603/5 GB no ciclo atual. Medição SQL do staging: banco postgres 57.789.587 bytes (~55 MiB), soma dos bancos 73.063.221 bytes (~69,69 MiB), um objeto Storage de 9.030 bytes. As métricas têm escopos diferentes e o painel do provedor pode atrasar a atualização.

Limites internos configurados e auditados pelo painel JWT admin: banco 200 MiB, Storage 100 MiB, margens 16 MiB/1 MiB. Atualizar medições confirmou ambos dentro dos limites. Isso não altera plano, cobra serviço ou reserva recursos no provedor. O controle impede avanço quando o espaço configurado é insuficiente; não garante que o catálogo nacional completo caberá nesse limite.

Coletas são executadas no computador; catálogo/resultados persistem no Supabase e planilhas no Storage. A agenda proposta é segunda-feira 08:00, America/Sao_Paulo, mas permanece **desativada, revisão 0**, sem próxima ocorrência nem ciclo semanal executado. O computador e os executores contínuos precisam estar ligados; offline adia e consolida ocorrências perdidas na próxima sessão. O navegador não liga processos parados. Resultados e novas exportações continuam operações separadas.

Referências oficiais consultadas: [Database size](https://supabase.com/docs/guides/platform/database-size), [Storage size](https://supabase.com/docs/guides/platform/manage-your-usage/storage-size). A organização foi conferida diretamente, sem mudar assinatura ou permissões.

## Pilotos reais, solicitados pelo navegador publicado

Execução local seletiva por ID; nenhum runner GitHub usado. Antes de cada execução: identidade staging, ausência de consumidor ativo/tarefa running, lock de exclusão do inicializador, lote até cinco, autoContinue=false e agenda desativada. Cada processo termina ao concluir uma tarefa; não consome sucessores fora da seleção.

| Fonte / tarefa | Observado | Cobertura |
|---|---|---|
| TicketSports 0036211d-391e-45e9-bffb-43f889594bab | completed, tentativa 1; cinco examinados, cinco existentes, zero criados | bounded_snapshot de até 250 candidatos; aguardando continuação manual, não catálogo nacional |
| CorridasBR/AC 929433f0-7fe8-4168-a3cd-f8730e99f667 | completed, tentativa 1; cinco examinados, cinco existentes, zero criados | state_calendar limitado à etapa/UF; não 27 UFs |
| OpenResults/SC 57b11fc8-3d6c-40c3-bcfb-359a3948c86b | completed, tentativa 1; cinco examinados, zero existentes, cinco criados | native_pages, continuação manual; término global ainda não validado |

O catálogo administrativo passou de 951 para 956, mantendo 913 publicadas. As cinco novas provas exigem inspeção/revisão antes de publicação. Descoberta não significa metadados aceitos ou resultados coletados. Cinco inspeções vinculadas foram geradas; a situação final é registrada abaixo.

As cinco inspeções concluíram na tentativa 1, sem erro: 59f4d590-3b5c-488d-b90b-14b3a6e90a0e, 26d96b4d-5935-4c9a-a3cc-c01d4dbbf911, 03dba607-77cb-4008-b5d0-3e471c639dbc, 1d1f3c75-024f-40e0-a48d-5af81be761ae e a6610762-79fe-471c-9ba4-fc0b0022a372. Dados persistidos conservam as cinco edições de 27/09/2026, cidades/SC; quatro países BR confirmados e um país ausente. Todas permanecem pending_review com modalidade unknown. Não foram publicadas ou associadas por suposição; não coletamos seus resultados. Motivos de publicação anteriores à inspeção ainda incluem country_unconfirmed mesmo nas quatro com país preenchido, ponto a revisar no próximo ajuste dos diagnósticos.

Todos os processos seletivos iniciados nesta rodada terminaram com código 0, sem lease ativo, e a fila final voltou aos dois pedidos antigos protegidos. Nenhum executor foi deixado ligado por este agente. Os três ciclos ficam sem continuação automática; concluir uma etapa não encerra o catálogo inteiro.

A rotina existente de limpeza do worker Python removeu o arquivo já expirado encontrado na medição inicial; ao final o Storage mostrou zero bytes e os 16 artefatos históricos estão expired. Os 435 resultados continuam persistidos. Isso é observação da limpeza por prazo implementada, não um ensaio controlado de expiração de URL assinada nem comprovação de nova exportação.

Pedidos antigos preservados, queued e executionHold=true:

- 5e8fe9d7-d889-4cd5-b427-972498115f2b, TicketSports/calendar, quantity 120, 22/09/2026 00:25:13.161 UTC.
- 8278a9e1-9eaa-41ea-8e72-856d8b631665, TicketSports/calendar, quantity 15, 22/09/2026 00:56:40.933 UTC.

## Pendências do aceite completo

- Revisão dos campos não comprovados das novas descobertas, correção de motivos de publicação que ficaram obsoletos após inspeção, nova exportação e download com o código integrado.
- TicketSports nacional ampliado, páginas nativas CorridasBR/27 UFs e OpenResults até término verificável; cruzamento global real e conciliação dos IDs das fontes.
- Testes de recuperação e comunicação com o código integrado, distinguindo regressões controladas de operações reais.
- Primeira ocorrência semanal real após habilitação específica; não há rotina semanal ativa neste momento.
- Fallback DOM de resultados sem checkpoint por página; não equiparar descoberta nacional a esse caminho.
- Ensaio de migração dos backups antigos e de restauração, separado do uso do painel.

O painel e a API foram publicados e consultas autenticadas funcionam. A cobertura 100% das três fontes e a operação semanal real permanecem não comprovadas.

## Rodada posterior: TicketSports ampliado e correções no PR #13

Executada ainda em 07/10/2026 local (08/10 UTC), somente staging. API/main permanecem a8b360f; nenhum merge ou deploy novo realizado. Solicitação pelo painel autenticado, SC, descoberta ampliada, batchSize=5 e autoContinue=false; agenda continua desativada. A medição foi atualizada pelo painel antes da solicitação. Os limites de 200/100 MiB são proteção de espaço gratuito, não mensalidade, compra ou reserva de infraestrutura.

| Cenário / IDs | Esperado | Observado | Pendência |
|---|---|---|---|
| TicketSports ampliado, fc30d3ec-b1c8-4485-b95d-73ff6abf2454 | Processar até cinco candidatos, guardar checkpoint | completed/tentativa 1; três novos, dois existentes, cinco processados; 25 candidatos descobertos; cursor 5, prefixo atual 25/próximo 50 | Ainda sem recibo de término; não cobertura nacional |
| Sync 4f10aec3f1d083190e6f537d5ed3fbbf4dc92c7740d8ccad7cd45910a8cdab7d | Continuar somente por nova ação manual | ready, official_state_and_national_prefixes; nenhuma etapa seguinte adquirida | Continuação após corrigir a inspeção |
| Inspeções b8429fd9-0f6c-47eb-b501-1245fa05b20b, 1ec78960-95c2-4851-a261-55c61cc15ef5, 268eab28-f60a-4391-a26d-b396a7799e59, 20f9ccde-3796-471d-8d8a-93f22d3c83dc | Inspecionar os candidatos vinculados | completed/tentativa 1; país BR confirmado; exigências de revisão preservadas | Não equivale a aceitar modalidade ou publicar automaticamente |
| Inspeção 39437061-4594-496c-b4c8-3860e7683f93 / evt_e4e10957b3e2f705d2c9e591 | Gravar metadados sem apagar os anteriores | queued/collection_failed, tentativa 2, stage provider_failed; nenhum consumidor ativo | Correção Unicode no PR #13 antes de nova retomada |
| evt_60704aac672b4164a17e5e75 | Preservar modalidade road e publicação anterior em atualização incompleta | road foi preservado, mas permaneceu modality_unconfirmed e status passou a pending_review; público 913→912 | PR #13 evita a regressão; edição já afetada ainda requer revisão/restauração auditada |
| Transporte/curadoria da inspeção com falha | Distinguir fonte inacessível de erro de persistência | Uma consulta diagnóstica, respeitando o guard, passou no transporte e na curadoria; não consumiu a tarefa | Não comprova gravação nem nova coleta |
| Reprodução sem rede da mesma inspeção | Identificar a falha concreta | Preço tinha sourceText de 240 unidades com emoji cortado; Prisma InvalidArg/unexpected end of hex escape reproduzido no PostgreSQL sintético | Sem novas consultas à fonte |
| Reprodução corrigida sem rede | Persistir o metadado já armazenado | passou no PostgreSQL sintético após limite de trecho preservar caracteres completos | Teste diagnóstico local, não execução bem-sucedida da tarefa staging |

Catálogo administrativo agora 959; público 912. As três novas edições TicketSports mantêm revisão, inclusive candidatos cuja modalidade não pode ser deduzida do nome. A lista da fonte contém também itens como Day Use/triatlo; descoberta não aprova esses itens como corrida de rua. Os acentos dos novos registros foram conferidos no JSON com escapes Unicode: a aparência do primeiro log PowerShell era codificação da saída, não corrupção comprovada no banco.

PR #13: https://github.com/gustavomf-ykn/universal-race-calendar/pull/13 . Último commit preparado: 37cf6f09bdf71a1a9703868cdded9932a81b0ba0. Corrige diagnósticos OpenResults, motivos depois da preservação de campos TS e trechos Unicode da curadoria 1.7.1. Atualizar ambos os executores locais após integração; nenhuma migration ou mudança frontend. A API não executa essa curadoria; deploy não é necessário para o processamento corrigido. Seu /version continuará descrevendo a API antiga até eventual deploy separado.

Validação local: 22 Python/SQL direcionados; 20 TypeScript/SQL de metadados/associação; regressão de persistência Unicode; 28 testes de API pública/mock/utilitários; fontes/modalidade aprovadas. Novas regressões falharam com o código anterior. Dois casos e um replay tiveram timeout por concorrência no PostgreSQL local; a repetição sequencial confirmou os controles sem desativá-los. Uma asserção de publicação foi retirada do cenário Unicode, cuja referência sintética não atende à política de referência pública; a proteção de publicação tem regressão própria. CI do último commit deve ser conferido antes de integrar; o CI verde dos commits anteriores não substitui essa confirmação.

CI final conferido para o commit 37cf6f09bdf71a1a9703868cdded9932a81b0ba0: https://github.com/gustavomf-ykn/universal-race-calendar/actions/runs/37712069730 . Jobs test e containers concluídos com success. Testes TypeScript aprovados; Python: 236 passed, 1 deselected. Lint, tipos, build, OpenAPI, três imagens/processos, smoke de Chromium e ciclo de encerramento controlado aprovados. As migrations foram repetidas somente no banco descartável do CI; nenhuma migration nova aplicada no staging. O lote sintético com fila vazia do CI não representa coleta real. Esta confirmação substitui a pendência de CI registrada no parágrafo anterior; o PR continua aberto, sem integração automática.

Fila nesta rodada: dois pedidos antigos protegidos e a inspeção 39437061 queued/tentativa 2. Não houve cancelamentos, coleta em massa, runner de coleta, resultado novo ou exportação nova. Os executores seletivos encerraram com código 0; não há processo consumindo staging. Os controles e a solicitação foram testados no navegador autenticado; o processamento ocorreu no terminal local; o replay e regressões são testes SQL sintéticos.
