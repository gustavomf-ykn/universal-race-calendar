# Inventário de capacidade antes da carga nacional

Ferramenta `scripts/catalog-capacity.mjs`, somente leitura. Não autoriza carga e não altera plano, dados, fila ou configurações. A barreira separada foi integrada e configurada no staging em 07/10/2026, após conferir o plano e o uso da organização. Pilotos seletivos passaram pela medição; cobertura nacional e capacidade para o catálogo inteiro permanecem pendentes. As seções sobre desenvolvimento abaixo conservam o histórico da implementação.

“Orçamento” significa limite interno de espaço, em bytes/MiB, e não pagamento ou compra de recursos. O trabalho acontece no computador, mas catálogo/resultados persistem no Supabase e planilhas no Storage para acesso pelo painel. Execução local não elimina essas quotas. Nenhuma configuração nesta API aumenta o plano do provedor. Medição e alocação devem ser conferidas no ambiente administrativo; não pedir que o usuário envie credenciais ou invente cotas.

## Identidade e uso seguro

Exige um único argumento `--environment=local-test` ou `--environment=race-platform-staging`. Local exige host local e nome de banco terminado em `_test`. Staging exige Supabase URL do projeto `sggrijhyblejlgimgzzc`, banco postgres no host desse projeto ou pooler com referência correspondente, e SSL obrigatório. Credenciais são lidas do ambiente protegido, nunca de argumentos ou mensagens. Erros de conexão/provider são sanitizados.

Executar com as variáveis fornecidas pelo mecanismo protegido existente. Não copiar connection strings ou chaves para o chat, arquivo versionado ou histórico do terminal. Esta ferramenta não usa chave do Storage: lê apenas metadados SQL quando o papel tem visibilidade completa.

Todas as consultas executam `SET TRANSACTION READ ONLY` e timeout. O relatório contém somente bytes, nomes das tabelas operacionais, contagens agregadas e situações de medição. `currentDatabase` mede o banco conectado; `clusterDatabases` soma os bancos do cluster. `publicTables` inclui índices e TOAST e auxilia a identificar crescimento. WAL/disk não são medidos; os tamanhos não são equivalentes ao uso faturado de toda a organização.

Storage ausente, sem SELECT/visibilidade completa por RLS ou com objeto sem tamanho vira `unavailable`, jamais zero. O comando termina com status não zero se banco/cluster/Storage não puderem ser medidos. O JSON sempre mantém `limitsVerified=false` e `loadAuthorized=false`: medir não confirma plano/franquia ou concede autorização para carga.

`catalogRecords` conta valores armazenados; `countryMissing=0` não prova país validado e `roadOrTrail` não prova classificação correta. `queuedWork` resume pendentes/ativos sem exibir payload, usuário, nomes de provas ou dados de atletas. Contagens não demonstram esgotamento da descoberta nas três fontes.

## Validação do inventário

Em homologação, a identidade foi validada pelo preflight existente antes das consultas somente leitura com credenciais DPAPI locais. Os resultados operacionais específicos permanecem fora do repositório público. Nenhuma migration foi aplicada ou executor iniciado pela ferramenta. Pedidos retidos não foram liberados, cancelados ou consumidos.

Uma medição é uma observação pontual, não cobertura nacional, prontidão de produção ou garantia de espaço para todas as edições/resultados. Testes automatizados usam PostgreSQL descartável e respostas simuladas; conferem a rejeição de destino ambíguo, sanitização e medição indisponível em vez de zero.

## Limites e próximo controle

