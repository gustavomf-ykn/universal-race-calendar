# Cruzamento global durável do catálogo

Implementado na branch nacional, ainda não publicado ou aplicado ao Supabase. Complementa a [união manual](EVENT-RECONCILIATION.md). Não comprova cobertura nacional ou atualização semanal.

O executor TypeScript percorre registros já existentes das três fontes aprovadas, sem consultar sites ou coletar resultados. O início é explícito e independente da descoberta/agenda.

## Contrato administrativo

JWT com `app_metadata.role=admin` validado no backend. Frontend sem chave interna.

| Rota | Entrada / resposta |
|---|---|
| `POST /v1/admin/catalog/reconciliations/scans` | `Idempotency-Key` e `{ "reason": "Cruzar referências verificadas" }`; 202 com `run` e `taskId` |
| `GET /v1/admin/catalog/reconciliations/scans` | `page`, `limit` (até 100); `data`, `total`, `page`, `limit` |
| `GET /v1/admin/catalog/reconciliations/scans/{id}` | Mesma paginação, `status=merged|review|unmatched|foreign|waiting` opcional; `run`, decisões paginadas e candidatos com nome/data/localização/fonte atuais |
| `POST /v1/admin/catalog/reconciliations/scans/{id}/{action}` | `action=pause|resume|cancel`, `Idempotency-Key`; estado atualizado, com auditoria |

`run` expõe ID, tarefa inicial, estado, versão, snapshot, pausa, contadores, datas e `latestTask` sanitizada nas consultas. Não expõe proprietário, payload, chave de idempotência ou token de lease. As decisões expõem IDs históricos, motivo, detalhes de união e candidatos atuais resolvendo aliases.

## Continuação e preservação

O ciclo guarda `snapshotAt`, versão, cursor `(createdAt,id)`, sequência e decisões. Registros criados após o snapshot e mudanças em registros já percorridos exigem outra varredura. O snapshot delimita datas de criação; não congela todos os valores. Decisões são históricas, enquanto os candidatos exibidos são os dados atuais.

Cada etapa processa até dez registros; a função aceita limite interno de 1–25. Candidato, união, decisão e cursor são confirmados na mesma transação protegida por lease. O coordenador enfileira a próxima etapa quando a anterior conclui. Execução seletiva por IDs nunca gera sucessores.

Grupos de até três registros exigem conexão por URLs reconhecidas de edição e compatibilidade de todos os pares: país BR, data/localização, observações validadas, identidades, correções administrativas e nenhuma tarefa usando a edição. Links transitivos são aceitos sem escolher arbitrariamente um par. Mais candidatos, homepage/fingerprint ou conflito vão para revisão. Um conflito rejeita o grupo inteiro, sem união parcial. O destino mais antigo conserva ID/slug; aliases, resultados, exportações, histórico e correções permanecem.

## Estados e controles

`ready`, `waiting`, `paused`, `blocked`, `completed`, `completed_with_review`, `cancelled`. A última tarefa pode estar concluída enquanto o ciclo aguarda continuação. Contadores: registros percorridos/incorporados, pendências, sem correspondência e estrangeiros. Não representam cobertura da fonte, provas publicadas ou resultados coletados; não há percentual sem denominador.

Pausa conserva checkpoint e retém somente tarefas pending/queued do ciclo. Retomada usa sequência confirmada e não libera holds de outras políticas. Falha/cancelamento isolado bloqueia continuação; usar controles do ciclo, não retry genérico (`use_reconciliation_scan_controls`). Cancelar o ciclo exige nenhuma etapa running, cancela só suas tarefas queued e preserva decisões/dados. Com etapa ativa, pausar e aguardar. Pode cancelar versão incompatível e iniciar outra varredura intencional.

Há apenas um ciclo não terminal. Replay da mesma chave/payload retorna o pedido original. Nova chave durante ciclo ativo retorna 409 `catalog_reconciliation_active`, sem tarefa órfã. Controles são idempotentes/auditados. Capacidade impede novas etapas/retomada; pausa/cancelamento continuam disponíveis para reduzir atividade.

## Integração e validação

Migrations aditivas `20261002000200_catalog_reconciliation` e `20261002000300_catalog_reconciliation_cancel`: tabelas/índices, RLS, privilégios restritos e estado de cancelamento. Aplicadas somente ao PostgreSQL local de testes. Aplicação em staging depende de autorização e confirmação do destino, sem reset.

Atualizar Prisma/schema, API e executor TypeScript explicitamente; publicar frontend depois. O inicializador conjunto verifica tabelas e constraint de cancelamento antes de iniciar; os requisitos anteriores do worker Python permanecem. Nenhuma agenda é habilitada. Não operar com consumidores antigos ativos.

Testes controlados cobrem grupo de três fontes/transitivo, conflitos, preservação, cursor/lease/continuação, concorrência/idempotência, pausa/retomada/cancelamento, snapshot, RLS e contrato administrativo. Fontes reais e navegador publicado ainda exigem homologação.
