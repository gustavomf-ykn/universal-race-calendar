# Homologação race-platform-staging

Projeto identificado pelo proprietário em 19/09/2026:
- Nome: `race-platform-staging`
- Project ref: `sggrijhyblejlgimgzzc`
- URL: `https://sggrijhyblejlgimgzzc.supabase.co`
- JWKS: `https://sggrijhyblejlgimgzzc.supabase.co/auth/v1/.well-known/jwks.json`

A consulta pública confirmou HTTP 200, ES256 e provedor de login por e-mail habilitado. Isso **não** valida login, banco, RLS ou Storage. Chave secreta completa e conexões PostgreSQL ainda não foram disponibilizadas. Nenhuma migration remota ou usuário foi criado.

## Lista única de acessos e onde colocá-los

| Serviço / variável | Tipo | Onde inserir | Validação dependente |
|---|---|---|---|
| Supabase / DATABASE_URL | Secreto | Secret da API e worker TS de staging | Persistência e fila |
| Supabase / DIRECT_URL | Secreto | Executor de migrations e API/TS (configuração Prisma) | Migrations e auditoria |
| Supabase / WORKER_DATABASE_URL | Secreto | Worker Python | Resultados e exportações |
| Supabase / SUPABASE_SECRET_KEY | Secreto privilegiado | API e worker Python; executor temporário de testes Auth | Storage e criação/remoção de usuários de teste |
| Supabase / SUPABASE_PUBLISHABLE_KEY | Público | Cliente de login/testes; futuramente painel | Auth e testes negativos de PostgREST/Storage |
| Supabase / SUPABASE_URL | Público | API, Python e cliente de login | Emissor JWT/JWKS/Storage |
| Backend / INTERNAL_API_KEY | Secreto gerado, exclusivo de staging | API e executor de testes | Administração técnica e coletas |
| Backend / CORS_ORIGINS | Público | API de staging; origens exatas | Acesso do futuro cliente |
| Backend / GIT_SHA, PORT, NODE_ENV | Público | Serviços de staging | Identificação e inicialização |
| Hospedagem / identificação dos serviços ou host existente | Público | Informar somente nomes/URLs ao agente | Inicialização dos três processos |

Obter conexões no painel Supabase, botão **Connect**. Usar Direct Connection ou Session Pooler (porta 5432), sempre o projeto acima, SSL `sslmode=require`. Não usar transaction pooler 6543. A senha do banco faz parte da URI; caracteres especiais devem ser codificados na URI. Python não aceita o parâmetro Prisma `schema=public`.

Obter chave `sb_secret_*` em Project Settings → API Keys. O backend também aceita a chave JWT legada via `SUPABASE_SERVICE_ROLE_KEY`, mas não são necessárias as duas. Não fornecer chave privada JWT, token pessoal Supabase, senha da conta Supabase nem chaves de produção.

