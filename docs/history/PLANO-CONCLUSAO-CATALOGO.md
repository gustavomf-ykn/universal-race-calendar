> Registro histórico arquivado em 19/10/2026. Descreve evidências e decisões da época, não o estado atual nem uma autorização para executar comandos. Para retomar, leia [CONTINUITY.md](../../CONTINUITY.md) e [AWS-HOSTING.md](../AWS-HOSTING.md). Credenciais, backups, logs privados e capturas não acompanham este arquivo.

# Plano para concluir o catálogo nacional e a atualização semanal

Data: 02/10/2026. Escopo: planejamento para homologação no projeto `race-platform-staging`. Este documento não executa coletas, integra PRs, aplica migrations, publica versões ou ativa agendamentos.

## Base na elaboração do plano, antes da implementação

Leitura local das branches nacionais, documentação e relatórios de progresso. Backend no commit `d5de25b`, com alterações locais de proveniência de data/localização ainda em andamento; frontend no commit `cfebcec`, sem alterações locais. Essas alterações do backend devem ser preservadas, revisadas e testadas antes de integrar. O CI e os serviços publicados não foram consultados novamente nesta rodada de planejamento; os relatórios anteriores não substituem a verificação na etapa 1.

Na continuação de implementação, essas alterações foram concluídas/revisadas e enviadas em `46d51b2` ao PR #12. O histórico de testes, CI e as lacunas restantes estão em `NATIONAL-CATALOG-PROGRESS-2026-10-01.md`; este plano não constitui homologação ou autorização de integração.

Já há implementação parcial de descoberta ampliada, recibos, checkpoints, orçamento de requisições, capacidade de banco/Storage, revisão administrativa e união de edições. O trabalho é completar lacunas e comprovar integração, sem reimplementar esses mecanismos. A agenda semanal, a coordenação global do cruzamento, os limites locais de memória/disco e o aceite de cobertura real permanecem entregas a verificar/concluir.

## Resultado esperado

Importar e manter atualizadas as edições brasileiras publicamente acessíveis em TicketSports, CorridasBR e OpenResults, cruzando referências da mesma edição e permitindo operar o processo pelo painel após iniciar os executores locais uma vez.

Cobertura completa precisa ser demonstrada por fonte e período: partições/páginas percorridas, identificadores únicos reconciliados e evidência de término. Limite de segurança, resposta 202 e fila vazia não provam cobertura. Conteúdo bloqueado ou sem término verificável permanece explicitamente pendente. Catálogo completo das fontes não significa todas as corridas existentes no Brasil nem resultados disponíveis para todas elas.

Não restringir silenciosamente a descoberta a rua/trail. Manter candidatos de outras modalidades e com país/modalidade desconhecidos identificáveis para revisão. Descobertos, brasileiros confirmados, publicados e com resultados são contagens distintas.

## 1. Revisar e estabilizar a base

- Conferir os PRs e commits atuais dos dois repositórios, CI, migrations pendentes, contrato/OpenAPI e versões efetivamente publicadas. Há implementação nas branches nacionais que deve ser revisada e aproveitada; código local não equivale a funcionalidade homologada.
- Inventariar fila, executores, tarefas retidas e configurações sem iniciar consumidores. Preservar tarefas existentes e dados válidos.
- Medir banco, Storage e recursos do computador; definir orçamento de requisições e margem de capacidade antes de ampliar a carga.
- Listar as lacunas restantes e separar mudanças da API, workers e frontend.

Aceite: base reproduzível, versões conhecidas, fila protegida e sequência de integração documentada.

## 2. Concluir a descoberta verificável das três fontes

| Fonte | Trabalho | Evidência de conclusão |
|---|---|---|
| TicketSports | Validar a expansão da listagem e os filtros realmente disponíveis; percorrer partições aplicáveis e passagem nacional, incluindo registros sem UF; detectar quantidade ignorada e truncamento | Identificadores únicos reconciliados; término comprovado pela fonte. Atingir teto configurado produz cobertura limitada |
| CorridasBR | Percorrer as 27 UFs e todas as páginas/períodos efetivamente acessíveis; distinguir calendário vazio de mudança estrutural ou bloqueio | Recibo por UF/página, sem partições esquecidas, ciclos ou término silencioso |
| OpenResults | Percorrer páginas nativas, reconciliar totais quando disponíveis e detectar repetição; confirmar Brasil e edição sem presumir país pelo domínio | Recibos de páginas/IDs, término comprovado e candidatos desconhecidos encaminhados à revisão |

