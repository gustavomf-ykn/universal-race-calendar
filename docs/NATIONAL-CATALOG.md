# Catálogo nacional — implementação em andamento

Este documento descreve a branch `codex/national-catalog`. Não constitui aceite de cobertura nacional nem confirmação de publicação. A meta permanece percorrer integralmente os catálogos acessíveis das três fontes e cruzar as informações sem misturar edições.

## Implementado

- TicketSports ampliado: filtros de país/UF e aumento de `quantity` conforme a navegação oficial observada em 01/10. Não utiliza parâmetros de offset/página inventados. Percorre UFs selecionadas e uma passagem nacional, incluindo registros sem UF e deduplicando IDs. O fim segue o sinal da interface; limites ocultos e histórico acessível ainda exigem validação real.
- CorridasBR ampliado: segue links explícitos de calendários numerados da mesma UF, preservando query strings. Outros estados/domínios e detalhes não são paginação. URLs visitadas não são repetidas. Uma página vazia exige evidência de calendário válido; bloqueio/erro genérico não é vazio válido.
- Checkpoints transacionais. Cada candidato gera metadados de forma idempotente, inclusive edições existentes. Novos registros começam pendentes.
- Coordenação entre etapas somente com `autoContinue=true`. O executor TypeScript verifica sucessores a cada cinco segundos, incluindo passos OpenResults executados pelo Python. Um reinício recupera a continuação após um passo já concluído. O lock compartilhado com a API impede bifurcação.
- Falha final/parcial interrompe o ciclo; cancelamento da etapa pausa. Ausência de avanço vira `limited`. Pedidos retidos continuam protegidos. Modo seletivo por IDs desativa coordenação automática para não gerar trabalho fora da seleção.
- Pausa/retomada auditadas: reter passos queued desprotegidos, permitir terminar o passo running, liberar somente holds `catalog_sync_paused`. Pedidos protegidos anteriormente não são liberados. Metadados já enfileirados são tarefas separadas; pausar descoberta não os cancela.
- Observações por fonte, data de validação e comparação por campo, sem payload bruto. Ausência não aparece como concordância.
- Campos corrigidos em auditorias `review_event` permanecem protegidos, inclusive nulos intencionais. Extração parcial não apaga escalares/coleções válidas. Referência suplementar não substitui a principal. A observação conserva os dados recebidos da fonte mesmo quando o canônico é preservado.
- Orçamento compartilhado no PostgreSQL: padrão de 100 tentativas HTTP por hora por fonte e intervalo mínimo de um segundo, reduzíveis pelo administrador. Cada transporte de catálogo, detalhe, retry, redirect e Chromium passa pela reserva. Requisições de páginas relacionadas permitidas contam no orçamento da fonte da tarefa. DNS inválido não abre transporte. HTTP 401/403/429 fecha a fonte no primeiro retorno e 429 não provoca retries insistentes.
- Orçamento esgotado devolve a tarefa à fila para a próxima janela, sem gastar uma tentativa e sem apagar seu checkpoint. Isso não implementa checkpoint de páginas de resultados: uma extração ainda em memória pode precisar recomeçar; esse caso precisa de persistência intermediária antes de homologar edições muito grandes.
- Bloqueio fecha a aquisição por fonte, inclusive de novos pedidos, e retém queued anteriores sem substituir holds preexistentes. Passos de descoberta não geram sucessores enquanto a fonte está bloqueada. A tarefa que encontrou o bloqueio explícito mantém falha e histórico. Pedidos que encontraram o circuito já aberto aguardam retomada.
- Retomada manual auditada, respeitando `Retry-After` quando observado. Passar o prazo não libera automaticamente uma fonte. A retomada libera somente holds `source_access_blocked`; não repete tarefas com falha nem remove proteções anteriores. Alterar limites não zera uso ou remove bloqueios. Repetir uma chave antiga não reabre uma fonte bloqueada novamente.

## Contrato administrativo

JWT admin validado pelo backend; chave interna nunca no frontend. POSTs abaixo exigem `Idempotency-Key`.

`POST /v1/admin/syncs` acrescenta `discoveryMode=bounded|national`, `prefixLimit` (25–10000) e `autoContinue` booleano. Padrões: `bounded`, 10000, false. Campos existentes: source, states, batchSize, snapshotLimit, from, to. UFs precisam ser brasileiras e únicas. Omitir from/to não impõe janela temporal local. Atingir o teto TicketSports sem fim comprovado é limitação explícita, nunca cobertura completa.

