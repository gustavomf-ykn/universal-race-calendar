# Atualização semanal — integrada, agenda desativada

Em 07/10/2026, Backend #12 e Frontend #3 foram integrados e publicados em homologação, e a migration semanal foi aplicada/repetida no `race-platform-staging`. O painel autenticado confirmou a agenda desativada, revisão 0. Ainda não houve ocorrência semanal real. As seções de desenvolvimento abaixo registram as etapas anteriores; não habilitar a agenda automaticamente nem interpretar os pilotos limitados como cobertura completa.

O módulo puro `catalog-weekly-clock.ts` calcula ocorrências no fuso `America/Sao_Paulo`, com segunda-feira às 08:00 como proposta inicial. Dia ISO (1=segunda, 7=domingo), hora e minuto são configuráveis e validados. Não conecta ao banco, habilita agendas, enfileira trabalho ou consulta fontes.

A recorrência avança por semana local, sem somar 168 horas UTC. Horário local inexistente por mudança de offset usa o primeiro minuto disponível no mesmo dia (até três horas), declarando o deslocamento. Horário repetido usa a primeira ocorrência: não gera duas semanas para o mesmo dia local. Configuração/datas inválidas ou horário não resolvível falham explicitamente.

Para retomada offline, uma próxima data local persistida e pertencente à mesma revisão de configuração é consolidada em uma única ocorrência vencida mais recente. `coalescedWeeks` informa quantas ocorrências intermediárias foram consolidadas; `firstDueLocalDate` conserva o início do atraso. Próxima data avança para a semana seguinte. Isso é cálculo, não garantia de idempotência de gravação.

Regressões com relógio controlado cobrem limite exato do horário, diferença entre dia UTC/local, semanas perdidas, mudança de offset, minuto inexistente/repetido e entradas inválidas.

## Backend persistido

A migration aditiva `20261004000000_catalog_weekly` cria configuração desativada e histórico operacional com RLS/ACL. Aplicada e repetida somente em bancos sintéticos locais, não no Supabase. Os controles estão implementados na branch do Frontend #3; integração e aceite real permanecem pendentes.

Rotas implementadas, com JWT admin validado no backend:

- `GET /v1/admin/catalog/weekly?page=1&limit=10`: schedule, active, data, pagination e serverTime. Limit até 100. Sem ownerId; configuração com revisão, fuso/horário, opções, próxima ocorrência, lastSuccessAt, waitReason e overdue.
- `POST /v1/admin/catalog/weekly/configure`: enabled, expectedRevision, reason; weekday 1–7, hour 0–23, minute 0–59; recentDays 1–365, historicalEveryWeeks 1–52, batchSize 1–25, snapshotLimit 5–1000, prefixLimit 25–10000 e states com 1–27 UFs distintas. Padrões: segunda 08:00, 90 dias, histórico a cada quatro semanas, lote cinco, snapshot 250, prefixos 10000 e todas as UFs. Não enfileira imediatamente.
- `POST /v1/admin/catalog/weekly/occurrences/{id}/cancel`: reason; cancela somente tarefas pendentes vinculadas ao ciclo, preservando tarefas externas, decisões, resultados e auditoria. Recusa qualquer etapa running. Não reativa ciclo cancelado por retomada da descoberta ou nova tentativa genérica de suas etapas.

POSTs exigem Idempotency-Key (até 100 caracteres) e reason (3–500). Replay devolve a resposta original; chave com payload diferente retorna 409 idempotency_conflict, revisão obsoleta weekly_revision_conflict. O cliente deve salvar intenção/chave/payload por usuário antes do envio e reenviar após resposta incerta. Cancelamento: weekly_occurrence_in_use, weekly_occurrence_finished, weekly_occurrence_not_found. Não fornecer chave interna ou credenciais administrativas ao navegador.

Somente o worker TypeScript contínuo, sem seleção por IDs, coordena. Batch/Actions e modo seletivo não criam ocorrências. Locks/unicidade: uma ocorrência por revisão/data local e no máximo uma ativa; ciclo nacional equivalente adia com weekly_scope_in_use. Pressão de recursos/capacidade impede novo trabalho. Criação atômica da ocorrência, três ciclos e três tarefas iniciais, uma por fonte. Continuação/checkpoints existentes processam etapas pequenas.

Estados: discovery, enrichment, reconciliation, blocked, completed, completed_with_review, partial, cancelled. O coordenador espera pelo enriquecimento antes de criar um único cruzamento. Também espera a confirmação da tarefa: recibo de cruzamento terminal com tarefa queued/running não é sucesso. Hold mostra blocked; falha ou descoberta limitada não registra lastSuccessAt. Retry de metadados bem-sucedido substitui a falha vigente sem apagar histórico. Desativar impede novas ocorrências, mas acompanha a atual; cancelamento é separado.

Offline: uma ocorrência vencida mais recente conserva firstDueLocalDate/coalescedWeeks e calcula a próxima futura. A janela recente é filtro local, sem presumir paginação ordenada. Varredura histórica periódica sem janela segue semanas do calendário; atraso que cruza esse período também exige histórico. Limites alcançados continuam limitados.

coverageVerified=false e resultsCollected=false são explícitos: completed não comprova todos os IDs das fontes, publicação de candidatos nem novos resultados. Resultados/publicação continuam fluxos separados.

Validação local: 26 testes aprovados (sete de relógio, dezenove SQL/JWT), incluindo concorrência, resposta perdida, pressão real de disco, capacidade ausente, ciclo concorrente, enriquecimento, hold, confirmação do cruzamento, recuperação de checkpoint, cancelamento seletivo e autorização. Processos Node separados comprovam ocorrência persistida sem duplicação ou consumo de pedido externo; leitor com SELECT não enxerga configuração/histórico protegidos por RLS. Intervalo offline que começa numa semana histórica preserva essa varredura. Retomada bem-sucedida do cruzamento conserva a falha anterior no histórico sem tratá-la como falha vigente. Observação de ciclo existente não segura o lock de capacidade antes do lock de início do cruzamento manual. Algoritmo real de cruzamento executado contra catálogo sintético vazio; sem consultas às fontes ou aceite no navegador. Frontend tem 48 regressões locais, incluindo sete da agenda.

## Histórico do cálculo puro

O texto acima sobre módulo puro descreve somente o relógio, que continua sem efeitos externos. Persistência, unicidade transacional, coordenador, rotas administrativas e controles do painel foram acrescentados nas branches. Ainda faltam CI final, integração autorizada e uma ocorrência semanal real após habilitação específica.

Sem nova mensalidade, execução depende do computador ligado e dos executores locais ativos. Não registrar serviço/autostart, usar pings para impedir suspensão ou habilitar GitHub schedules. Nenhuma agenda foi ativada nesta entrega; cobertura 100% permanece não comprovada.
