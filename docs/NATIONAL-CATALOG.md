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
- Bloqueios reconhecidos encerram tentativas daquela tarefa com código sanitizado. O circuito por fonte para impedir tentativas por outras tarefas ainda está pendente.

## Contrato administrativo

JWT admin validado pelo backend; chave interna nunca no frontend. POSTs abaixo exigem `Idempotency-Key`.

`POST /v1/admin/syncs` acrescenta `discoveryMode=bounded|national`, `prefixLimit` (25–10000) e `autoContinue` booleano. Padrões: `bounded`, 10000, false. Campos existentes: source, states, batchSize, snapshotLimit, from, to. UFs precisam ser brasileiras e únicas. Omitir from/to não impõe janela temporal local. Atingir o teto TicketSports sem fim comprovado é limitação explícita, nunca cobertura completa.

`GET /v1/admin/syncs?page=1&limit=20` acrescenta paginação, tarefa mais recente, `autoContinue`, `pauseRequested` e recibos sanitizados; não expõe snapshots. TicketSports: prefixo final pedido/recebido e IDs por partição. CorridasBR: páginas lidas, referências observadas e IDs distintos por UF. Partições podem se sobrepor; não somar recibos como total de edições.

`POST /v1/admin/syncs/{id}/pause` pausa entre etapas. `POST /v1/admin/syncs/{id}/resume` retoma checkpoint/histórico. Repetir a mesma chave não cria outra retomada.

`POST /v1/admin/syncs/{id}/continue` continua manualmente. Replay devolve a tarefa original mesmo depois de avançar checkpoint. Rejeita ciclo pausado, concluído/limitado ou com passo ativo.

`GET /v1/admin/catalog/events/{id}/comparison` mostra valores canônicos e validados por fonte para nome, data, cidade, UF, país, modalidade e URLs. Compara referências já associadas; reconciliação do catálogo inteiro ainda está pendente.

## Integração futura

Migration aditiva `20261001000100_source_observations` antes da API/workers. Aplicada apenas em PostgreSQL local isolado, não no Supabase. Inicializador verifica campos antes de iniciar consumidores. Fazer backup e confirmar identidade de staging antes de aplicar; nunca reset.

API requer deploy explícito para novos parâmetros/rotas; executores requerem build e Prisma atualizados. Frontend requer publicação explícita depois da API compatível. Merge não comprova deploy. Nenhuma agenda foi habilitada.

## Evidências e pendências

Consulta limitada CorridasBR/AC em 01/10: dez candidatos, nenhuma próxima página explícita e nomes sem caractere de substituição. Sem persistência ou tarefa. O HTML SC previamente capturado contém `Calendario2.asp`, motivando a correção. Não comprova as 27 UFs.

Regressões em PostgreSQL isolado cobrem expansão TicketSports, passagem nacional sem UF, deduplicação/navegação CorridasBR, recuperação, concorrência, holds, pausa/retomada, resposta perdida e proteção dos metadados. Não são carga nacional real.

Antes da varredura nacional real faltam:

1. Orçamento/circuito durável por fonte, incluindo detalhes, retries, redirects e navegador; controle de capacidade.
2. OpenResults: recibos completos, ciclos não consecutivos, país, metadados dos candidatos e término conciliado com totais disponíveis.
3. Reconciliação de candidatos inicialmente separados, vínculos com evidência forte e publicação automática estrita rua/trail.
4. Agenda semanal durável/fuso/ocorrências perdidas, prioridade manual e resultados recentes como etapa separada.
5. Testes reais progressivos nas três fontes, conciliação de IDs/histórico e aceite pelo navegador após publicação.

Descoberta encerrada não significa metadados validados, publicação concluída ou resultados coletados. A meta de 100% permanece não comprovada.
