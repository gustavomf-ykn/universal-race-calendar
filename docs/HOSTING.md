# Hospedagem do backend — histórico da comparação

Decisão atual: sem contratação de Railway/VPS. A arquitetura gratuita de homologação, limites e restrição de uso do Actions estão em [BATCH-HOSTING.md](BATCH-HOSTING.md). A recomendação paga abaixo é histórica e foi substituída pela decisão do proprietário.

Pesquisa oficial em 19/09/2026. Nenhum serviço contratado, provisionado ou implantado. Supabase `race-platform-staging` permanece como banco/Auth/Storage. Preços em moeda original, antes de tributos, câmbio/cartão e eventual domínio; não incluem serviços de produção.

## O que o código exige

API Fastify Node 22 e worker TS usam `Dockerfile.backend`, com comandos separados. Python 3.12 usa Debian Bookworm, Playwright 1.62.0 e Chromium instalado com dependências no build. Os dois workers consultam a fila continuamente, aproximadamente a cada segundo quando ociosos; cron e plataformas que só executam durante uma requisição HTTP não substituem esse comportamento. A API sozinha aceita 202, mas a tarefa fica aguardando se não houver executor.

Não precisamos contratar PostgreSQL, Redis, disco para resultados ou serviço de navegador: fila/dados estão no Supabase e o navegador está na imagem Python. As exportações são geradas em memória, enviadas ao Storage e baixadas diretamente dele. Isso reduz tráfego da API, mas conta nas cotas do Supabase. Python precisa de memória para pandas/openpyxl, resultados e navegador, mesmo com concorrência 1.

O `render.yaml` antigo descreve apenas a API gratuita, sem workers nem configuração completa de Auth/Storage. Não é um deploy do backend completo. `compose.staging.yaml` é útil para ensaio local, mas não oferece HTTPS, limites de memória nem divisão dos secrets por processo. A alternativa de VPS preparada cobre esses pontos sem alterar os arquivos antigos.

## Comparação financeira e operacional

| Opção | Custo mensal dos executores | Memória inicial | Suspensão / continuidade | Manutenção |
|---|---|---|---|---|
| Computador existente + Supabase | US$ 0 incremental de nuvem, além de energia/internet | Preferir 4 GB livres para os processos | Só funciona com computador e workers ligados | Operação manual, adequada a testes |
| Render Free API + workers no computador | US$ 0 dentro das cotas | API 512 MB; Python local com margem de 2 GB | API dorme após 15 min; workers dependem do computador | Boa demonstração temporária; não é backend gratuito 24/7 |
| Railway Free | US$ 1/mês de recursos incluídos depois do trial | 512 MB por serviço após trial | Franquia pequena; ALWAYS indisponível no Free | Não recomendado para o conjunto com Chromium |
| Railway Hobby, três serviços Docker | Mínimo US$ 5; exemplo leve US$ 12,25/mês, reserva inicial US$ 15–20 | Limites propostos: API 512 MB, TS 768 MB, Python 2 GB | Sempre ativos com Serverless desligado; limite financeiro atingido interrompe serviços | Mais simples: build, TLS, logs e reinício gerenciados |
| Render pago, três serviços Docker | US$ 39 = 7 + 7 + 25; US$ 57 se TS precisar de 2 GB | API/TS 512 MB cada, Python 2 GB | Workers contínuos, sem suspensão de Free | Simples e previsível, mas custo maior |
| Hetzner CX23 Europa, VPS única | € 5,99 = 5,49 + IPv4 0,50; € 7,09 com backup opcional | 2 vCPU, 4 GB, 40 GB disco | Sem suspensão por inatividade; cobra enquanto existir | Menor preço de tabela; administrar Linux/Docker/TLS. Página mostra indisponibilidade |
| Hetzner CX33 Europa, VPS única | € 8,99 com IPv4; € 10,69 com backup opcional | 4 vCPU, 8 GB, 80 GB disco | Mesmo modelo | Mais margem; também aparece indisponível |
| DigitalOcean Basic Regular, VPS única | US$ 24, sem backup opcional | 2 vCPU, 4 GiB, 80 GiB disco | Contínua, sem mecanismo de sleep de PaaS | Mesmo trabalho operacional da VPS, menor vantagem financeira |

