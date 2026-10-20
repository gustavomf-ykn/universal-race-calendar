> Registro histórico arquivado em 19/10/2026. Descreve evidências e decisões da época, não o estado atual nem uma autorização para executar comandos. Para retomar, leia [CONTINUITY.md](../../CONTINUITY.md) e [AWS-HOSTING.md](../AWS-HOSTING.md). Credenciais, backups, logs privados e capturas não acompanham este arquivo.

# Plano de catálogo nacional e atualização semanal — Runfinder

Revisão: 02/10/2026. Documento de planejamento; não autoriza nem ativa coletas, agendamentos, migrations, merge ou publicação.

## Situação considerada nesta revisão

Leitura dos arquivos locais e PRs em 02/10, seguida de implementação. Backend 46d51b262472a2cab488411b626492c845982ac5 (PR #12), frontend cfebcec453e26f09a17ed7deec47023de920ccb9 (PR #3) inalterado. Curadoria TS 1.7.0 confere nome/data/cidade/UF da fonte, sem aceitar campos/citações inventados; adaptadores 1.1.0 selecionam JSON-LD por URL e recusam identidade TicketSports divergente. Página vinculada CorridasBR exige mesma edição. Nome ausente conserva o válido e registra observação nula. Antes dos ajustes finais, suíte completa 282 TS aprovada; depois, 99 regressões finais, build/tipos/lint/OpenAPI aprovados. CI do novo HEAD backend37076467710 em acompanhamento; frontend mantém CI anterior aprovado. Enriquecimento Python e protocolo de resultados v2 já conferem identidade/data/localização e conservam dados em conflito. Os PRs permanecem em rascunho, sem integração/publicação. CI controlado não comprova fontes reais, cobertura nacional ou aceite no navegador. Próximas entregas: cruzamento global, prioridade/recursos locais, agenda semanal e homologação progressiva. Evidências em NATIONAL-CATALOG-PROGRESS-2026-10-01.md.

Atualização final da rodada: CI do HEAD 46d51b2 aprovado, run37076467710 e logs dos dois jobs conferidos: 285 TS, 204 Python, containers/Chromium/migrations repetidas/OpenAPI. Não altera versões publicadas nem comprova cobertura real. A referência a CI em acompanhamento acima descreve a verificação anterior à conclusão dos jobs.

O relatório local mais recente registra união manual de registros separados, preservação de IDs antigos, auditoria e consumidores compatíveis nas branches nacionais. Essa entrega deve ser revisada e homologada, sem ser reimplementada. Permanecem como entregas a concluir e comprovar: coordenação global do cruzamento entre as três fontes; política de publicação com evidência; limites locais de memória/disco; agenda semanal durável com recuperação offline; integração dos contratos e migrations em homologação; varredura real progressiva das três fontes e aceite autenticado no painel. Código em branch, teste automatizado e função publicada são estados distintos.

A configuração inicial continua sem nova mensalidade: API existente, Supabase de homologação e dois executores locais iniciados uma vez por sessão. A agenda depende do computador ligado e dos executores ativos; quando estiverem indisponíveis, deve mostrar atraso e consolidar a atualização ao retornar. Não promete execução semanal no horário com o computador desligado.

## Objetivo e definição de cobertura

Construir um catálogo unificado das edições brasileiras de corrida de rua e trail publicamente acessíveis em TicketSports, CorridasBR e OpenResults, preservando a identidade de cada edição e a origem das informações. A carga inicial deve percorrer o histórico que cada fonte efetivamente disponibilizar; a atualização semanal prioriza os últimos 90 dias e todas as edições futuras. Outras modalidades e registros sem país/modalidade confirmados devem ser identificados para revisão, sem classificação inventada.

“Completo” significa esgotar os mecanismos de descoberta comprovados da fonte dentro do escopo, com evidência de término e conciliação dos identificadores encontrados. Não significa todas as corridas existentes no Brasil, informações privadas, páginas bloqueadas ou resultados para toda prova. Se uma fonte não disponibilizar um total ou um término verificável, a cobertura será declarada não comprovada. Tetos de segurança, quantidade pedida, resposta 202 e fila vazia não comprovam cobertura.

Provas descobertas, publicadas e com resultados são conjuntos distintos. O painel deve mostrar suas contagens e os motivos de exclusão ou revisão. Identificadores repetidos em fontes diferentes não devem inflar o total de edições canônicas.

## Base disponível

O relatório operacional de 01/10 comprova API hospedada, fila durável, executores locais, consulta de resultados, revisão administrativa e exportações XLSX/ZIP. Não comprova cobertura nacional.

Esta revisão consultou os checkouts e os relatórios locais; não verificou novamente CI remoto, versões publicadas ou disponibilidade das fontes. O relatório de desenvolvimento mais recente registra checkpoints nativos de resultados e controles de capacidade já implementados nas branches, ainda sujeitos à revisão e homologação. Não refazer essas entregas: revisar, completar as lacunas e testar sua integração.

Na configuração integrada atual, TicketSports usa snapshot limitado; CorridasBR percorre calendários das UFs selecionadas; OpenResults usa páginas nativas com proteção contra repetição e término não confirmado. Já existem checkpoints de catálogo, leases, idempotência, auditoria e proteção dos resultados anteriores. A nova rotina deve reutilizar esses mecanismos e ampliar suas garantias.

As branches `national-catalog-backend` e `national-catalog-frontend` contêm trabalho em desenvolvimento para descoberta ampliada, continuação, comparação de fontes e orçamento compartilhado de requisições. Isso reduz o trabalho restante, mas não equivale a integração, publicação ou homologação nacional. A revisão deve reaproveitar essas alterações e validar o CI dos commits atuais antes de propor integração.

## Marcos e dependências

Sequência prática para concluir o objetivo:

1. Fechar a descoberta verificável nas três fontes, incluindo as 27 UFs e registros sem UF. Medir volume e reconciliar IDs observados; não chamar limite de segurança de fim da fonte.
2. Concluir cruzamento global, atualização de metadados e publicação com evidência. Reaproveitar a união manual existente; manter anos diferentes separados e candidatos incompletos disponíveis para revisão.
3. Completar prioridades, retomada e limites de recursos. A carga nacional não pode impedir exportações/pedidos manuais nem consumir toda a franquia gratuita ou memória/disco local.
4. Concluir os controles de carga, cobertura e revisão no painel, com JWT admin e acompanhamento dos estados reais. O usuário inicia os executores uma vez, sem comandos individuais para cada pedido.
5. Implementar a atualização semanal durável, inicialmente desativada, com horário configurável, consolidação de semanas perdidas e retomada offline. Validar com relógio controlado antes de ativar.
6. Apresentar PRs e sequência de integração; após autorização, homologar pilotos de até cinco candidatos por fonte e ampliar progressivamente até o término comprovado. Validar no navegador e acompanhar uma ocorrência semanal real.

O primeiro pacote concreto é revisar as alterações locais do backend e o CI dos commits atuais, depois completar as lacunas de publicação/cruzamento/recursos antes de habilitar recorrência. Não iniciar uma importação nacional para compensar descoberta ainda não comprovada.

| Marco | Entrega verificável | Condição para avançar |
|---|---|---|
| A — Descoberta | Protocolo comprovado para TicketSports, 27 UFs CorridasBR e páginas OpenResults, incluindo registros sem UF | Término, ciclos, truncamento e bloqueios distinguíveis; país e escopo confirmados ou pendentes explícitos |
| B — Execução durável | Ciclos com checkpoints, continuidade, prioridades, limites compartilhados e pausa por capacidade | Reinício retoma trabalho; lease antigo não grava; orçamento/bloqueio não causa repetição ilimitada |
| C — Catálogo unificado | Enriquecimento, proveniência, reconciliação de registros separados e revisão de conflitos | Nenhuma associação por nome apenas; anos separados; decisões manuais e resultados preservados |
| D — Operação pelo painel | Carga inicial, progresso, cobertura, pausa, retomada, revisão, associação e exportação | JWT admin, idempotência e estados reais comprovados, sem chave interna no frontend |
| E — Agenda | Atualização semanal, fuso, atraso offline e recuperação consolidada | Cada ocorrência cria no máximo um ciclo; não duplica ciclos ativos; mantém prioridade das operações manuais |
| F — Homologação progressiva | Lotes pequenos e depois varredura acessível integral, com recibos e relatório | Capacidade suficiente, versões conferidas e fluxo autenticado validado no navegador |

Segurança, orçamento e capacidade são pré-requisitos da carga nacional, mesmo que a implementação dessas proteções seja desenvolvida em paralelo às etapas de descoberta. A agenda permanece desativada até o aceite; não agendar uma descoberta ainda parcial como se ela entregasse cobertura completa.

## Organização da entrega

1. Revisar os PRs de desenvolvimento existentes e concluir descoberta/recibos, controles e recuperação no backend; acompanhar o CI e a execução real das imagens.
2. Entregar reconciliação, política de publicação e controle de capacidade em mudanças revisáveis, com migrations aditivas quando necessárias.
3. Entregar os controles e relatórios no frontend em PR separado, preservando a sincronização e o visual da Lovable.
4. Acrescentar agenda e testes de atraso/retomada, mantendo sua ativação desabilitada por padrão.
5. Apresentar os commits, migrations, atualização dos executores, deploy da API e publicação do frontend como uma sequência concreta de integração em homologação. A autorização desta solicitação é para planejamento; ela não autoriza executar essa sequência.
6. Após integração autorizada, conferir a fila protegida e testar somente tarefas selecionadas antes de ampliar a carga. Manter pedidos antigos retidos sem liberar ou cancelar implicitamente.

Não estimar prazo da carga nacional a partir de cinco provas: primeiro medir páginas, chamadas de detalhe, bloqueios, tempo por lote e espaço por registro. Se a fonte expuser apenas um subconjunto ou bloquear o acesso, registrar essa limitação; desenvolvimento não pode garantir acesso ao que ela não disponibiliza.

## Etapa 1 — Inventário e protocolo de descoberta

1. Conferir versões publicadas, fila, executores ativos, alterações locais e contratos entre frontend/backend.
2. Observar os filtros, a ordenação e o mecanismo de continuidade reais de cada fonte. Validar país, UF, modalidade e período sem adivinhar parâmetros de paginação.
3. TicketSports: substituir o primeiro snapshot fixo por uma estratégia que avance na listagem comprovada; particionar por UF/período somente quando os filtros funcionarem. Incluir uma passagem nacional para detectar registros sem UF e reconciliar o conjunto das partições. Detectar quantidade ignorada, prefixos repetidos e limites ocultos.
4. CorridasBR: conferir todas as 27 UFs e eventuais divisões por período/página existentes. Guardar evidências da extração por UF e registrar páginas vazias apenas quando a estrutura do calendário estiver válida.
5. OpenResults: percorrer páginas nativas, detectar ciclos e confirmar o fim. Filtrar Brasil com evidência; não presumir país pelo domínio ou UF ausente. Não encerrar a leitura por data sem comprovar a ordenação.

Entrega: protocolo por fonte, limites comprovados, exemplos de fim/erro e estimativa de volume. Aceite: uma fonte bloqueada ou alterada deve produzir diagnóstico explícito, nunca catálogo vazio bem-sucedido.

## Etapa 2 — Sincronização durável e relatório de cobertura

Criar um ciclo nacional com etapas por fonte, UF, período e página/prefixo. Persistir configuração, posição, candidatos, IDs examinados, evidências de término e contagens. Candidato e checkpoint precisam ser gravados na mesma transação; um lease vencido não pode alterar o ciclo recuperado.

Estados devem distinguir espera por executor, execução, pausa, bloqueio, parcialidade e conclusão. Cancelar interrompe etapas futuras e preserva o que já foi validado. Repetir uma falha mantém o histórico; retomar um checkpoint compatível evita repetir etapas concluídas. Mudança de filtros/versão incompatível cria um ciclo distinto.

Automatizar a criação da próxima etapa sem exigir cliques sucessivos. Reservar prioridade para ações manuais e exportações para que uma varredura longa não monopolize os executores.

Persistir também as páginas de resultados OpenResults em uma área intermediária no PostgreSQL. Gravar registros, recibo da página e cursor na mesma transação protegida pelo lease; retomar apenas checkpoints compatíveis com fonte, edição, filtros e versão do parser. Manter o conjunto publicado anterior até validar todas as páginas e contagens do novo conjunto, substituindo-o atomicamente. Uma coleta incompleta, interrompida ou bloqueada não pode apagar resultados válidos. Diferenciar retomada do mesmo trabalho de nova coleta intencional e limitar a retenção dos dados intermediários sem afetar resultados publicados.

O relatório deve separar: encontrados brutos, únicos por fonte, novos, atualizados, duplicatas, fora do escopo, pendentes, falhas e edições unificadas. Exibir cobertura por fonte/UF/período, denominador quando conhecido, último sucesso e evidências. Se o denominador for desconhecido, não apresentar percentual fictício.

Entrega: schema/migrations aditivas, coordenação e API administrativa com JWT admin, auditoria e OpenAPI atualizado.

## Etapa 3 — Metadados, cruzamento e publicação

Após descobrir uma edição, obter seus metadados e guardar valores por fonte, data da observação e URL. Atualizar registros existentes; não apenas marcar que foram vistos.

Vincular automaticamente somente mediante evidência forte, como identificador/link direto e compatibilidade da edição. Nome semelhante sozinho não autoriza vínculo. Conferir data, cidade, UF e ano; manter versões anuais separadas. Encaminhar correspondências ambíguas à seleção visual administrativa.

Reconciliar também edições que já foram cadastradas separadamente, não apenas novas descobertas. A união deve ser transacional, auditada e idempotente; preservar referências, resultados, exportações prontas e histórico das tarefas. IDs antigos precisam continuar apontando para a edição canônica, sem ressuscitar duplicatas em tarefas previamente enfileiradas. Impedir união de anos/data incompatíveis e encaminhar conflitos de correções manuais à revisão. Fingerprint, nome ou URL genérica de organizador não constituem, sozinhos, prova suficiente.

Mostrar comparação entre fontes e a justificativa do valor canônico. Não sobrepor correções manuais nem decisões de ocultação/rejeição. Campos ausentes em uma coleta não podem apagar informações válidas. Conflitos críticos devem exigir revisão.

Corrigir encoding, textos de navegação e classificação somente com evidência. Publicação automática proposta: nome, data, cidade, UF, país BR, modalidade rua/trail e referência válida, sem conflitos críticos. Caso contrário, manter pendente com motivo explícito. Descoberta de catálogo não implica disponibilidade de resultados.

Entrega: normalização, proveniência, vínculos auditados, comparação visual e revisão/publicação pelo painel.

## Etapa 4 — Atualização semanal sem nova mensalidade

Implementar agenda durável no backend e coordenação pelo executor local. Proposta inicial: segunda-feira às 08h, America/Sao_Paulo, configurável e desativada até homologação.

O ciclo semanal redescobre edições recentes/futuras, atualiza seus metadados e identifica alterações. Não confiar exclusivamente na primeira página ou em um cursor antigo. Planejar reconciliações mais amplas para detectar alterações em edições antigas sem refazer toda a carga a cada semana.

A janela de 90 dias é uma proposta operacional, não uma restrição da carga inicial histórica. Só reduzir a descoberta semanal por data se a ordenação ou os filtros reais da fonte permitirem fazê-lo sem perder edições; caso contrário, percorrer sua listagem acessível sob o orçamento e selecionar localmente o que precisa de atualização. A periodicidade da reconciliação histórica deve ser definida após medir volume e custo de requisições.

Resultados recentes OpenResults devem ser uma etapa separada e limitada às edições com associação verificada e fonte acessível. Preservar resultados anteriores em bloqueio/coleta parcial. Não tentar extrair resultados de todas as provas indiscriminadamente.

Se o computador estiver desligado ou suspenso, registrar atraso. Ao reiniciar, retomar o ciclo interrompido e consolidar ocorrências perdidas, sem criar uma execução por semana perdida nem disputar tarefas idênticas. Sem executor disponível, o painel informa espera; o navegador não liga o computador.

Não habilitar runners GitHub, serviço Windows ou pings no Render. Se futuramente for necessária execução garantida com o computador desligado, apresentar uma opção de hospedagem contínua e seu custo antes de contratar.

## Etapa 5 — Controle no painel

Acrescentar configuração do escopo e agenda, carga inicial, atualização imediata, pausa/retomada e histórico. Mostrar próximo horário, atraso, progresso por fonte/UF, executor disponível, falhas e cobertura não comprovada.

Preservar filtros/paginação, visual existente e chave de idempotência por usuário/operação/payload. Reutilizar a chave depois de timeout; usar chave nova para solicitação intencional distinta. Atualizar calendário/detalhes após conclusão real, sem considerar 202 como sucesso da coleta.

Manter cancelamento de pendentes, repetição de falhas, revisão administrativa, associação visual e exportações individuais/consolidadas. Downloads continuam por URL assinada em bucket privado. Novas exportações dependem do executor Python; arquivos prontos e ainda válidos podem ser baixados sem executar nova coleta.

## Etapa 6 — Proteção das fontes e da capacidade

Começar com lotes de até cinco candidatos por fonte em homologação, sem outro consumidor disputando a fila. Ampliar progressivamente somente após conferir contagens, recursos e limites reais.

Implementar orçamento configurável de requisições por fonte, concorrência baixa, cache e espera entre pedidos. Contabilizar chamadas de detalhe, redirecionamentos, retries e navegador, não somente páginas de catálogo. Respeitar Retry-After quando aplicável; bloqueios explícitos pausam a fonte e não geram tentativas insistentes ou bypass.

Medir crescimento do banco, snapshots, resultados e Storage antes da carga nacional. Definir alertas e pausa antes de exceder os limites do plano vigente, sem aumento automático de plano e sem apagar resultados válidos. Separar a capacidade para catálogo da capacidade para resultados de atletas, que pode ser muito maior. Manter logs sanitizados e segredos nos mecanismos protegidos existentes.

Verificar também memória, espaço temporário e disco do computador, especialmente Chromium e montagem de XLSX/ZIP. Confirmar a franquia disponível do projeto/organização antes de configurar limites; estimativas da aplicação não substituem os limites do provedor. Uma pausa por capacidade deve informar o recurso e permitir retomada auditada após resolução, sem liberar pedidos protegidos por outro motivo.

## Etapa 7 — Testes, implantação e aceite

Testes automatizados: paginação/prefixo que não avança, resposta truncada, página vazia válida versus bloqueada, 27 UFs, IDs sem UF, deduplicação, conflitos entre fontes/anos, campos ausentes, correções manuais, idempotência, reinício/lease, agenda/fuso/semanas perdidas e prioridade de tarefas.

Para os checkpoints de resultados, interromper após uma página confirmada e comprovar retomada sem reconsultá-la; rejeitar alteração incompatível de estrutura ou identidade e escrita por lease vencido; verificar publicação atômica e preservação do conjunto anterior. Para a agenda, simular duas ocorrências semanais e um período offline com relógio controlado; depois comprovar pelo menos uma ocorrência real em homologação, distinguindo essa evidência dos testes simulados.

Testes reais: lotes pequenos separados nas três fontes; importar edições ausentes; repetir um lote; atualizar uma existente; conferir fonte, API, banco e navegador; cruzar uma associação verificável; testar resultado acessível e exportação baixada/aberta. Identificar cada teste como automatizado, por API ou no navegador. Uma falha externa permanece pendente mesmo quando os testes locais passam.

Carga inicial nacional: executar de forma progressiva, com orçamento e possibilidade de pausa, reconciliando IDs e razões de exclusão. Declarar conclusão por fonte somente com evidência de término. Registrar mudanças ocorridas durante a própria varredura; uma coleta longa não representa automaticamente um snapshot simultâneo das três fontes.

Entrega em PRs separados de backend e frontend, com CI do último commit. Sequência de homologação: backup e identidade do Supabase; migrations aditivas; atualização explícita de API/workers; publicação explícita do frontend; validação de versões e contrato; testes seletivos; habilitação da agenda somente após aceite. Não confundir merge com publicação. Nenhuma alteração de produção.

## Critérios finais

| Critério | Evidência exigida |
|---|---|
| Cobertura nacional | 27 UFs quando aplicável, passagem de registros sem UF, todas as páginas/partições comprovadas e relatório por fonte |
| Sem truncamento silencioso | Teto, bloqueio, repetição ou término incerto aparecem como limite/falha, não sucesso completo |
| Catálogo cresce e se atualiza | Novas edições reais persistidas e edição existente atualizada, com contagens e origem |
| Cruzamento correto | Associação verificável sem misturar anos; conflito/ambiguidade revisável e valores por fonte |
| Deduplicação e recuperação | Repetição sem novas edições indevidas; reinício retoma checkpoint; lease antigo impedido de gravar |
| Agenda semanal | Ciclo devido criado uma vez, continuidade automática, atraso offline visível e retomada comprovada |
| Controle pelo painel | Após iniciar executores uma vez, operar carga, acompanhamento, revisão e exportação sem comandos por solicitação |
| Exportação | Arquivo real baixado e aberto, com seleção/linhas conferidas e Storage privado |
| Segurança e capacidade | JWT admin no backend, segredos ausentes do frontend/logs, limites de consumo respeitados |

Ordem de implementação: descoberta comprovada → coordenação/checkpoints → atualização e cruzamento → controles no painel → agenda → carga progressiva e aceite. Agendar um coletor parcial antes de resolver descoberta não entrega cobertura nacional.

## Próxima entrega concreta

Revisar e reaproveitar o código em desenvolvimento, incluindo checkpoints nativos e união manual já registrados. Concluir coordenação global do cruzamento, política de publicação e capacidade local antes da agenda. Fechar testes de regressão e CI em PRs separados de backend/frontend, apresentar migrations e sequência de publicação e só então executar a homologação autorizada.

## Backlog priorizado para concluir a implementação

Esta prioridade considera os relatórios e arquivos locais consultados em 02/10/2026. Não constitui nova verificação do estado remoto dos PRs ou dos serviços publicados.

| Prioridade | Trabalho restante | Resultado verificável |
|---|---|---|
| P0 | Revisar a base dos PRs nacionais e inventariar versões, contratos e migrations | Lista única do que pode ser reaproveitado e do que exige integração; fila protegida sem consumo |
| P1 | Completar evidência de país, modalidade e publicação em todos os adaptadores e rotas | País/terreno não inferidos de domínio, UF, endereço de rua ou nome genérico; candidato incompleto preservado para revisão |
| P1 | Concluir o coordenador global de cruzamento | Registros já separados e novos reconciliados por evidência de edição, com conflitos revisáveis, aliases e histórico preservados |
| P1 | Completar capacidade local e prioridades da fila | Memória/disco insuficientes pausam com diagnóstico; operações manuais e exportações avançam durante a carga nacional |
| P2 | Revisar e concluir descoberta, recibos e continuidade nas três fontes | Cada ID observado tem destino explicado: candidato, referência existente, duplicata, fora do escopo ou falha; término incerto fica explícito |
| P2 | Completar os controles e o relatório no painel | Administrador inicia, acompanha, pausa, retoma e revisa pelo painel; contagens de descobertos, publicados e com resultados são distintas |
| P3 | Implementar a agenda semanal durável | Ocorrências idempotentes, fuso, recuperação offline, histórico e próxima execução; desativada por padrão |
| P4 | Integrar e homologar progressivamente | Versões publicadas conferidas; pilotos reais e depois partições acessíveis completas, com evidências por fonte e navegador |

P1 e P2 são pré-requisitos da carga nacional real. A agenda pode ser testada com relógio controlado durante o desenvolvimento, mas sua ativação depende do aceite da integração e do piloto. Implementação e teste controlado do protocolo não substituem a validação da navegação real de cada fonte.

Para não restringir silenciosamente o pedido de catálogo completo, guardar todos os candidatos descobertos e informar seu enquadramento. Rua/trail é o escopo inicial proposto para publicação automática; outras modalidades, modalidade desconhecida e país ainda não confirmado permanecem identificáveis para revisão. O relatório deve informar tanto o universo descoberto quanto o subconjunto publicado, sem apresentar o segundo como cobertura total da fonte.

Na atualização semanal, contabilizar separadamente novas edições e alterações de edições existentes. Ausência numa listagem posterior não deve apagar ou ocultar uma prova automaticamente: primeiro verificar se houve mudança de filtro, paginação, identidade ou disponibilidade da fonte. Atualização dos metadados, coleta de resultados e geração de exportações são operações distintas.

Estimar o esforço de desenvolvimento depois de revisar os PRs atuais; estimar a duração e o armazenamento da carga depois do piloto. Volume, histórico disponível e bloqueios das fontes ainda impedem uma estimativa confiável de tempo total. Se o volume exceder os recursos gratuitos disponíveis, pausar e apresentar alternativas antes de ampliar recursos ou contratar.

## Resumo de execução proposto

1. Revisar o estado atual dos PRs nacionais e separar o que está implementado, integrado e realmente publicado. Não iniciar consumidores nesta revisão nem liberar pedidos protegidos.
2. Concluir descoberta com evidência de término: TicketSports por expansão comprovada e passagem nacional; CorridasBR nas 27 UFs e páginas explícitas; OpenResults nas páginas nativas. Preservar candidatos sem país/modalidade confirmados para revisão. Atingir um teto de segurança não significa terminar a fonte.
3. Concluir cruzamento global e publicação: atualizar observações por fonte, unificar somente a mesma edição comprovada e preservar IDs, resultados e decisões administrativas. Remover presunções de BR e modalidade nos caminhos legados. Correspondências ambíguas ficam visíveis para revisão.
4. Completar execução e controles: prioridades para pedidos manuais/exportações, pausa por memória/disco e banco/Storage, retomada por checkpoint e relatório de cobertura. Depois de iniciar os dois executores uma vez, todas as operações devem ser controláveis pelo painel.
5. Implementar a agenda semanal persistida e desativada por padrão. Proposta: segunda às 08h, America/Sao_Paulo; recentes de 90 dias e futuras, sem supor filtros/ordenação que a fonte não ofereça. Ao voltar de um período offline, consolidar ocorrências perdidas e recuperar trabalho, sem multiplicar ciclos. Revisão histórica periódica será dimensionada pelo piloto.
6. Apresentar a integração concreta em race-platform-staging: commits, backup, migrations aditivas necessárias, deploy explícito da API, atualização dos executores e publicação do frontend. Executar somente após autorização dessa sequência.
7. Homologar com até cinco candidatos processados por fonte, incluindo novas provas, atualização e repetição. O limite de processamento não deve ser confundido com quantity nem com o tamanho da página da fonte. Depois ampliar progressivamente a descoberta, com orçamento e pausa, até o término comprovado de todas as partições acessíveis. Validar calendário, revisão, cruzamento, resultados e exportação real pelo navegador autenticado.

Relatório final por fonte: IDs brutos e únicos, edições novas/atualizadas/unificadas, duplicatas, fora do escopo, pendentes, bloqueios e partições concluídas ou sem término comprovado. Mostrar intervalo de coleta e último sucesso. Percentual só com denominador verificável. Catálogo completo não implica resultados disponíveis para toda edição.

Esta revisão salvou apenas o plano. Não confirmou novamente CI remoto, não modificou código dos repositórios e não iniciou coletas, migrations, deploys ou agendamentos. Estimar esforço de implementação após a revisão dos PRs e duração da carga após medir o piloto; não prometer prazo ou cobertura de páginas inacessíveis.

## Pacotes de trabalho e aceite para a execução

| Ordem | Pacote | Entrega | Verificação que encerra o pacote |
|---|---|---|---|
| 1 | Revisão da base | Estado dos PRs, contratos, fila protegida, versões e inventário de limites | Lacunas enumeradas; implementação existente preservada; nenhum consumidor iniciado inesperadamente |
| 2 | Descoberta e execução | Protocolos das três fontes, recibos, checkpoints, continuidade e orçamento compartilhado | Regressões de truncamento, repetição, bloqueio, reinício e lease; pilotos reais limitados após integração |
| 3 | Cruzamento e qualidade | Reconciliação de registros existentes, proveniência, IDs antigos e revisão visual | Mesma edição unificada sem perda; anos diferentes separados; decisões manuais preservadas |
| 4 | Operação e capacidade | Progresso e cobertura no painel, prioridades, pausa, capacidade de banco/Storage/máquina | Administrador opera pelo painel após iniciar executores uma vez; exportações não ficam monopolizadas pela varredura |
| 5 | Agenda semanal | Configuração persistida, fuso, ocorrência idempotente, recuperação offline e histórico | Relógio controlado cobre recorrência/atraso; sem ciclos duplicados; agenda permanece desativada até aceite |
| 6 | Integração em staging | Backup, migrations aditivas e atualização explícita de API, executores e frontend | Versões publicadas verificadas; contrato e autenticação compatíveis; nenhuma alteração de produção |
| 7 | Carga inicial e aceite | Varredura progressiva, conciliação dos IDs e relatório por fonte/UF/período | Fim comprovado para cada partição; lacunas/bloqueios explícitos; navegador e exportação real validados; uma ocorrência semanal real acompanhada |

As primeiras entregas são código, testes e PRs; publicação, migrations em staging e ampliação da carga são passos distintos de homologação. O prazo e a duração da varredura serão estimados depois de conhecer o volume acessível e medir o piloto. Nenhuma etapa pode prometer recuperar histórico que a própria fonte não oferece ou declarar cobertura integral enquanto existirem partições com término incerto.
