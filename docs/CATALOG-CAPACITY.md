# Inventário de capacidade antes da carga nacional

Ferramenta `scripts/catalog-capacity.mjs`, somente leitura. Não é um controle automático de capacidade, não autoriza carga e não altera plano, dados, fila ou configurações. O mecanismo que pausará consumidores antes do limite ainda precisa ser implementado.

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

Antes da carga nacional: confirmar quota efetiva e orçamento reservado a staging; definir margens conservadoras, medir crescimento por lote (catálogo separado de resultados), persistir medidas com validade, bloquear trabalho quando a medição estiver ausente/vencida ou atingir margem, e permitir retomada auditada. Verificar também espaço local/memória para Chromium e arquivos temporários. Não aumentar planos, apagar resultados válidos ou alterar spend cap automaticamente. Uma varredura que para por capacidade continua parcial até resolver a causa e retomar o checkpoint.