Render: [preços](https://render.com/pricing), [Free](https://render.com/docs/free), [workers](https://render.com/docs/background-workers), [Docker](https://render.com/docs/docker). Free tem 750 horas/mês por workspace e cold start próximo de um minuto; não oferece background worker gratuito. Hobby do workspace custa zero, mas cada compute pago é cobrado separadamente. A franquia atual de saída é 5 GB; excedente US$ 0,15/GB. [Franquias atuais](https://render.com/docs/new-workspace-plans). O plano 512 MB do TS é tentativa econômica, não capacidade comprovada para importações maiores; subir a 2 GB acrescenta US$ 18. Não recomendo colocar Chromium em 512 MB.

Railway: [preços de recursos](https://docs.railway.com/pricing), [planos/limites](https://railway.com/pricing), [reinícios](https://docs.railway.com/deployments/restart-policy). Cálculo: `max(5, 10 × GB RAM médios + 20 × vCPU médios + 0,05 × GB saída)`. Exemplo apenas estimado: RAM média total 1 GB, CPU média total 0,10 vCPU e saída 5 GB = US$ 12,25. Não é medição destes contêineres nem preço máximo. Se mantiver 3 GB médios, a memória sozinha custa US$ 30. O teto de memória limita picos; não equivale à memória média faturada. Trial: US$ 5 por até 30 dias; não tratar como gratuidade permanente. Dockerfiles são suportados [oficialmente](https://docs.railway.com/builds/dockerfiles).

Railway Serverless detecta inatividade de rede em cerca de 5–10 min; consultas constantes ao PostgreSQL impedem dormir. Manter **desligado nos três processos**, especialmente workers: uma tarefa nova no banco não é uma requisição HTTP que acorde um worker dormindo. [Serverless](https://docs.railway.com/deployments/serverless). Configurar alerta de gastos e teto aprovado pelo usuário; atingir o teto tira os serviços do ar. [Controle de custos](https://docs.railway.com/pricing/cost-control). Pro US$ 20 é alternativa de plano para uso comercial/equipe; verificar enquadramento antes de sair do piloto pessoal.

Hetzner: usar a [tabela após reajuste de junho de 2026](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/), não ofertas antigas de € 2,99. [Recursos e disponibilidade CX](https://www.hetzner.com/cloud/cost-optimized/), [IPv4](https://docs.hetzner.com/cloud/servers/primary-ips/overview/), [backup 20%](https://docs.hetzner.com/cloud/billing/faq/). Os preços acima excluem impostos. Europa inclui 20 TB de tráfego; confirmar disponibilidade antes da escolha. Não reservar CPX mais caro automaticamente. O backup da VPS não faz backup do Supabase. [DigitalOcean Basic](https://www.digitalocean.com/pricing/droplets) inclui 4.000 GiB de transferência nessa configuração; suporte do provedor não substitui manutenção do sistema operacional.

## Recomendação inicial

Para este piloto pessoal, recomendo **Railway Hobby com três serviços**, um processo por serviço, uma réplica cada, região próxima ao Supabase e concorrência 1. Reserva proposta US$ 15–20/mês, sujeita às métricas. É a combinação mais prática de baixo custo inicial e pouca manutenção entre as opções gerenciadas analisadas. Medir RAM/CPU ociosas e durante Chromium/XLSX antes de estimar mês cheio. Caso o gasto sustentado supere a faixa, reavaliar VPS.

Se a prioridade absoluta for menor mensalidade e houver disposição para manter Linux, uma **CX23 com 4 GB** é a opção econômica condicionada a estoque; CX33 oferece margem por € 3 adicionais. Neste momento não prometo disponibilidade. DigitalOcean é alternativa portátil de VPS, porém US$ 24 não justifica escolhê-la apenas para economizar sobre o cenário leve estimado do Railway.

Para gastar zero agora: manter os três processos locais ou API gratuita Render com ambos os workers locais. Não usar pings artificiais nem disfarçar workers de web services para contornar a suspensão. Essa opção é para sessões de teste e demonstração, não operação contínua.

Se escolher a demonstração Render Free: criar somente um web service Docker apontando para `Dockerfile.backend`, raiz do repositório, health `/health`, variáveis de `deploy/env/api.env.example` e deploy automático desligado. Executar os workers localmente pelo wrapper de STAGING.md durante a sessão. A conexão com a fila é feita diretamente pelo Supabase; não é necessário expor os workers ou abrir portas no computador. Nenhum desses passos foi executado.

Se o Supabase estiver no Free, seu custo incremental permanece zero dentro das cotas: 500 MB de banco, 1 GB de arquivos, 5 GB de saída e 5 GB de saída em cache; projetos podem pausar por baixa atividade. Pro começa em US$ 25/mês. Não alterei nem confirmei o plano da organização por acesso administrativo. Uma VPS paga não elimina os limites do banco gratuito. [Preços Supabase](https://supabase.com/pricing), [pausa](https://supabase.com/docs/guides/platform/free-project-pausing). Um total futuro com Supabase Pro seria, por exemplo, US$ 37,25 no cenário Railway de US$ 12,25, antes de adicionais. Não é proposta de upgrade nesta etapa.

## Arquivos preparados, sem execução

Railway: `deploy/railway/api.json`, `calendar-worker.json`, `results-worker.json`. Cada arquivo escolhe o Dockerfile/comando, uma réplica e reinício ALWAYS; somente API tem health HTTP. VPS: `deploy/vps/compose.yaml` e `Caddyfile`, três processos mais um proxy pequeno para HTTPS. Exemplos sem valores secretos em `deploy/env/`. A imagem Node agora inclui o preflight já existente para operação manual. Não há migration automática no startup, cron novo ou workflow de deploy.

### Railway — depois da escolha explícita

1. Criar um projeto exclusivo de staging e três serviços vazios. Antes de conectar o repositório, preencher variáveis e configurar os limites; desabilitar deploys automáticos e PR previews nas configurações do provedor. Esses controles não são definidos pelos JSONs.
2. Em todos: raiz do repositório `/`; selecionar a branch/commit revisado. Em Config File, escolher o JSON correspondente em `deploy/railway/`. A pasta raiz precisa conter packages e ambos os workspaces Node; não usar `apps/api` como root.
3. Em Variables, cadastrar os valores de cada exemplo de `deploy/env`, copiando de um gerenciador de secrets. API recebe `api.env.example`; TS `calendar.env.example`; Python `results.env.example`. Definir GIT_SHA do commit em cada serviço. Não copiar o arquivo Windows DPAPI para Linux. SUPABASE_SECRET_KEY só na API e Python; INTERNAL_API_KEY só na API. Chave publishable só no futuro cliente e testes Auth.
4. Em cada serviço, desligar Serverless. Configurar RAM máxima de 512 MB / 768 MB / 2 GB e CPU máxima de 0,5 / 0,5 / 1 vCPU se esses valores forem aceitos pela interface; não assumir limites aplicados pelos JSONs. Não adicionar volumes/banco/Redis. Não gerar domínio público para workers. Aprovar teto de gasto antes de iniciar.
5. Validar as conexões com preflight local já existente; somente ref `sggrijhyblejlgimgzzc`, SSL e Session Pooler porta 5432. Migrations atuais já aplicadas; futuras migrations via operação separada controlada, nunca em paralelo nos três serviços. Não habilitar preDeployCommand que altere banco automaticamente.
6. Implantar manualmente somente após escolha. Gerar domínio HTTPS gratuito da API; configurar CORS com a origem exata do futuro painel. Medir latência até Supabase (a região desse banco não foi inferida pelo hostname). Repetir health/version, banco, coleta pequena, Storage e recuperação nesse host.
7. No shell do worker Python executar `python browser_smoke.py`. Suporte a Docker não comprova memória/sandbox suficiente nesse provedor; se falhar, parar e diagnosticar antes de coletar. Não pedir modo privilegiado. Validar também encerramento e retomada do lease ao atualizar.

### VPS — depois da escolha explícita

Host dedicado a staging, Linux x86_64, Docker Engine + Compose v2, idealmente Debian 12/Ubuntu LTS. Instalação e acesso SSH só após autorização. Uma VPS compartilha o domínio de falha entre os processos: se cair, todos param; dados continuam no Supabase e a fila permite retomar. Atualizações do SO/Docker, disco, firewall, certificados e monitoramento ficam sob nossa responsabilidade operacional, não do PaaS.

Os limites iniciais de RAM são API 512 MiB, TS 768 MiB, Python 2 GiB, Caddy 128 MiB; sobra cerca de 640 MiB em 4 GiB para SO/Docker. Isso é orçamento proposto, não benchmark de pico. Build pode precisar de mais memória que runtime: construir sequencialmente com processos parados; se necessário usar máquina de build existente e transferir imagens, sem contratar build server. Não usar swap como substituto da RAM do Chromium. Workers sem portas públicas; apenas proxy 80/443 e SSH restrito ao operador. Sem PostgreSQL local.

Instalar os arquivos privados `api.env`, `calendar.env`, `results.env`, `operations.env` e `proxy.env` em `/etc/race-platform-staging`, diretório 0700 e arquivos 0600. Só root/operador Docker deve ler. Usar os exemplos do repositório como lista de campos; preencher fora do repositório. Não executar `docker compose config` sem `--quiet`, nem exibir `docker inspect`, `env` ou os arquivos privados. As conexões Prisma podem usar `connection_limit=3`; não adicionar esse parâmetro nem `schema` à URI Python. CORS com origem exata, sem `*`.

Comandos abaixo são procedimento preparado, **não foram executados**. Dentro do checkout revisado, definir DEPLOY_TAG com o SHA completo selecionado; STAGING_CONFIG_DIR é caminho público, não segredo. Depois de fornecer os envs privados:

```sh
export DEPLOY_TAG="$(git rev-parse HEAD)"
export STAGING_CONFIG_DIR=/etc/race-platform-staging
docker compose -f deploy/vps/compose.yaml config --quiet
docker compose -f deploy/vps/compose.yaml build api
docker compose -f deploy/vps/compose.yaml build results-worker
docker compose -f deploy/vps/compose.yaml run --rm operations
# Apenas se houver migrations novas revisadas, em janela controlada:
# docker compose -f deploy/vps/compose.yaml run --rm operations node scripts/staging-preflight.mjs migrate sggrijhyblejlgimgzzc
docker compose -f deploy/vps/compose.yaml run --rm results-worker python browser_smoke.py
docker compose -f deploy/vps/compose.yaml up -d api calendar-worker results-worker proxy
docker compose -f deploy/vps/compose.yaml ps
docker stats --no-stream
```

O serviço operations roda somente quando chamado e não permanece em execução. Para HTTPS, usar um subdomínio já possuído em `proxy.env`; apontar DNS após escolha, nunca inventar domínio. Caddy obtém/renova o certificado automaticamente com DNS e portas corretos; volume de certificados persiste. [HTTPS Caddy](https://caddyserver.com/docs/automatic-https). Sem domínio próprio, Railway/Render evitam esse custo e essa etapa.

Chromium recebe init e 512 MiB de memória compartilhada no Compose. A imagem roda como usuário não root e mantém a versão Playwright usada no CI. O [guia Playwright Docker](https://playwright.dev/python/docs/docker) ressalta memória compartilhada e sandbox. O ajuste não prova o fallback real: repetir browser_smoke e a coleta no host escolhido. Não foi feito benchmark de produção ou sandbox no Railway/Render nesta preparação.

Os logs têm rotação na VPS; health da API indica processo, não fila. Monitorar tarefas failed/partial, idade da fila, reinícios e consumo de memória; não imprimir nomes de atletas/tokens. Docker não reinicia só porque um healthcheck marcou unhealthy: restart cobre saída do processo. Em atualização, parar workers, trocar as imagens revisadas e iniciar novamente; aceitar recuperação por lease se o prazo de encerramento for excedido. Rollback de imagem só para versão compatível com schema; nunca reset de banco.

## Validação desta preparação

Os três JSONs passaram no schema oficial do Railway; o YAML passou no schema oficial Compose, e caminhos de build, isolamento das portas, profiles e modelos de env foram conferidos localmente. Docker não está instalado neste Windows; o novo Compose com proxy e os limites de memória ainda precisam de smoke no host escolhido. A homologação anterior valida aplicação e Supabase, e o CI anterior valida as imagens sem esses novos limites. Nenhuma configuração do Railway/Render, DNS ou projeto Supabase foi modificada para esta comparação.
