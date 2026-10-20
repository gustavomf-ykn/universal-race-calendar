# Retomar o Runfinder de outro dispositivo

Estado conferido no GitHub em 19/10/2026. Este arquivo é o ponto de entrada para um novo operador ou agente. Não depende da pasta, do histórico do chat ou do perfil Windows do computador anterior.

## Repositórios e versões

| Componente | Repositório | Estado verificado |
| --- | --- | --- |
| API, workers, migrations e preparação AWS | [universal-race-calendar](https://github.com/gustavomf-ykn/universal-race-calendar) | Backend #14 integrado na main em d45071d7b1baedce6a5f226d82e34b2b523d3814 |
| Painel Lovable | [runfinder-rithmy](https://github.com/gustavomf-ykn/runfinder-rithmy) | Frontend #4 aberto; branch codex/aws-catalog-operations; implementação 166a8cc89f737f76e3a8940d9a5bbb4d747ff4f5, seguida da documentação de retomada |
| Continuidade e arquivo histórico | Este PR de documentação | Branch codex/device-independent-handoff; integrar após revisão |

- [CI da main do backend](https://github.com/gustavomf-ykn/universal-race-calendar/actions/runs/38476468604): aprovado no merge d45071d7.
- [CI da implementação do frontend](https://github.com/gustavomf-ykn/runfinder-rithmy/actions/runs/38468209955): aprovado no commit 166a8cc8.
- [Frontend #4](https://github.com/gustavomf-ykn/runfinder-rithmy/pull/4): permanece separado da main. Não fazer merge/publicação por conta deste documento.
- Os checkouts locais foram inventariados: sem alterações de código ou commits exclusivos aguardando envio. Treze documentos de planejamento/diagnóstico/evidência foram arquivados em [docs/history](docs/history/README.md). Pastas de dependências e artefatos privados não são parte do código-fonte.

Os commits acima identificam código, não a versão efetivamente publicada. Em uma nova sessão, confira os heads dos PRs, CI e /v1/version da API antes de agir.

## Onde está cada parte

- Painel publicado conhecido: https://runfinder-rithmy.lovable.app .
- Preview configurado: https://id-preview--e21cded7-e20c-4cde-affb-e861bee99b6e.lovable.app .
- API Render conhecida: https://universal-race-calendar.onrender.com . A resposta atual não foi revalidada nesta rodada documental; não presumir que usa o commit da main.
- PostgreSQL, Auth, fila, checkpoints e Storage: somente Supabase race-platform-staging, ref sggrijhyblejlgimgzzc, URL pública https://sggrijhyblejlgimgzzc.supabase.co .
- API, calendário TypeScript e resultados/planilhas Python/Chromium: destino preparado em AWS Lightsail, com Caddy. A preparação não comprova a existência de uma instância implantada.
- OpenResults já está incorporado em apps/openresults-worker. Não é necessário clonar o repositório antigo scraper-openresults.
- Cache, sessão e intenções de idempotência do navegador não são um backup compartilhado entre dispositivos. Faça novo login e consulte as tarefas existentes antes de repetir uma operação cuja resposta se perdeu. Não copie tokens ou perfis de navegador.

Dados persistidos do Supabase não dependem dos clones. Novas coletas, campanhas e exportações precisam de workers em execução; enviar código ao GitHub não os inicia.

## Clonar e continuar o desenvolvimento

No novo dispositivo, entre no GitHub com a conta autorizada e clone os dois projetos. Enquanto este PR de documentação estiver aberto:

```bash
git clone --branch codex/device-independent-handoff https://github.com/gustavomf-ykn/universal-race-calendar.git
git clone --branch codex/aws-catalog-operations https://github.com/gustavomf-ykn/runfinder-rithmy.git
```

Depois de integrar os PRs, prefira clones da main. Antes de editar, leia AGENTS.md quando existir e confirme git status, branch, PRs e CI. Crie uma branch codex/ para novas alterações. Preserve o histórico conectado à Lovable; não use force push, rebase, amend ou squash de commits publicados.

Backend: Node 22 e pnpm 9.15.4, conforme CI; Python 3.12 para o worker. A partir da raiz do backend:

```bash
corepack enable
corepack prepare pnpm@9.15.4 --activate
pnpm install --frozen-lockfile
pnpm db:generate
pnpm build
pnpm lint
pnpm typecheck
```

Use .env.example apenas como modelo local com placeholders/valores de teste. Instalação, geração e build não autorizam conexão operacional, migrations, seed ou aquisição de tarefas no staging. A suíte SQL exige PostgreSQL descartável: siga o CI e [RUNBOOK](docs/RUNBOOK.md); nunca aponte testes destrutivos ao Supabase.

Frontend: Node 24, conforme seu CI. A partir da raiz do frontend:

```bash
npm install --ignore-scripts --package-lock=false
npm test
npx tsc --noEmit
npm run build
```

O repositório usa bun.lock; o comando acima reproduz o fluxo npm do CI sem criar outro lockfile. Para desenvolver a interface, configure somente as variáveis públicas descritas em docs/REMOTE-DEVELOPMENT.md e execute npm run dev. Abrir um preview não publica a Lovable.

Não execute os inicializadores de workers para verificar instalação. Nenhuma pasta .venv, node_modules, .pnpm-store ou .tooling do computador anterior é necessária: recrie dependências pelos manifests e lockfiles. Não é preciso usar a API Uvicorn legada incorporada ao OpenResults para operar a plataforma unificada.

## Acessos e secrets fora do computador

| Acesso/configuração | Onde disponibilizar com segurança | Uso |
| --- | --- | --- |
| GitHub | Conta com acesso aos dois repositórios | Código, PRs e CI |
| Lovable | Conta/projeto conectado ao frontend | Preview e publicação explícita |
| Supabase staging | Conta autorizada no projeto confirmado | Auth, banco e bucket privado |
| AWS | Perfil de operador SSO; nenhuma access key permanente no host | Conferir custo e executar implantação autorizada |
| DATABASE_URL, DIRECT_URL | Parameter Store SecureString, /runfinder/staging/ | Prisma e migrations controladas |
| WORKER_DATABASE_URL | Mesmo prefixo, SecureString; URI Session/direct 5432 com SSL compatível com libpq | Worker Python |
| SUPABASE_SECRET_KEY | Mesmo prefixo, SecureString | API e worker de arquivos |
| INTERNAL_API_KEY | Gerar no gerenciador conforme runbook, SecureString | Uso interno; nunca frontend |
| SUPABASE_URL, CORS_ORIGINS | Configuração pública no mesmo prefixo | Projeto e origens autorizadas |
| VITE_API_BASE_URL, VITE_API_DOCS_URL, VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, VITE_APP_ENV_LABEL | Configurações públicas do build Lovable | Frontend; somente chave publicável |

Os quatro secrets do GitHub Environment race-platform-staging foram cadastrados anteriormente pelo proprietário. Não foram lidos ou revalidados nesta rodada. Esses secrets não são baixáveis para um novo computador; se for preciso cadastrá-los no Parameter Store, use a origem oficial ou seu gerenciador de senhas. Arquivos DPAPI do Windows anterior não são um mecanismo portável de transferência.

Não versionar .env real, .secrets, arquivos DPAPI, credenciais AWS/SSH, cookies/JWT, exports com atletas, backups ou logs privados. Não transferir secrets pelo chat, PR, issue, argumentos de shell ou histórico do terminal. O procedimento [AWS-HOSTING](docs/AWS-HOSTING.md) usa o operador autenticado para carregar arquivos protegidos no host.

## Próxima etapa: independência operacional

A execução contínua fora do computador exige a implantação AWS, ainda sem aceite comprovado. Não contratar recursos, provisionar ou habilitar agendas somente por ler este guia.

1. Revisar este PR documental e o Frontend #4. Backend #14 já foi integrado.
2. Confirmar conta SSO, custo regional/estimativa dentro do teto escolhido e autorização de provisionamento; definir hostname próprio, DNS, chave SSH existente e IP administrativo.
3. Publicar manualmente as imagens revisadas no GHCR, registrar SHA/digests e carregar secrets pelo Parameter Store. Não há imagem publicada confirmada por esta rodada.
4. Fazer backup protegido, encerrar outros consumidores, confirmar o projeto e aplicar somente as três migrations aditivas do Backend #14: 20261013000000_catalog_campaign, 20261013000100_catalog_campaign_indexes e 20261013000200_campaign_task_acquisition. Nenhuma foi aplicada por esta entrega documental.
5. Implantar API, verificar readiness/Auth/CORS/Storage e inventariar a fila real. Aprovar os IDs antes de iniciar workers; preservar pedidos protegidos. [Runbook AWS](docs/AWS-HOSTING.md).
6. Aceitar pilotos pequenos, depois lotes de 25: descoberta, persistência, cruzamento por evidência, contagens, reinício/leases/checkpoints e nova exportação XLSX/ZIP. A referência histórica evt_91fe44bc51e94cf6acf036b6 tinha 435 resultados; reconferir, sem tratar esse total como nova coleta.
7. Configurar a URL AWS no frontend, conferir CORS/Supabase Redirect URLs e publicar explicitamente na Lovable. Merge e sincronização do editor não comprovam publicação.
8. Somente após aceite, liberar carga ampla e ativar explicitamente segunda-feira 08:00 America/Sao_Paulo, janela recente de 90 dias e reconciliação histórica a cada quatro semanas. Validar a primeira ocorrência real.

Não há cobertura integral comprovada das três fontes. Não contornar bloqueios, misturar anos ou aumentar planos automaticamente. CI, heartbeat, /health, 202 ou queue_empty não substituem crescimento medido e download validado.

## O que conferir antes de qualquer operação real

- Estado atual do PR/CI/commit e SHA efetivamente servido pela API.
- Identidade exclusiva do Supabase staging, schema/migrations, capacidade de banco e Storage.
- Fila: IDs, operação, fonte, quantidade, holds, tentativas e erros; executores/leases ativos.
- Nenhuma disputa entre computador antigo, novo, AWS e GitHub runner.
- Escopo e autorização da operação. Agenda permanece desativada até liberação explícita.
- Após o teste, registrar contagens/evidências e se os workers ficaram ligados. Não publicar dados pessoais de resultados.

O [arquivo histórico](docs/history/README.md) conserva o contexto sem depender da conversa. Suas contagens e filas são fotografias datadas; não são inventário atual. Capturas e artefatos privados citados ali foram excluídos do repositório, e não são necessários para clonar ou construir.