Fazer primeiro pilotos separados de até cinco candidatos processados por fonte. `quantity`, tamanho da página e número de registros novos não são equivalentes. Só ampliar progressivamente após conferir persistência, deduplicação e orçamento. Não adivinhar parâmetros de paginação nem contornar bloqueios.

Aceite: importar provas antes ausentes e explicar o destino de cada ID observado: existente, novo, duplicado, fora do escopo, pendente ou falha.

## 3. Completar execução durável e cobertura

- Persistir ciclo, escopo, versão do parser, partição, cursor, recibos e contagens; confirmar candidato e checkpoint na mesma transação protegida pelo lease.
- Continuar automaticamente as etapas elegíveis, com pausa/retomada e cancelamento que preservem histórico e dados. Retomada compatível não repete etapas confirmadas; nova execução intencional tem identidade própria.
- Reservar prioridade para pedidos manuais e exportações. Limitar concorrência e pausar com diagnóstico antes de esgotar banco, Storage, memória ou disco.
- Em bloqueio, interromper a fonte e mostrar motivo/condição de retomada. Não repetir indefinidamente.
- Exibir cobertura por fonte/UF/período: IDs únicos, novos, atualizados, duplicatas, unificados, pendentes, falhas e último sucesso. Usar percentual somente quando o denominador for verificável; partições sobrepostas não são somadas como edições distintas.

Aceite: reinício retoma o trabalho; executor com lease vencido não grava; carga extensa não impede exportações; conclusão parcial não aparece como sucesso completo.

## 4. Concluir cruzamento, atualização e qualidade

- Guardar valores observados, fonte, URL e data da observação. Atualizar edições existentes, preservando campos válidos quando a nova observação for incompleta.
- Validar a proveniência de nome, data, cidade, UF, país e modalidade; corrigir encoding e textos de navegação com evidência. Não aceitar suposições do modelo como observação da fonte.
- Associar automaticamente somente com evidência forte de identidade e compatibilidade de edição/data/localização. Nome parecido sozinho não basta. Anos e edições diferentes permanecem separados.
- Reconciliar registros já separados, aproveitando a união manual/aliases existentes: preservar referências, resultados, exportações, IDs antigos e auditoria.
- Mostrar conflitos e candidatos à associação por seleção visual. Preservar correções manuais e decisões de ocultação/rejeição; publicar automaticamente somente quando os requisitos de evidência estiverem satisfeitos.

Aceite: uma correspondência real entre fontes, atualização de uma edição existente e conflitos controlados comprovam associação correta e preservação dos dados anteriores.

## 5. Concluir a operação pelo painel

- Disponibilizar carga inicial, atualização imediata, escopo, progresso por fonte, executor disponível, pausa, retomada, cancelamento de pendentes e repetição de falhas.
- Separar nova tentativa de retomada por checkpoint. Persistir idempotência por usuário, operação e payload; reutilizar a chave após perda de resposta e gerar outra para novo pedido intencional.
- Administrar candidatos incompletos, não publicados e conflitos, com revisão, publicação, ocultação, rejeição e auditoria pelo backend com JWT admin.
- Mostrar espera pelo worker, execução, conclusão, parcialidade e falha real. Atualizar calendário/detalhes ao concluir e tratar API lenta sem criar pedidos duplicados.
- Validar exportação individual/consolidada XLSX/ZIP, acompanhamento, link assinado novo quando necessário e download. Diferenciar expiração do arquivo de expiração do link.

Aceite: no navegador autenticado, após iniciar os executores uma vez, o usuário importa, acompanha, revisa e exporta sem comandos por solicitação. Nenhuma chave interna ou credencial de banco entra no frontend.

## 6. Implementar a atualização semanal

- Persistir agenda, fuso, próxima ocorrência, histórico e estado habilitado/desabilitado. Proposta inicial: segunda-feira, 08h, `America/Sao_Paulo`, configurável e desabilitada por padrão.
- Usar o executor local como coordenador da agenda persistida. Cada ocorrência cria no máximo um ciclo, sem duplicar ciclo equivalente ainda ativo.
- Priorizar edições novas/futuras e alterações recentes. Janela inicial proposta: últimos 90 dias e futuras; só limitar descoberta por data se filtros/ordenação reais garantirem que isso não perde edições.
- Dimensionar reconciliação histórica periódica após medir o piloto, para detectar alterações antigas sem refazer toda a carga toda semana.
- Manter coleta de resultados como etapa separada, limitada a associações verificadas e fontes acessíveis. Ausência numa listagem posterior não apaga automaticamente uma prova.
- Quando o computador estiver desligado, registrar atraso; ao voltar, retomar o ciclo e consolidar ocorrências perdidas, sem criar um lote por semana perdida. O painel deve informar essa dependência.

