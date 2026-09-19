# Migrações controladas

Nenhuma migration ou transferência de dados de produção foi executada. Foram aplicadas as migrations em PostgreSQL local isolado. Não havia backup PostgreSQL de produção nem SQLite persistido real disponível. O teste SQLite usa dados sintéticos e verifica duas aplicações sem duplicação.

## Autoridade e revisão

`packages/database/prisma/migrations` é o único histórico. Não executar migrations paralelas pela Lovable ou gerar tabelas equivalentes pelo painel Supabase. `pnpm db:migrate` usa `prisma migrate deploy`; não chama mais a rotina antiga de recuperação destrutiva. Nunca usar `db:recover`, `migrate reset` ou `db push --accept-data-loss` para migrar produção.

Migrations novas: modelos/fila, constraints e funções com RLS, bucket privado condicional, timestamps absolutos da fila/resultados/exportações. As tabelas anteriores e os IDs Event/Source são preservados. Novos timestamps usam timestamptz; a conversão versionada trata valores anteriores dessas tabelas novas como UTC. No primeiro deploy elas estarão vazias.

## PostgreSQL do calendário → Supabase de homologação

1. Registrar commit, `prisma migrate status`, tamanho e backup verificado. Desabilitar agendamentos e parar escritores durante a captura final para comparar contagens consistentes. Não compartilhar URLs/secrets em logs.
2. Configurar `MANIFEST_DATABASE_URL` com acesso somente leitura ao banco de origem e executar:

```sh
python apps/openresults-worker/database_manifest.py > calendar-before.json
pg_dump --dbname="$SOURCE_DATABASE_URL" --format=custom --schema=public --no-owner --no-acl --file=calendar.dump
```

3. Restaurar em projeto de homologação novo, com schema público sem tabelas do aplicativo. O dump não inclui auth/storage, que continuam geridos pelo Supabase:

```sh
pg_restore --dbname="$TARGET_DATABASE_URL" --no-owner --no-acl --exit-on-error calendar.dump
```

Não usar `--clean`. Se houver colisões, abortar e investigar; não apagar tabelas do destino. A tabela `_prisma_migrations` do calendário acompanha o dump. Se a origem não tiver histórico consistente, fazer baseline revisado em cópia antes de seguir; não marcar migrations aplicadas sem comparar o schema.

4. Configurar DATABASE_URL/DIRECT_URL para homologação, executar `pnpm db:generate`, `pnpm db:migrate` e `pnpm --filter @race-calendar/database exec prisma migrate status --schema prisma/schema.prisma`.
5. Gerar `calendar-after.json` com MANIFEST_DATABASE_URL do destino. Comparar cada count e sampleHash (20 primeiros IDs por tabela), zero orphanedReferences, IDs Event/Source preservados e detalhes de edições selecionadas. Hashes abrangem dados brutos e não são publicados; guardar os manifests com o backup. As novas tabelas devem iniciar vazias.
6. Conferir RLS, privilégios e bucket privado; testar API/worker com pequena fixture. Só então planejar corte de produção em janela explícita. Restaurar backup em outro destino é a estratégia de rollback, ensaiada antes do corte.

## SQLite OpenResults → resultados permanentes

Copiar o arquivo persistido com backup consistente SQLite (`sqlite3.Connection.backup` ou `.backup`), incluindo a garantia de que transações WAL foram capturadas. Nunca copiar só o `.db` de uma base ativa ignorando o WAL. O mecanismo abre a cópia com `mode=ro` e não altera o original.

Na pasta `apps/openresults-worker`, com dependências instaladas:

```sh
python migrate_sqlite.py /backup/openresults.sqlite --report inventory.json
```

Dry-run é o padrão. Seleciona resultados da última extração **concluída**, pertencente a job concluído; produz contagens/digest por edição, sem nomes de atletas no relatório. Dados parciais/sem cópia persistida não são inventados. Como o SQLite antigo pode remover resultados ao expirar jobs, somente registros ainda existentes podem ser recuperados.

Associar primeiro a edição usando `POST /v1/admin/source-matches` e `/resolve`, conferindo data e identificador externo. Criar arquivo explícito:

```json
{"id-original-openresults":"id-Event-preservado-do-calendario"}
```

Manter o worker OpenResults pausado e aguardar tarefas em execução. Configurar WORKER_DATABASE_URL para homologação e executar:

```sh
python migrate_sqlite.py /backup/openresults.sqlite --mapping ids.json --report plan.json
python migrate_sqlite.py /backup/openresults.sqlite --mapping ids.json --apply --report applied.json
```

Itens sem mapping ficam `mapping_required`; incompletos ficam `skipped_incomplete`. A aplicação exige referência de fonte já vinculada, mesma edição e contagem completa. Cria tarefa operacional de migração, substitui o conjunto em transação e verifica contagem; `applied.json` traz catalogId, oldEventId, Event.id, ResultSet.id, digest e verifiedRows. Guardar esses arquivos como evidência e revisar todos os itens que não tenham status verified.

Reexecutar `--apply` com a mesma cópia/mapping mantém ResultSet e não duplica RaceResult. Uma tarefa operacional adicional é esperada. Antes/depois: comparar contagem por conjunto, relações, data e amostras de bib/modalidade/classificação com a cópia; não usar só quantidade global como prova de migração correta. Falha durante publicação mantém o último conjunto válido.

ZIP e arquivos temporários antigos não são migrados; gerar novos XLSX no Storage a partir dos resultados permanentes. Jobs antigos continuam apenas no backup de origem, não viram tarefas prontas para execução no banco novo. Esses são limites deliberados de compatibilidade, não perda dos resultados importados.

## Ensaio ap�s a homologa��o de 19/09/2026

Nenhum backup real foi recebido ou importado. Depois do aceite em STAGING.md, obter dump PostgreSQL consistente (incluindo _prisma_migrations) e backup SQLite pela API de backup, com WAL capturado. Confirmar um destino descart�vel antes de restaurar; n�o misturar o ensaio com os dados do aceite sem plano expl�cito. Comparar manifests, refer�ncias, contagens por edi��o e amostras. Esta pend�ncia � independente do teste de Auth/Storage e n�o justifica acesso � produ��o.
