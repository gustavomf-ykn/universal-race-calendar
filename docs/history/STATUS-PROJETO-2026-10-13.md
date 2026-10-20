> Registro histórico arquivado em 19/10/2026. Descreve evidências e decisões da época, não o estado atual nem uma autorização para executar comandos. Para retomar, leia [CONTINUITY.md](../../CONTINUITY.md) e [AWS-HOSTING.md](../AWS-HOSTING.md). Credenciais, backups, logs privados e capturas não acompanham este arquivo.

# Estado verificado do Runfinder em 13/10/2026

Somente homologação race-platform-staging (sggrijhyblejlgimgzzc). Consultas de inventário somente leitura; nenhuma migration, alteração de plano, publicação ou agenda nesta rodada.

## Integração e versões

- Usuário integrou Backend PR #13: https://github.com/gustavomf-ykn/universal-race-calendar/pull/13 . Merge cadf75bf1aed5f89465385e719b4f9d474076cd3 confirmado no GitHub e checkout operacional atualizado por fast-forward. Os dois documentos locais preexistentes não versionados foram preservados.
- CI da main no commit integrado concluído com success: https://github.com/gustavomf-ykn/universal-race-calendar/actions/runs/38404796248 . CI do último commit do PR também success (37712069730). Não foram executados workflows de coleta.
- Prisma generate e build local concluídos; imports do worker Python aprovados; testes locais de diagnósticos: 7 passed, 1 skipped (caso SQL não executado nesta rodada), aviso de acesso ao cache pytest. Chromium local: local_resources_with_chromium_passed e chromium_launch_dom_javascript_passed, sem rede de fonte. Curadoria compilada 1.7.1 confirmada em @race-calendar/utils.
- API pública /v1/version retornou HTTP 200 e gitSha a8b360faa2b04224ba8b769035f6a425da3e9a34, curadoria 1.7.0. Não houve deploy. Compatível: a API enfileira, os workers executam as correções. A versão da API continua descrevendo seu próprio código.
- Frontend checkout main ebbabd4e991ac7af71f283389683c7539af7299c, sem alterações locais. Não houve publicação ou nova validação no navegador nesta rodada; a confirmação de publicação anterior está no relatório de 07/10.

## Retomada real seletiva

Após CI aprovado e inventário sem consumidores, somente a tarefa TicketSports check-source 39437061-4594-496c-b4c8-3860e7683f93 foi selecionada. O inicializador exigiu o commit cadf75b, projeto confirmado, ausência de outros executores/tarefas running, agenda desligada, mesmo sync com batchSize 5 e autoContinue false. As demais tarefas ficaram excluídas. SCRAPER_MAX_RETRIES 1, curadoria sem modelo externo, um único consumo desta tarefa existente.

Resultado: completed na tentativa 3, errorCode null, etapa manual_review; processo exit 0. Não foi criado pedido duplicado nem declarado novo resultado esportivo. Dados persistidos de evt_e4e10957b3e2f705d2c9e591: Maratona de Jurerê 2026, data 11/10/2026 (antes nula), Florianópolis/SC/BR, modalidade unknown, pending_review por modality_unconfirmed. Inspeção passou a gravar os metadados; publicação ainda exige evidência/revisão. Não houve publicação automática ou nova exportação.

## Inventário final

- 959 edições no catálogo administrativo; 912 publicadas brasileiras. Contagens verificadas no banco, não inferidas da interface.
- Referência evt_91fe44bc51e94cf6acf036b6 conserva 435 resultados.
- 29 migrations existentes, sem alteração nesta rodada.
- Agenda enabled false, revision 0. Limites de capacidade previamente confirmados; não são contratação ou mensalidade.
- Executor seletivo encerrado. Consulta local de processos retornou zero executores (TypeScript/Python/coordenador/piloto); nenhum activeTaskId. Heartbeat recente pode permanecer visível por sua janela após a saída, não significa processo vivo.

| Tarefa | Operação/fonte | Estado | Tratamento |
|---|---|---|---|
| 5e8fe9d7-d889-4cd5-b427-972498115f2b | calendar TicketSports, quantity 120 | queued, executionHold true | Preservada, não processada |
| 8278a9e1-9eaa-41ea-8e72-856d8b631665 | calendar TicketSports, quantity 15 | queued, executionHold true | Preservada, não processada |
| 73391048-c940-4188-b4d2-276fa640f800 | extract OpenResults, criada 12/10/2026 14:53:10 UTC | queued, executionHold false | Pedido novo identificado no inventário; não processado |

## Próxima etapa e limites do aceite

Mecanismos nacionais, checkpoints, recibos, cruzamento por evidência, revisão e agenda local estão implementados. Pilotos anteriores pequenos nas três fontes e o lote TicketSports ampliado comprovaram crescimento (cinco candidatos novos OpenResults e três TicketSports), mas não esgotaram catálogos/partições/histórico. Não declarar cobertura 100% a partir dessas amostras.

Faltam a varredura verificável das 27 UFs e páginas/histórico das três fontes, conciliação real global por evidência, revisão dos candidatos e da publicação anteriormente afetada, nova exportação com o código integrado e aceite cotidiano no navegador. Agenda semanal deve ser habilitada somente com autorização específica e depois validada em ocorrência real. Executa localmente com computador/internet/executores ligados; dados e arquivos permanecem no Supabase.

Próximo consumo deve informar os IDs selecionados e conferir fila/executores/capacidade novamente; não iniciar consumidores contínuos que adquiram o novo pedido OpenResults inadvertidamente. Pedidos antigos protegidos não devem ser liberados.