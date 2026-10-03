# Atualização semanal — cálculo implementado, agenda ainda pendente

O módulo puro `catalog-weekly-clock.ts` calcula ocorrências no fuso `America/Sao_Paulo`, com segunda-feira às 08:00 como proposta inicial. Dia ISO (1=segunda, 7=domingo), hora e minuto são configuráveis e validados. Não conecta ao banco, habilita agendas, enfileira trabalho ou consulta fontes.

A recorrência avança por semana local, sem somar 168 horas UTC. Horário local inexistente por mudança de offset usa o primeiro minuto disponível no mesmo dia (até três horas), declarando o deslocamento. Horário repetido usa a primeira ocorrência: não gera duas semanas para o mesmo dia local. Configuração/datas inválidas ou horário não resolvível falham explicitamente.

Para retomada offline, uma próxima data local persistida e pertencente à mesma revisão de configuração é consolidada em uma única ocorrência vencida mais recente. `coalescedWeeks` informa quantas ocorrências intermediárias foram consolidadas; `firstDueLocalDate` conserva o início do atraso. Próxima data avança para a semana seguinte. Isso é cálculo, não garantia de idempotência de gravação.

Regressões com relógio controlado cobrem limite exato do horário, diferença entre dia UTC/local, semanas perdidas, mudança de offset, minuto inexistente/repetido e entradas inválidas.

## Trabalho que permanece

1. Persistir configuração inicialmente desativada, versão, próxima ocorrência e histórico com unicidade por configuração/ocorrência.
2. Coordenador transacional com locks: no máximo um ciclo por ocorrência, consolidação offline e ausência de ciclo equivalente concorrente. Não criar tarefas em modo seletivo ou quando faltar capacidade/recursos.
3. Reaproveitar descoberta/checkpoints/continuação das três fontes e separar enriquecimento, cruzamento, publicação e resultados. Uma tarefa concluída ou descoberta esgotada não comprova atualização de todos os dados.
4. Controles administrativos pelo painel (JWT admin, auditoria, idempotência), atraso/último sucesso/cobertura/falhas visíveis e configuração persistida após resposta perdida.
5. Testes de concorrência/reinício/pausa e ocorrência real após integração e habilitação explicitamente autorizadas.

Sem nova mensalidade, execução depende do computador ligado e dos executores locais ativos. Não registrar serviço/autostart, usar pings para impedir suspensão ou habilitar GitHub schedules. Nenhuma agenda foi ativada nesta entrega; cobertura 100% permanece não comprovada.
