# Homologação sem mensalidade: API suspensível e executores finitos

Decisão do proprietário em 19/09/2026: Supabase Free existente, Render Free somente para Fastify, GitHub Actions em lotes de homologação. Railway/VPS não contratados. Lovable não implementada.

## Compatibilidade e restrição concreta

Os [termos do GitHub Actions](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#actions) destinam o produto ao ciclo de desenvolvimento/testes e alertam contra usá-lo como parte de aplicação serverless. Gratuidade de minutos não equivale a autorização para hospedar um backend operacional permanente. A menor adaptação adotada é usar os workflows **somente para homologação e testes finitos deste repositório**; para atender uso operacional do painel fora desse escopo, executar os mesmos lotes no computador existente, até migrar o executor para AWS/outra hospedagem. Não estamos declarando autorização do GitHub para operação comercial ou permanente.

O repositório `gustavomf-ykn/universal-race-calendar` foi confirmado público via API, com branch padrão `main`. [Runners padrão em repositório público têm computação gratuita](https://docs.github.com/en/actions/concepts/billing-and-usage). Não usar larger runners. Plano financeiro da conta, consumo compartilhado, limites de artifacts/cache e Secrets não são expostos pelo conector disponível; não foram alterados nem presumidos. No GitHub Free, a tabela publicada inclui 500 MB de artifacts e cache de 10 GB/repositório; 2.000 minutos são relevantes para repositórios privados, não o limite de computação deste repositório público. [Cobrança](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

[Render Free](https://render.com/docs/free): somente web service, 512 MB, suspensão depois de 15 min sem tráfego, retomada em aproximadamente um minuto e 750 horas mensais compartilhadas. Não há worker gratuito. Cotas de banda/build e suspensão por tráfego externo excessivo também se aplicam. Não manter a API acordada por ping. Supabase continua responsável por dados, fila, Auth e arquivos; [Free](https://supabase.com/pricing) tem 500 MB de banco, 1 GB de Storage, 5 GB de saída e 5 GB de saída em cache, além de pausa por baixa atividade. Isso não é garantia de disponibilidade nem capacidade ilimitada.

## Modos e limites

| Variável | Padrão | Validação / efeito |
|---|---|---|
| WORKER_MODE | continuous | continuous ou batch |
| WORKER_MAX_TASKS | 3 | Inteiro 1–100; número de aquisições, incluindo tentativas |
| WORKER_MAX_SECONDS | 600 | Inteiro 1–3600; relógio monotônico, inclui limpeza/consulta da fila |
| WORKER_REPORT_PATH | ausente | Caminho opcional de JSON sanitizado |

No modo batch, fila sem tarefa disponível provoca saída imediata. Isso inclui tarefa esperando retry ou lease, mesmo que haja registros queued/running: o runner não fica parado esperando o horário. Só outra execução posterior retomará esse trabalho. A aquisição é por fonte; não prometer FIFO global entre exportação e extração.

Ao alcançar o limite de tarefas, não há nova aquisição. Ao esgotar o tempo, o watchdog encerra o processo. Se houver tarefa ativa, retorna código 75 e `recoveryPending=true`; **não libera lease antes de interromper o processo**, porque parsers/threads/transações não são todos canceláveis. A próxima execução recupera o lease vencido (90 s desde o último heartbeat). Tokens antigos continuam impedidos de gravar. A interrupção consome tentativa; após maxAttempts a tarefa falha. Uma coleta maior que o orçamento repetidamente deve ser diagnosticada e executada em ambiente apropriado, não retomada infinitamente.

Sinais de encerramento param novas aquisições e permitem concluir a tarefa dentro dos limites; SIGKILL/timeout externo seguem a mesma recuperação por lease. Relatório pode faltar se o runner matar o processo antes de gravá-lo; a fonte de verdade é PostgreSQL. Status failed/partial da tarefa é separado do êxito técnico do processo; examinar o resumo e a API, não apenas o check verde.

Python limpa exportações expiradas no início de cada lote, além da cadência contínua existente. A API para de assinar links quando expiram; remoção física espera uma execução do worker. Limpeza não remove resultados.

## Workflows: consumir não é criar

| Workflow | Agenda UTC proposta | Limite do worker | Limite de job, com preparação |
|---|---|---|---|
| Staging calendar batch | 08:23 diariamente | 3 tarefas / 480 s | 15 min |
| Staging results batch | 08:43 diariamente | 3 tarefas / 600 s | 20 min |

Agendas só habilitam o job se a repository variable `STAGING_BATCH_ENABLED=true`. Deixar ausente até configurar os Secrets e validar manualmente. Acionamento manual ignora essa variável. Uma execução concorrente por tipo, `cancel-in-progress=false`; locks/leases protegem entre hosts também. Uma execução pendente pode ser substituída conforme a concorrência do GitHub; as tarefas duráveis continuam no banco.

Permissão do token: contents:read. Checkout sem credenciais persistidas. Sem pull_request_target, dispatch pelo navegador, HTTP prolongado ao Render, enqueue automático, migrations ou download de atletas em artifacts. Só dependências pnpm/pip em cache; Chromium é instalado e smoke-tested em cada job Python (não guardar perfil do navegador nem dados de coleta em cache). Relatório sanitizado em artifact por 3 dias e summary mesmo quando falha. Cancelamento forçado de todo o runner ainda pode impedir os passos finais.

O antigo `catalog-import.yml` perdeu o cron **somente nesta proposta de branch**, ficando manual. `production-import.yml` e `ticketsports-import.yml` continuam manuais/históricos com seus secrets próprios e não devem ser usados para staging. Não mudamos workflows implantados em main nem secrets de produção. Antes de habilitar a nova agenda após integração autorizada, conferir que não há outro agendador de enqueue ativo.

Os [agendamentos GitHub](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) usam a branch padrão, podem atrasar ou perder execuções em alta carga e podem ser desabilitados após 60 dias sem atividade no repositório público. O horário não é SLA. `workflow_dispatch` também exige o arquivo na branch padrão para disponibilidade inicial. O PR está aberto; não fizemos merge. Não contornar essa limitação com secrets em workflows de PR.

### Secrets e configuração externa

Criar o Environment GitHub `race-platform-staging` e cadastrar em Settings → Environments → esse environment → Secrets:

| Secret | Consumidor | Valor necessário |
|---|---|---|
| STAGING_DATABASE_URL | TS | URI Prisma do projeto isolado, SSL, Session Pooler 5432; preferir connection_limit=3 |
| STAGING_DIRECT_URL | TS | URI SSL do mesmo projeto, porta 5432 |
| STAGING_WORKER_DATABASE_URL | Python | URI libpq SSL, sem schema/connection_limit de Prisma |
| STAGING_SUPABASE_SECRET_KEY | Python | Chave sb_secret_ para Storage |

URL Supabase/ref estão fixados publicamente nos workflows, com preflight que rejeita outro projeto, porta ou falta de SSL. Os executores não recebem INTERNAL_API_KEY nem token administrativo do GitHub. Cadastrar secrets pelos gerenciadores dos serviços; não pelo chat, YAML ou argumentos de shell. O DPAPI local não é portátil e não deve ser enviado ao GitHub.

Para executar: GitHub → Actions → Staging calendar batch ou Staging results batch → Run workflow → selecionar a versão revisada disponível. Conferir resumo, tarefas da API e artifact `batch-summary.json`. O workflow nunca cria a coleta: primeiro solicitar pela API autorizada, usando Idempotency-Key, ou usar as tarefas pequenas já criadas na homologação.

### Proteção de gastos

Antes de habilitar: Settings da conta → Billing and licensing → Budgets and alerts; conferir orçamento de Actions/artifacts e bloqueio de uso pago (`Stop usage when budget limit is reached`) conforme os controles disponíveis. Manter orçamento de uso pago zero/bloqueado quando suportado, sem adicionar forma de pagamento ou habilitar cobrança nesta tarefa. Não aumentar cache acima dos 10 GB incluídos, não usar runners maiores. Verificar consumo de outros repositórios/CI e retenção de artifacts. [Orçamentos oficiais](https://docs.github.com/en/billing/how-tos/set-up-budgets). No Render conferir limites de banda/pipeline e bloquear excedentes conforme o painel; sem forma de pagamento, a documentação prevê suspensão em vez de continuidade cobrada.

Não foi possível confirmar os controles financeiros atuais da conta pelo conector, portanto **custo zero depende dessas configurações e cotas**. Sem acesso, esta é uma ação manual indispensável.

## Render Free: passos mínimos

1. Criar apenas o web service `race-platform-staging-api`, selecionando **Free**, Docker, repositório/branch revisados; usar `render.yaml` como configuração. Não selecionar opções pagas, disco, banco ou workers. Nenhum serviço Render está acessível nesta sessão para implantar.
2. Cadastrar DATABASE_URL, DIRECT_URL, SUPABASE_SECRET_KEY, INTERNAL_API_KEY e CORS_ORIGINS em Environment. Copiar valores do gerenciador seguro já usado. URL Supabase é pública e já está no blueprint. CORS deve ser origem exata de teste/futuro painel, sem `*`.
3. Build: Dockerfile.backend na raiz. Start: `node scripts/start-staging-api.mjs`; somente Fastify, sem migrations/workers. O wrapper valida staging/SSL e limita o pool Prisma a 3 conexões. O servidor respeita PORT do Render e escuta 0.0.0.0. Health: `/health`, que indica processo, não disponibilidade de fila.
4. Manter auto deploy desligado e fazer primeiro deploy manual. Usar a URL HTTPS fornecida pelo Render; validar health/version, login, 202, consultas/Storage e cold start. Não configurar pings contra suspensão. Arquivos locais são efêmeros e não são autoridade de dados.
5. Nenhuma migration adicional foi necessária para o modo batch. Migrations futuras continuam manuais pelo procedimento de staging.

## Medição e projeção

Execuções locais nativas contra Supabase em 19/09: lote vazio TS <1 s; vazio Python 1–2 s com limpeza; check TicketSports cerca de 1 s; coleta OpenResults de 435 resultados cerca de 9 s; exportação 2–3 s. Esses tempos começam **depois da importação do processo** e não incluem provisionamento do runner, checkout, instalação, build ou Chromium. Não são uma previsão de custo do Actions.

Os workflows novos ainda não foram executados no GitHub com Supabase: faltam acesso a Secrets e disponibilização inicial na branch padrão. Preparação fria/quente e duração total real permanecem **pendentes de medição**. Os testes/CI anteriores não substituem essa medição. Summary registra tempo desde o primeiro passo e tempo do worker; usar os timestamps do job/steps do Actions para incluir toda a preparação e upload.

Projeção máxima configurada para 31 dias: `31 × (15 + 20) = 1.085 minutos de jobs`, mais acionamentos manuais, CI, builds e outras homologações. É teto configurado, não consumo medido nem cobrança prevista. Quando houver medições: `dias × (média do job TS + média do job Python) + minutos de CI + manuais`, separando runs frias e com cache. Para orçamento privado hipotético de 2.000 min, não tratar 1.085 como suficiente sem somar todos os repositórios; para este público, computação padrão é gratuita sujeita aos termos. Artefatos continuam mínimos e com retenção curta.

## Validação e portabilidade

Build/tipos/lint e regressões locais passaram. Testes completos: 71 TypeScript e 54 Python. Ensaio real batch de Supabase valida fila vazia, limite de tarefas, ambos os workers, coleta real, exportação após saída do processo e watchdog; evidência final em STAGING.md. Runner GitHub + Supabase e API hospedada Render permanecem pendentes, sem declaração de fluxo remoto concluído.

Para voltar ao modo contínuo: remover WORKER_MODE ou definir continuous e usar os comandos/Dockerfiles originais. Para lote local usar WORKER_MODE=batch com limites, executando o wrapper `-Action calendar` ou `results`; não fica esperando fila vazia. AWS futura pode executar essas imagens em serviço contínuo ou job de contêiner finito, preservando conexão SSL, secrets e leases; nenhuma conta ou recurso AWS é necessário nesta etapa.
