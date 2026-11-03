> Registro histórico arquivado em 19/10/2026. Descreve evidências e decisões da época, não o estado atual nem uma autorização para executar comandos. Para retomar, leia [CONTINUITY.md](../../CONTINUITY.md) e [AWS-HOSTING.md](../AWS-HOSTING.md). Credenciais, backups, logs privados e capturas não acompanham este arquivo.

# Plano de cobertura nacional e atualização semanal do Runfinder

Data: 02/10/2026. Este documento é um plano; não ativa coletas, executores ou agendamentos, nem autoriza integração, migrations ou publicação.

Atualização em 07/10/2026: Backend #12 e Frontend #3 integrados; staging com 29 migrations, API a8b360f e painel publicado a partir da main ebbabd4. Capacidade interna confirmada dentro do plano Free: banco 200 MiB/Storage 100 MiB, sem contratar ou aumentar plano. Pilotos reais seletivos concluíram etapas pequenas nas três fontes; OpenResults criou cinco candidatos. Um piloto TicketSports ampliado posterior processou cinco candidatos, criou três e reconheceu dois existentes. Não há recibos de término nacional ou prova de cruzamento integral. Uma inspeção TicketSports permanece na fila após duas falhas; a causa Unicode foi reproduzida com dados já armazenados e corrigida no PR #13, ainda sem integração. Diagnósticos obsoletos de país/modalidade e preservação de publicação em atualização parcial também estão nesse PR. Agenda **desativada, revisão 0**; execução semanal local depende do computador e executores ligados, enquanto dados/arquivos continuam no Supabase. Os pedidos antigos protegidos permanecem intactos. Evidências e pendências atuais em `INTEGRACAO-CATALOGO-STAGING-2026-10-07.md`.

Histórico de 03/10/2026, anterior à integração: branches nacionais com CI aprovado e migrations somente sintéticas; detalhes em `NATIONAL-CATALOG-PROGRESS-2026-10-03.md` e `INTEGRACAO-CATALOGO-STAGING-2026-10-03.md`. Esse histórico não descreve as versões publicadas hoje.

## Objetivo

Construir e manter um catálogo unificado das edições brasileiras publicamente acessíveis em TicketSports, CorridasBR e OpenResults. Operar carga inicial, atualizações, revisão e exportação pelo painel, após iniciar os executores locais uma vez por sessão.

Cobertura deve ser comprovada por fonte e intervalo da varredura. Esgotar um limite configurado não equivale a esgotar a fonte. Páginas bloqueadas, históricos indisponíveis e mecanismos sem término verificável devem aparecer como limitações. Catálogo completo das três fontes não significa todas as corridas existentes no Brasil, nem resultados disponíveis para todas as provas.

Não excluir silenciosamente outras modalidades ou candidatos com país desconhecido. Descobertos, brasileiros confirmados, publicados e com resultados são conjuntos distintos.

## Ponto de partida e verificação inicial

A documentação local registra mecanismos existentes de fila, leases, idempotência, revisão, exportação, descoberta ampliada e checkpoints. Há também trabalho nas branches nacionais que ainda precisa de revisão e integração. Aproveitar essas entregas, completar lacunas e testar o conjunto. A leitura dos documentos nesta rodada não substitui uma nova consulta ao CI, às versões publicadas ou às fontes reais.

Antes de desenvolver ou executar cargas:

1. Conferir branches, alterações locais, PRs e CI do último commit dos dois repositórios; preservar trabalho existente.
2. Conferir versões da API, frontend e executores, schema e migrations pendentes.
3. Inventariar fila, tarefas protegidas e executores ativos, sem consumir pedidos.
4. Medir espaço de banco/Storage e recursos locais; definir orçamento e concorrência inicial.
5. Registrar um backlog com defeito/lacuna, arquivos afetados, teste e impacto de implantação.

Aceite: base conhecida e reproduzível, fila protegida e sequência de integração documentada.

## Etapa 1 — Descoberta completa e verificável

