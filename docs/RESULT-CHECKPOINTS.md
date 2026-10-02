# Checkpoints de páginas de resultados — branch de catálogo nacional

Implementação em desenvolvimento. Não confirma publicação, integração no Supabase nem coleta nacional real.

## Extração nativa e publicação

O executor Python usa PostgreSQL para guardar páginas do endpoint nativo OpenResults. Cada transação verifica a tarefa running, token/validade do lease e capacidade antes de gravar linhas, recibo e cursor juntos. Reinício e espera por orçamento retomam a primeira página não confirmada. Grupos completos não são consultados novamente. Uma resposta perdida depois do commit pode ser repetida com o mesmo conteúdo sem duplicar linhas ou avançar duas vezes.

O checkpoint registra identidade da fonte/edição, data, cidade/UF/país observados, endpoint, cabeçalhos, modalidades, contagens esperadas, versão do parser e tamanho da página. O protocolo passa a versão 2 na API e no Python: checkpoints v1 não confirmavam a localização no manifesto e são incompatíveis, sem conversão ou reinício automático. Histórico e resultados publicados permanecem; uma nova coleta deve ser intencional. Incompatibilidade, total alterado, repetição de linhas, salto de offset ou fim sem evidência interrompem o trabalho. Ausência de `hasMore` só permite inferir término com um total válido. A string `false` é terminal, não verdadeira; totais/offsets fracionários são recusados.

Somente um conjunto completo, sem divergências e ainda associado à mesma edição pode substituir os resultados publicados. A leitura das linhas intermediárias é por cursor, sem reunir a edição inteira em memória. Exclusão do conjunto anterior, inserção do novo, atualização do checkpoint e conclusão da tarefa são atômicas. Falha na publicação mantém os resultados anteriores e o checkpoint pronto. Um checkpoint pronto pode publicar sem novas requisições à fonte, respeitando lease, associação, validade e capacidade.

Início e publicação relêem referência e edição sob lock: URL/ID, data e localização conhecida precisam ser compatíveis. A publicação revalida a edição atual, inclusive depois de um checkpoint ficar pronto. O caminho DOM aplica a mesma proteção antes de substituir linhas. Campo ausente conserva o canônico; país conflitante/não reconhecido impede a operação. Correções administrativas de localização são preservadas; data divergente continua impedindo publicação mesmo quando foi revisada. Estas garantias de identidade não tornam o fallback DOM retomável por página.

## Retomada administrativa

`GET /v1/tasks/{id}` acrescenta `checkpoint` para tarefas `extract/openresults`. Campos: `available`, `reason`, `rootId`, `status`, `parserVersion`, `pageSize`, `groups`, `completedGroups`, `pages`, `records`, `expiresAt`. Os contadores incluem linhas intermediárias; não significam resultados publicados. O resumo não expõe linhas, nomes de atletas, HTML, URL da fonte ou manifesto bruto. A autorização e restrição de proprietário da tarefa continuam aplicadas.

`POST /v1/tasks/{id}/retry`, JWT admin e `Idempotency-Key`, continua exigindo tarefa failed/partial:

- `mode=resume`: catálogo mantém seu contrato anterior; extração OpenResults aceita checkpoint coletando/pronto, compatível, não expirado e sem outra tarefa queued/running utilizando-o. Cria nova tarefa com vínculo ao histórico e reserva o checkpoint atomicamente.
- `mode=restart`: cria uma nova extração desde o início, com checkpoint próprio; remove o ponteiro ao checkpoint de uma tentativa retomada. Sincronização de catálogo exige criar outro ciclo para reiniciar, como antes.
- Repetir a mesma chave/payload devolve a tarefa já criada, mesmo se o checkpoint avançou ou foi publicado. Trocar o payload sob a mesma chave retorna 409. Outra chave de retomada enquanto o checkpoint está em uso retorna 409 `result_checkpoint_in_use`.

Erros seguros adicionais: `result_checkpoint_incompatible`, `result_checkpoint_expired`, `result_checkpoint_unavailable`, `association_changed`, `edition_date_unconfirmed`, `edition_date_mismatch`, `edition_location_conflict`, `edition_location_unconfirmed`, `source_identity_mismatch` e `source_identity_already_associated`. Conflitos de identidade exigem revisão e não geram retries automáticos. Estrutura inconsistente permanece `source_structure_changed`; contagem incompleta permanece `incomplete_extraction`. Checkpoint incompatível/inválido não é retomável; requer revisão e nova coleta intencional. Bloqueio de acesso mantém as páginas confirmadas, mas retomada de tarefa não remove o bloqueio da fonte.

O painel oferece retomada somente quando o resumo indica disponibilidade; nova tentativa do início é uma opção distinta. A chave permanece por usuário/tarefa/mode após resposta incerta. Retenção por capacidade e espera por orçamento não aparecem como conclusão ou erro de fonte.

## Retenção, segurança e integração

Migration aditiva `20261001000400_result_checkpoints`: quatro tabelas privadas com RLS e revogação de acesso direto PUBLIC/anon/authenticated. A tarefa raiz é protegida contra limpeza operacional enquanto o checkpoint estiver em uso ou ainda puder ser retomado. Resultados permanentes não dependem dessas tabelas.

Validade inicial: sete dias a partir da primeira página/manifesto, sem renovação indefinida por tentativas. A limpeza do worker remove linhas intermediárias expiradas em lotes de até 25, sem tocar dados de lease running válido ou ResultSet/RaceResult. Recibos e contadores permanecem no histórico; linhas intermediárias são removidas também após publicação bem-sucedida. Limpeza de históricos pode remover raízes vencidas/inativas, sem apagar resultados permanentes.

A migration foi preparada para o banco local isolado; não aplicada ao race-platform-staging nesta entrega. A integração futura exige migration antes de atualizar API e executor Python e publicar o frontend. O inicializador local verifica as quatro tabelas antes de iniciar consumidores. Nenhum agendamento é ativado.

A revisão de identidade/protocolo v2 não acrescenta migration; depende das migrations anteriores deste PR. Atualizar API e Python juntos antes de retomar tarefas, para não apresentar checkpoints antigos como disponíveis. Não altera pedidos antigos nem corrige metadados históricos em massa.

## Limites e validação pendente

Checkpoint por página cobre o endpoint nativo, inclusive quando o Chromium descobre esse endpoint. O fallback que entrega resultados diretamente do DOM ainda consolida em memória; não possui retomada por página. Nenhuma proteção contorna bloqueios da fonte. Isso precisa de evolução se uma edição real exigir esse caminho e exceder uma janela de execução.

Manifesto e totais compatíveis não provam que a fonte manteve todas as linhas idênticas entre janelas; sem versão de conjunto/snapshot fornecida pela fonte, uma extração retomada não é um snapshot simultâneo garantido. Mudanças observáveis são recusadas. A homologação real deve comparar contagens e amostras e registrar esse limite.

Regressões usam PostgreSQL descartável e transportes controlados: retomada após orçamento, grupos completos, checkpoint pronto sem HTTP, rollback de página/publicação, lease vencido, alteração de estrutura/total, duplicatas, expiração e idempotência da API. Esses testes não comprovam extração real nem cobertura integral das fontes. Agenda semanal, reconciliação do catálogo e aceite nacional continuam pendentes.