`GET /v1/admin/syncs?page=1&limit=20` acrescenta paginação, tarefa mais recente, `autoContinue`, `pauseRequested` e recibos sanitizados; não expõe snapshots. TicketSports: prefixo final pedido/recebido e IDs por partição. CorridasBR: páginas lidas, referências observadas e IDs distintos por UF. Partições podem se sobrepor; não somar recibos como total de edições.

`POST /v1/admin/syncs/{id}/pause` pausa entre etapas. `POST /v1/admin/syncs/{id}/resume` retoma checkpoint/histórico. Repetir a mesma chave não cria outra retomada.

`POST /v1/admin/syncs/{id}/continue` continua manualmente. Replay devolve a tarefa original mesmo depois de avançar checkpoint. Rejeita ciclo pausado, concluído/limitado ou com passo ativo.

`GET /v1/admin/catalog/events/{id}/comparison` mostra valores canônicos e validados por fonte para nome, data, cidade, UF, país, modalidade e URLs. Compara referências já associadas; reconciliação do catálogo inteiro ainda está pendente.

`GET /v1/admin/source-controls` mostra as três fontes, uso e limite da janela, intervalo, próximo reset, bloqueio e prazo mínimo de retomada. Uma fonte sem histórico utiliza os padrões acima.

`POST /v1/admin/source-controls/{source}/configure`: `limitPerHour` inteiro de 1 a 100, `minDelayMs` inteiro de 1000 a 60000, `reason` de 3 a 500 caracteres. JWT admin e `Idempotency-Key` obrigatórios. Limites são um teto conservador da aplicação; não representam permissão de acesso concedida pela fonte.

`POST /v1/admin/source-controls/{source}/resume`: `reason` e `Idempotency-Key`. Retorna 409 `source_cooldown_active` se o prazo ainda não terminou. A fonte pode continuar inacessível; uma retomada não comprova desbloqueio. Não usar repetidamente para contornar bloqueios.

O painel mostra controles por fonte e diferencia orçamento esgotado, fonte bloqueada, pausa de descoberta e proteção administrativa de pedidos. API e frontend precisam ser publicados para esse contrato ficar disponível em homologação.

## Integração futura

Migrations aditivas `20261001000100_source_observations` e `20261001000200_source_request_controls` antes da API/workers. Aplicadas apenas em PostgreSQL local isolado, não no Supabase. A tabela de controles tem RLS e os grants de tabela/funções são revogados de PUBLIC, anon e authenticated. Inicializador verifica campos e funções antes de iniciar consumidores. Fazer backup e confirmar identidade de staging antes de aplicar; nunca reset.

API requer deploy explícito para novos parâmetros/rotas; executores requerem build e Prisma atualizados. Frontend requer publicação explícita depois da API compatível. Merge não comprova deploy. Nenhuma agenda foi habilitada.

## Evidências e pendências

Consulta limitada CorridasBR/AC em 01/10: dez candidatos, nenhuma próxima página explícita e nomes sem caractere de substituição. Sem persistência ou tarefa. O HTML SC previamente capturado contém `Calendario2.asp`, motivando a correção. Não comprova as 27 UFs.

Regressões em PostgreSQL isolado cobrem expansão TicketSports, passagem nacional sem UF, deduplicação/navegação CorridasBR, recuperação, concorrência, holds, pausa/retomada, resposta perdida e proteção dos metadados. Não são carga nacional real.

CI do controle de requisições encontrou módulos de suporte ausentes na imagem Python (`source_requests` e o import adiado `source_observation`). O Dockerfile inclui esses módulos e verifica os imports de inicialização, inspeção e exportação durante o build, sem acessar serviços. A execução dos três processos e o smoke de Chromium continuam como verificações separadas do CI.

Antes da varredura nacional real faltam:

1. Controle de capacidade de banco/Storage e checkpoint de páginas de resultados para extrações que excedam o orçamento de uma janela.
2. OpenResults: recibos completos, ciclos não consecutivos, país, metadados dos candidatos e término conciliado com totais disponíveis.
3. Reconciliação de candidatos inicialmente separados, vínculos com evidência forte e publicação automática estrita rua/trail.
4. Agenda semanal durável/fuso/ocorrências perdidas, prioridade manual e resultados recentes como etapa separada.
5. Testes reais progressivos nas três fontes, conciliação de IDs/histórico e aceite pelo navegador após publicação.

Descoberta encerrada não significa metadados validados, publicação concluída ou resultados coletados. A meta de 100% permanece não comprovada.