| Fonte | Trabalho | Evidência exigida |
|---|---|---|
| TicketSports | Conferir listagem, paginação e filtros realmente suportados; ampliar além do snapshot limitado; percorrer partições aplicáveis e uma passagem nacional para candidatos sem UF | IDs únicos, páginas/partições, total da fonte quando disponível, detecção de truncamento e término comprovado |
| CorridasBR | Percorrer as 27 UFs e as páginas/períodos acessíveis; distinguir calendário vazio, bloqueio e mudança estrutural | Recibos por UF/página e nenhuma partição omitida |
| OpenResults | Percorrer páginas nativas e histórico acessível; detectar repetição e conferir totais quando disponíveis; confirmar país com evidência | Recibos de páginas/IDs, término verificável e candidatos desconhecidos em revisão |

Primeiro validar até cinco candidatos por fonte, separadamente. Conferir o significado de `quantity`: quantidade solicitada, IDs observados, candidatos processados e novos registros não são equivalentes. Não inventar parâmetros de paginação nem contornar bloqueios.

Aceite: provas antes ausentes persistem e aparecem pela API; todo ID observado tem destino explicado: novo, existente, duplicado, fora do escopo, pendente ou falha.

## Etapa 2 — Continuação durável, capacidade e cobertura

- Persistir ciclo, escopo, partição, cursor, versão do parser, recibos e contagens.
- Confirmar alterações e checkpoint na mesma transação, protegida pelo lease.
- Continuar etapas elegíveis automaticamente; disponibilizar pausa, retomada e cancelamento com histórico.
- Recusar checkpoints incompatíveis, sem reiniciar implicitamente o pedido anterior.
- Reservar prioridade para solicitações manuais e exportações; limitar concorrência, requisições, memória e disco.
- Pausar antes de esgotar banco ou Storage; mostrar motivo e condição de retomada.
- Interromper fonte bloqueada sem retries indefinidos; preservar trabalho e dados válidos.
- Exibir IDs únicos e contagens por fonte/UF/período. Percentual somente com denominador verificável; partições sobrepostas não devem inflar o catálogo.

Aceite: reinício retoma etapas confirmadas; lease vencido não grava; exportações continuam atendidas durante carga; conclusão parcial nunca aparece como cobertura completa.

## Etapa 3 — Cruzamento e qualidade dos dados

- Guardar valor observado, fonte, URL e data da observação para os campos importantes.
- Validar nome, edição, data, cidade, UF, país e modalidade; corrigir encoding e textos de navegação com evidência.
- Associar automaticamente apenas quando existir evidência forte de identidade e compatibilidade da edição. Nome parecido sozinho não basta.
- Separar anos, datas e localidades conflitantes; encaminhar ambiguidades à seleção visual administrativa.
- Reconciliar registros já separados, preservando referências, resultados, exportações, IDs antigos e auditoria.
- Atualizar edições existentes sem substituir campos válidos por dados incompletos; preservar correções manuais e decisões de ocultação/rejeição.
- Não apagar automaticamente uma prova porque deixou de aparecer numa listagem posterior.

Aceite: correspondência real entre fontes, atualização de edição existente e conflitos controlados demonstram união correta e preservação dos dados anteriores.

## Etapa 4 — Operação pelo painel

- Controles de carga inicial, atualização imediata, escopo e progresso por fonte.
- Indicação de executor disponível, espera, execução, parcialidade, conclusão e falha.
- Pausa/retomada, cancelamento de pendentes e repetição de falhas, distinguindo nova tentativa de retomada por checkpoint.
- Revisão de incompletos/não publicados, associação visual, publicação, ocultação e rejeição com JWT admin validado no backend e auditoria.
- Idempotência persistida por usuário, edição/escopo, operação e payload; reutilizar chave após timeout/perda de resposta e gerar outra para nova solicitação intencional.
- Atualização de calendário/detalhes após conclusão e tratamento da retomada lenta da API.
- Exportação individual/consolidada XLSX/ZIP, acompanhamento e download autorizado; diferenciar arquivo expirado de link expirado.

Aceite: no navegador autenticado, iniciar executores uma vez e operar importação, acompanhamento, revisão e download sem comandos por solicitação. Frontend sem chave interna ou credenciais de banco/workers.

## Etapa 5 — Atualização semanal

