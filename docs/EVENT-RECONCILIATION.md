# União de registros da mesma edição

Implementação na branch nacional, ainda não publicada ou aplicada ao Supabase. Não comprova cobertura nacional. A união manual é uma decisão administrativa; descoberta, publicação, coleta de resultados e agenda são etapas distintas.

## Contrato

`POST /v1/admin/catalog/reconciliations/preview`, JWT admin: `{ "sourceId": "registro-de-origem", "targetId": "edicao-de-destino" }`. Retorna duas edições com nome, data, cidade/UF/país, publicação, referências/observações sanitizadas, contagens de resultados/exportações, `revision`, `canMerge`, `reasons`, `automatic`, `automaticReason` e tarefas em uso. A prévia não altera dados e não requer chave de idempotência.

`POST /v1/admin/catalog/reconciliations`, JWT admin e `Idempotency-Key`: mesmos IDs, `revision` retornada, `reason` (3–500 caracteres) e `confirmedSameEdition=true`. Não aceita `mode` escolhido pelo frontend. A rota registra decisão manual. Retorna `eventId` canônico, `sourceId` anterior e `auditId`. Repetir exatamente o mesmo payload/chave retorna a decisão original; payload diferente com a mesma chave produz 409.

409 distingue `reconciliation_preview_stale`, `edition_reconciliation_in_use`, `edition_manual_conflict`, `editions_already_unified` e conflitos de identidade/localização. Ausência de autenticação retorna 401; usuário sem papel admin retorna 403. Capacidade indisponível retorna 503 `catalog_capacity_wait`. O frontend utiliza somente JWT; a chave interna permanece exclusivamente no backend.

## Evidência e preservação

- Data e localização completas compatíveis são obrigatórias. Identidades diferentes da mesma fonte e estados hidden/rejected bloqueiam a união. Correções manuais conflitantes exigem revisão antes de nova prévia.
- Nome, fingerprint e homepage não autorizam união automática. Link de edição reconhecido e observações validadas são necessários; uma terceira edição impede a escolha automática de um par isolado. A branch tem [varredura global durável](CATALOG-RECONCILIATION.md), que exige revalidar o grupo inteiro, ainda sem homologação real.
- A transação transfere referências, conjuntos de resultados, checkpoints, exportações, versões, extrações, curadorias, pendências de associação, candidatos e auditorias para o destino. O evento anterior passa a alias com seu slug e snapshot; o destino mantém seu ID/slug.
- Campos revisados são preservados, inclusive nulos intencionais e decisões legadas de publicação. Uma única referência fica principal, selecionada pela prioridade da fonte; o fingerprint é recalculado. Coleções ausentes no destino são completadas; coleções divergentes da origem ficam preservadas no snapshot, sem inventar uma conciliação de preços/distâncias/imagens.
- IDs/slugs anteriores permanecem reservados. Uniões posteriores redirecionam aliases diretamente ao destino atual. Contagens/listagens têm um único Event por edição unificada.
- Payloads, hashes, chaves, seleções originais e objetos já gerados não são reescritos. Consumidores resolvem IDs no momento da consulta/processamento; seleções de exportação deduplicam aliases. A permissão de publicação do destino também se aplica aos links antigos.
- Tarefas running, inclusive leases vencidos ainda não recuperados, impedem união. Lotes ativos das fontes envolvidas e curadoria em lote também impedem a operação, pois seu payload não enumera todas as edições que podem atualizar. Aquisição compartilha um lock com a união antes de resolver os aliases e bloqueia a edição canônica. Escritas de resultados bloqueiam a edição; fencing por lease continua obrigatório. O mecanismo não cancela nem libera tarefas protegidas.

## Integração

Migration aditiva `20261002000100_event_reconciliation`: EventAlias, RLS, privilégios restritos, reserva de identidades, função `resolve_event_id` e sincronização da aquisição. Aplicada somente a bancos locais descartáveis nesta implementação. Preparar backup e confirmar staging antes de uma aplicação futura autorizada, sem reset.

Atualizar schema/Prisma e os dois executores, incluindo `event_aliases.py` na imagem Python. O inicializador recusa schema sem os aliases/função. A API requer deploy explícito para resolver links e expor o contrato; o frontend requer publicação depois de backend compatível. Não iniciar uniões com consumidores antigos ativos. Merge não é deploy.

## Testes e pendências

Regressões em PostgreSQL isolado cobrem transferência, replay concorrente, prévia obsoleta, anos/localizações/correções incompatíveis, identidades antigas, cadeia de aliases, aquisição concorrente, restrição de publicação e consumidores TypeScript/Python. O XLSX sintético é aberto e seus cabeçalhos/linhas são conferidos. Testes de navegador autenticado e uniões com correspondências reais permanecem pendentes até publicação autorizada.

A descoberta/reconciliação automática do catálogo inteiro, política estrita de país/modalidade/publicação, capacidade local, agenda semanal e varredura integral real continuam como parte da meta nacional.