Documentação oficial consultada em 01/10/2026: [database size](https://supabase.com/docs/guides/platform/database-size) descreve restrição de escrita no Free acima de 500 MB de banco; [Storage size](https://supabase.com/docs/guides/platform/manage-your-usage/storage-size) informa 1 GB no Free e acompanhamento de uso por organização/período. A quota e as restrições não são determinadas apenas pelo tamanho vivo deste projeto. O plano e consumo dos demais projetos da organização não foram confirmados pela ferramenta.

Antes da carga nacional: confirmar quota efetiva e orçamento reservado a staging; definir margens conservadoras e medir crescimento por lote (catálogo separado de resultados). Verificar também espaço local/memória para Chromium e arquivos temporários. Não aumentar planos, apagar resultados válidos ou alterar spend cap automaticamente. Uma varredura que para por capacidade continua parcial até resolver a causa e retomar o checkpoint.

## Barreira compartilhada em desenvolvimento

Migration aditiva `20261001000300_catalog_capacity`, aplicada apenas em PostgreSQL local descartável. RLS e revogações impedem acesso de PUBLIC/anon/authenticated às tabelas e funções. API administrativa valida JWT admin; nenhum segredo novo é necessário no frontend.

O orçamento inicial é não confirmado. O administrador registra uma alocação total de banco e Storage que caiba na capacidade reservada ao projeto, considerando os demais projetos/consumo da organização. A confirmação humana não verifica automaticamente a quota do provedor. O sistema não contrata recursos nem altera planos.

Os executores conferem banco antes de começar e antes de cada transporte de fonte. Gravações cercadas por lease medem dentro da transação e mantêm lock compartilhado até o commit; snapshots, fontes, extrações e resultados usam estimativas conservadoras de crescimento. O cálculo soma os bancos do cluster, com margem mínima de 16 MiB. Tamanho físico, índices, WAL e escritores externos não têm crescimento exato previsível: essa proteção reduz risco, mas não substitui acompanhamento da quota do provedor.

Exportações conferem Storage antes de montar o arquivo. Imediatamente antes do upload, reservam seu tamanho exato sob lease válido. Reservas concorrentes são somadas; repetir a reserva do mesmo lease não cobra duas vezes. Publicação concluída remove a reserva na transação final. Upload interrompido/sem resposta mantém a reserva por até 30 minutos, além dos objetos eventualmente medidos, de forma conservadora. O caminho continua vinculado ao lease. Reserva expirada não autoriza publicação por executor vencido.

Toda verificação de execução mede novamente; nunca autoriza pelo cache mostrado no painel. Storage ausente, sem visibilidade completa ou objeto sem tamanho implica medição indisponível. Isso impede novas exportações; não impede trabalho exclusivamente de banco quando este pode ser medido e cabe em sua alocação.

Uma tarefa sem capacidade retorna a `queued` com `executionHold=true`, `holdReason=capacity_wait`, erro específico e recurso em `progress.capacityResource`. Não gasta tentativa e preserva progress/checkpoint. Configurar orçamento e atualizar medições não liberam pedidos. Retomar mede novamente e libera somente a retenção por capacidade do recurso escolhido. Outros holds, bloqueios de fonte e histórico permanecem protegidos. Replay de uma retomada antiga devolve seu resultado original e não libera retenção posterior.

### Contrato e operação

- `GET /v1/admin/capacity`: alocações/margens em strings de bytes, medições e datas; `providerQuotaVerified=false`.
- `POST /v1/admin/capacity/configure`: `databaseBudgetBytes`, `storageBudgetBytes`, `databaseHeadroomBytes`, `storageHeadroomBytes` (strings inteiras positivas), `allocationConfirmed=true` e `reason` (3–500 caracteres). Margem mínima de banco 16777216 bytes; Storage 1048576 bytes. Orçamentos superam suas margens.
- `POST /v1/admin/capacity/refresh`: `reason`. Mede recursos e retorna `decisions`, sem liberar tarefas.
- `POST /v1/admin/capacity/resume`: `reason` e `resource=database|storage`. Retorna `released`. Storage requer banco e Storage disponíveis; banco pode ser retomado independentemente de Storage desconhecido.

POSTs exigem JWT admin e `Idempotency-Key`. Erros 409 distinguem `capacity_unconfigured`, `capacity_measurement_unavailable`, `capacity_database_limit`, `capacity_storage_limit` e conflitos de idempotência. Não divulgar medições operacionais no repositório público; visualizar no painel administrativo e evidências privadas autorizadas.

Integração futura: backup/identidade staging → migrations completas aprovadas → deploy explícito da API → build/atualização dos executores → publicação do frontend → orçamento confirmado e testes seletivos. Não iniciar carga nacional só porque um pequeno arquivo coube. Proteção de [memória/disco locais](LOCAL-RESOURCES.md) e checkpoints nativos de resultados estão implementados na branch, ainda sem homologação integral. Agenda semanal e cobertura real continuam pendentes; retomada do fallback DOM permanece uma limitação separada.
