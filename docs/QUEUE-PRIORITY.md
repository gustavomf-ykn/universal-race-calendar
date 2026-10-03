# Prioridade compartilhada da fila

Implementada na branch nacional, ainda não aplicada ao Supabase. Ambos os clientes usam as mesmas funções PostgreSQL; o frontend e os payloads não escolhem a prioridade.

A seleção compara todas as fontes elegíveis que o consumidor pode atender, em vez de retornar a primeira fonte por ordem alfabética. Exportações individuais/consolidadas têm classe 0; pedidos interativos de calendário, resultados, inspeção e curadoria individual têm classe 1; etapas de catálogo, continuação e cruzamento e curadoria em lote têm classe 2. Dentro da classe, a ordem é criação e ID.

Após 15 minutos desde a criação, uma tarefa elegível passa à classe 0, para que um fluxo contínuo de novos pedidos não a ultrapasse indefinidamente. Idade não comprova execução, prazo máximo ou disponibilidade do executor. Um estoque antigo pode atrasar pedidos novos; a política não interrompe tarefas em andamento. Etapas nacionais pequenas devolvem o executor à fila; pedidos legados grandes ainda podem ocupá-lo até terminar.

Retenções administrativas/capacidade, `availableAt`, bloqueios de fonte e seleção por IDs continuam sendo requisitos anteriores à prioridade. Envelhecer não libera nenhum deles. Leases expirados são recuperados apenas nas fontes/IDs permitidos. Um executor vencido não conclui nem renova a tarefa recuperada. Mantêm-se exclusão por fonte e exclusão conjunta TicketSports/CorridasBR/maintenance. API Python/OpenResults e exportação têm slots separados, mas um único processo Python executa uma tarefa por vez.

Migrations aditivas `20261003000100_queue_priority` e `20261003000200_queue_priority_timestamp` substituem a seleção e ajustam o helper ao tipo TIMESTAMPTZ do schema de fila. A segunda corrige o tipo sem reescrever migration já aplicada localmente. Aplicar toda a sequência, nunca somente a primeira. Helper/funções operacionais sem EXECUTE público, anon ou authenticated. Nenhuma coluna de prioridade nem novo secret.

Integração futura autorizada: verificar destino/backup de staging, parar consumidores antigos, aplicar migrations e repetir o comando, atualizar executores/preflights e iniciar somente após inventário das tarefas elegíveis. A API e o contrato de tarefas não mudam nesta etapa. O inicializador conjunto verifica o helper de tipo correto antes de iniciar consumidores.

Regressões controladas verificam comparação entre fontes, preferência de exportação, envelhecimento/limiar, holds/delays/bloqueios/seleção, concorrência, recuperação/fencing e o cliente Python real adquirindo uma tarefa sintética sem acessar fontes. Não comprovam latência de uma carga nacional ou atendimento no site publicado. Agenda semanal e proteção de memória/disco são entregas separadas.