O guia `@supabase/server` é uma opção oficial de middleware. Este backend usa verificação equivalente com jose/JWKS e clientes HTTP diretos; instalar outro middleware não substitui conexões PostgreSQL nem concede acesso ao projeto. Referências: [Server](https://github.com/supabase/server), [API keys](https://supabase.com/docs/guides/getting-started/api-keys), [privilégios](https://supabase.com/docs/guides/database/functions).

## Cadastro seguro neste Windows

Na raiz deste repositório, executar em um PowerShell do próprio usuário:

```powershell
.\scripts\set-staging-secrets.ps1 -ProjectRef sggrijhyblejlgimgzzc
```

O script lê valores com `Read-Host -AsSecureString`, protege o diretório `.secrets` por ACL do usuário Windows e cifra com DPAPI. A chave interna é gerada sem exibição. A chave publicável já fornecida pode ser reaproveitada do arquivo local público ignorado pelo Git. O arquivo criptografado só é decifrável pelo mesmo usuário Windows/máquina; não o enviar pelo chat nem copiar para o servidor.

Com os runtimes/dependências instalados e ambiente Python ativado:

```powershell
.\scripts\with-staging-secrets.ps1 -Action check -ProjectRef sggrijhyblejlgimgzzc
.\scripts\with-staging-secrets.ps1 -Action migrate -ProjectRef sggrijhyblejlgimgzzc
.\scripts\with-staging-secrets.ps1 -Action migrate -ProjectRef sggrijhyblejlgimgzzc
.\scripts\with-staging-secrets.ps1 -Action audit -ProjectRef sggrijhyblejlgimgzzc
```

`check` valida configuração, não conectividade. `migrate` chama Prisma migrate deploy e emite apenas resultado sanitizado. `audit` é somente leitura: confere tabelas/RLS, privilégios dos papéis API, funções da fila, histórico Prisma e bucket privado. Nunca executar a suíte Vitest destrutiva apontando para Supabase; ela só aceita banco local terminado em `_test`.

Para processos locais, em terminais separados, usar o mesmo wrapper com `-Action api`, `calendar` e `results`. Não há URL pública de API homologada definida neste momento.

## Servidor existente / Docker

Preferir o gerenciador de secrets da hospedagem exclusiva de staging. Em servidor Docker existente, materializar o env em arquivo privado fora do repositório, com permissões apenas para o operador; informar seu caminho por `STAGING_ENV_FILE`. Executar o preflight com o project ref confirmado antes de iniciar `compose.staging.yaml`. Não usar `compose.backend.yaml`: ele sobrescreve URLs para o PostgreSQL local.

Não executar `docker compose config`, `env`, `printenv`, shell tracing ou dumps de configuração com secrets. Não colocar credenciais em argumentos de comandos. Não modificar os secrets `PRODUCTION_*` nem os workflows de coleta de produção. Agendamento de staging ficará desligado durante o aceite.

Não foram identificados acesso à hospedagem ou Docker neste computador. O CI foi ampliado para construir as duas imagens e executar API, workers, migrações repetidas em PostgreSQL descartável e Chromium real com DOM/JavaScript, sem acesso ao Supabase. Esse ensaio não substitui o acesso aos serviços reais de staging.

## Candidata real e roteiro de aceite

Metadados públicos conferidos: MOUNTAIN DO COSTÃO DO SANTINHO 2026, 25/07/2026, Florianópolis/SC. OpenResults `37007`, quatro modalidades, total informado 435. A página do organizador vinculada pelo OpenResults aponta diretamente para TicketSports `74857`; a API TicketSports confirmou nome/data/local. Nenhum atleta foi extraído nesta preparação.

1. Criar duas identidades temporárias próprias via Auth Admin API, sem convite: uma com app_metadata.role=admin, outra comum. Gerar senhas em memória; emitir tokens por login real. Registrar apenas os UUIDs para remoção posterior.
2. Descobrir/publicar a edição pela API de fontes e tarefa de check TicketSports. Usar o ID externo 74857 com o adapter ticketsports; é uma edição passada, portanto a listagem de próximas corridas não é suficiente.
3. Inspecionar a URL OpenResults via API, conferir data/local e resolver associação para o Event.id persistido. CorridasBR deve ser testado separadamente se não houver correspondência demonstrável.
4. Solicitar coleta OpenResults, confirmar 202 e consultar a tarefa até estado terminal. Comparar contagens e amostras em memória com a fonte, sem publicar nomes.
5. Consultar paginação, gerar XLSX e baixar link assinado; confirmar bucket inacessível a usuário indevido.
6. Repetir solicitação com mesma chave e depois nova coleta da edição; conferir contagens e ausência de duplicação.
7. Interromper processo durante tarefa, reiniciar e aguardar lease real de 90 s; conferir tentativa e preservação de dados. Falhas controladas devem ser identificadas separadamente de falhas reais da fonte.
8. Expirar exportação de teste, confirmar limpeza e resultados permanentes. Remover os dois usuários temporários ao encerrar, sem remover eventos/resultados como efeito da limpeza operacional.

## Aceite atual

| Critério | Estado |
|---|---|
| Identidade do projeto e JWKS público | Aprovado |
| Revisão e regressão local | Aprovado: 67 TS e 47 Python |
| Login real autorizado e testes negativos Auth | Pendente de chave secreta |
| Migrations/RLS/fila no Supabase e reexecução | Pendente das conexões |
| Storage real e download/expiração | Pendente de secrets e processos |
| Imagens Docker e Chromium | Aprovado no CI isolado: build, processos, banco e navegador real |
| Fluxo principal real, repetição e recuperação em staging | Pendente da configuração |
| Ensaio de backups antigos | Pendente dos backups; não bloqueia sozinho a construção do painel |

Painel: contratos disponíveis para planejamento, mas integração homologada ainda não aprovada. Produção: não aprovada. Não confundir testes locais/CI e metadados públicos com aceite real completo.