Implementar agenda persistida com fuso `America/Sao_Paulo`, próxima ocorrência, histórico e controle pelo painel. Proposta inicial: segunda-feira às 08h, configurável e desabilitada por padrão.

O coordenador local deve:

1. Criar no máximo um ciclo por ocorrência e evitar outro ciclo equivalente ainda ativo.
2. Priorizar novas/futuras e alterações recentes. Janela inicial proposta: últimos 90 dias e futuras; só limitar descoberta por data se os mecanismos reais da fonte garantirem que não perde edições.
3. Programar reconciliação histórica periódica após medir volume e duração do piloto.
4. Manter coleta de resultados como etapa separada, com associações verificadas e orçamento próprio.
5. Registrar atraso quando o computador estiver desligado e consolidar ocorrências perdidas ao retornar, sem criar uma carga por semana perdida.
6. Mostrar último sucesso, atraso, cobertura e falhas no painel.

Na configuração sem nova mensalidade, o computador precisa estar ligado e os executores ativos para executar no horário. Agenda persistida não elimina essa dependência. Não usar pings para impedir suspensão da API.

Aceite: relógio controlado comprova fuso, ocorrência única, concorrência e recuperação offline; uma ocorrência semanal real após habilitação autorizada comprova operação.

## Etapa 6 — Integração e homologação progressiva

1. Entregar PRs separados para backend/frontend, regressões e CI dos commits finais; listar migrations aditivas e compatibilidade.
2. Apresentar sequência de integração: confirmar staging e backup; aplicar migrations necessárias; atualizar explicitamente API e executores; publicar frontend. Integração/publicação dependem de autorização específica.
3. Conferir versões reais e informar as tarefas elegíveis antes de iniciar consumidores.
4. Executar pilotos seletivos, repetição, atualização, associação, interrupção/recuperação e exportação real aberta.
5. Expandir carga inicial gradualmente por partições, sob orçamento e capacidade, até reconciliar as partes acessíveis. Registrar início/fim: as fontes mudam durante a varredura.
6. Validar no navegador autenticado e apresentar relatório de cobertura.
7. Habilitar a agenda somente após autorização e acompanhar a primeira ocorrência real.

Usar exclusivamente `race-platform-staging`. Sem produção, recursos pagos, coleta por runners GitHub ou ativação automática de schedules.

## Ordem e entregas

| Entrega | Dependência | Resultado |
|---|---|---|
| A. Revisão e backlog | Inventário sem consumo | Lacunas e impactos conhecidos |
| B. Adaptadores e evidências | A | Descoberta verificável das três fontes |
| C. Continuação, cruzamento e recursos | B | Execução durável e associação conservadora |
| D. Controles no painel | Contratos estáveis de B/C | Operação administrativa e exportação sem terminal por pedido |
| E. Agenda semanal | C e controles de D | Fuso, ocorrência única e recuperação offline; ainda desativada |
| F. Integração staging | CI e autorização | API, schema, executores e frontend compatíveis/publicados |
| G. Pilotos, carga inicial e semana real | F | Cobertura medida e aceite autenticado |

Os adaptadores podem ser desenvolvidos separadamente. O frontend pode avançar com contratos controlados, mas seu aceite real depende da integração. Estimar esforço após fechar o backlog; estimar duração/espaço da carga após medir o piloto. Não prometer prazo de cobertura antes de conhecer volume e disponibilidade das fontes.

## Aceite final

- Cobertura declarada por fonte/período, com páginas/partições reconciliadas e bloqueios explícitos.
- Catálogo cresce e atualiza edições reais pela API e painel, sem duplicatas indevidas.
- Cruzamento conserva referências, IDs, correções, resultados e histórico.
- Timeout/cliques repetidos não duplicam pedidos; reinício retoma checkpoint e lease vencido não sobrescreve.
- Bloqueio/coleta parcial não elimina resultados válidos.
- Exportação real baixada e aberta, com linhas/cabeçalhos conferidos e Storage privado.
- Operação cotidiana pelo painel após iniciar executores uma vez.
- Atualização semanal única, atraso visível e recuperação offline comprovados.

Relatório final deve separar testes automatizados, testes por API e testes no navegador. CI verde e fila vazia não substituem esses critérios.