Aceite: testes com relógio controlado comprovam fuso, concorrência, ocorrência duplicada e recuperação offline; depois, uma ocorrência semanal real comprova operação em homologação. Sem computador/executor ligado, não há garantia de execução no horário.

## 7. Integrar e homologar progressivamente

1. Entregar PRs separados, regressões e CI do último commit, com relação das migrations aditivas e incompatibilidades.
2. Apresentar a sequência para autorização: backup e identidade de staging; migrations necessárias; atualização explícita da API e dos dois workers; publicação do frontend. Merge não comprova deploy/publicação.
3. Conferir versões, fila e tarefas que serão consumidas antes de iniciar executores. Testar primeiro pilotos seletivos, repetição, atualização, cruzamento, interrupção e exportação real aberta.
4. Ampliar a carga inicial por partições, sob orçamento e capacidade, até reconciliar todas as partições acessíveis. Registrar intervalo da varredura: as fontes podem mudar durante a carga.
5. Validar o fluxo no navegador e só então habilitar a agenda semanal após autorização específica.

Não usar produção, coletas em massa de uma só vez, runners GitHub para coletar, pings para impedir suspensão, recursos pagos ou credenciais no frontend/logs.

## Ordem das entregas de desenvolvimento

| Entrega | Depende de | Concluída quando |
|---|---|---|
| A. Inventário e backlog fechado | Revisão das branches/CI e fila, sem consumo | Cada lacuna tem arquivos afetados, teste e impacto de implantação identificados |
| B. Descoberta e evidência por fonte | A | TicketSports, CorridasBR e OpenResults distinguem término, truncamento, bloqueio e mudança estrutural; normalização tem regressões de identidade |
| C. Continuação, cruzamento e recursos | B | Checkpoints e coordenação duráveis, associação conservadora, prioridade manual/exportação e pausas por capacidade testados |
| D. Operação administrativa no painel | Contratos estáveis de B/C | Usuário acompanha, revisa, associa, pausa/retoma e exporta com JWT admin, idempotência e histórico |
| E. Agenda semanal | C e controles de D | Fuso, ocorrência única, recuperação offline e habilitação explícita testados; agenda permanece desligada |
| F. Integração em homologação | CI das entregas anteriores e autorização específica | Migrations aditivas necessárias, API, executores e frontend compatíveis e versões realmente publicadas conferidas |
| G. Pilotos, carga inicial e semana real | F | Testes reais seletivos, expansão gradual, recibos reconciliados e aceite autenticado registrados; limitações não escondidas |

B pode ser desenvolvida por fonte separadamente; D pode avançar com contratos controlados enquanto C é concluída. O aceite real de D só ocorre depois de F. Se um piloto revelar mudança da fonte, corrigir o adaptador e repetir apenas a validação afetada antes de ampliar. Não antecipar uma varredura nacional durante a revisão.

Estimativas serão separadas em esforço de desenvolvimento, tempo de carga inicial e tempo de observação da agenda. Não fixar prazo ou prometer cobertura integral antes de medir acesso, volume, recursos e partições das fontes. A comprovação semanal inclui uma ocorrência real após habilitação autorizada; testes com relógio controlado não a substituem.

## Matriz de aceite final

| Cenário | Comprovação exigida |
|---|---|
| Cobertura | Três fontes e 27 UFs quando aplicável; páginas/partições reconciliadas; limitações explícitas |
| Catálogo cresce | Novas provas reais na API e painel, com origem e contagens |
| Catálogo se atualiza | Edição existente alterada com proveniência e proteção de correções manuais |
| Cruzamento | Mesma edição unificada por evidência; anos/localizações conflitantes não unidos |
| Idempotência | Replay e perda de resposta sem tarefa/registro duplicado |
| Recuperação | Reinício retoma checkpoint; lease vencido impedido de sobrescrever |
| Dados preservados | Falha/bloqueio/parcialidade não elimina resultados anteriores |
| Operação pelo painel | Carga, revisão, acompanhamento e download sem intervenção no terminal por pedido |
| Agenda semanal | Execução única, atraso visível, recuperação offline e ocorrência real registrada |
| Exportação | Arquivo baixado e aberto, linhas/cabeçalhos conferidos e Storage privado |

Prazo de desenvolvimento será estimado após revisar as lacunas das branches atuais. Tempo e espaço da carga nacional serão estimados após medir o piloto e o volume acessível. A primeira entrega é essa revisão com backlog fechado; a última é o relatório de cobertura e o aceite semanal real, distinguindo testes automatizados, testes por API e testes no navegador.
