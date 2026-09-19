# Homologação race-platform-staging

Hospedagem: o proprietário informou não ter serviços existentes no Render. Comparação atual de custos e arquivos preparados, aguardando escolha sem contratação/deploy: [HOSTING.md](HOSTING.md).

Projeto identificado pelo proprietário em 19/09/2026:
- Nome: `race-platform-staging`
- Project ref: `sggrijhyblejlgimgzzc`
- URL: `https://sggrijhyblejlgimgzzc.supabase.co`
- JWKS: `https://sggrijhyblejlgimgzzc.supabase.co/auth/v1/.well-known/jwks.json`

Homologação real executada em 19/09/2026: 11 migrations, 26 tabelas auditadas, Auth real, Storage privado e fluxo TicketSports–OpenResults com 435 resultados. Executores locais Node/Python conectados exclusivamente a este projeto. Aplicação no commit `753b2ba400f95a28c684e210581d8c2177cdcfd7`; scripts/evidências adicionados no commit subsequente deste PR. Nenhuma configuração de produção foi alterada.

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

Metadados públicos conferidos: MOUNTAIN DO COSTÃO DO SANTINHO 2026, 25/07/2026, Florianópolis/SC. OpenResults `37007`, quatro modalidades, total informado 435. A página do organizador vinculada pelo OpenResults aponta diretamente para TicketSports `74857`; a API TicketSports confirmou nome/data/local. O fluxo posterior persistiu 435 resultados; nomes e dados individuais não são publicados neste relatório.

1. Criar duas identidades temporárias próprias via Auth Admin API, sem convite: uma com app_metadata.role=admin, outra comum. Gerar senhas em memória; emitir tokens por login real. Registrar apenas os UUIDs para remoção posterior.
2. Descobrir/publicar a edição pela API de fontes e tarefa de check TicketSports. Usar o ID externo 74857 com o adapter ticketsports; é uma edição passada, portanto a listagem de próximas corridas não é suficiente.
3. Inspecionar a URL OpenResults via API, conferir data/local e resolver associação para o Event.id persistido. CorridasBR deve ser testado separadamente se não houver correspondência demonstrável.
4. Solicitar coleta OpenResults, confirmar 202 e consultar a tarefa até estado terminal. Comparar contagens e amostras em memória com a fonte, sem publicar nomes.
5. Consultar paginação, gerar XLSX e baixar link assinado; confirmar bucket inacessível a usuário indevido.
6. Repetir solicitação com mesma chave e depois nova coleta da edição; conferir contagens e ausência de duplicação.
7. Interromper processo durante tarefa, reiniciar e aguardar lease real de 90 s; conferir tentativa e preservação de dados. Falhas controladas devem ser identificadas separadamente de falhas reais da fonte.
8. Expirar exportação de teste, confirmar limpeza e resultados permanentes. Remover os dois usuários temporários ao encerrar, sem remover eventos/resultados como efeito da limpeza operacional.

## Aceite real em 19/09/2026

| Critério | Estado e evidência |
|---|---|
| 1. Login autorizado | Aprovado: login Supabase real, JWT ES256 e admin |
| 2. Descoberta real | Aprovado: TicketSports 74857, tarefa `67e01102-a3c8-4cbd-b41d-63463d90e671` |
| 3. Associação | Aprovado: OpenResults 37007, mesma edição/data/local; inspeção `6ff49694-4cc4-428e-a380-3f61c20105b5` |
| 4. API responde 202 | Aprovado: coleta `6a9ced00-0827-4f92-a546-f07ddd4475d6` |
| 5. Workers processam | Aprovado: processos TS/Python reais, tarefas completed |
| 6. Resultados persistidos | Aprovado: 435, consulta paginada; total conferido pelo parser com a fonte |
| 7. Exportar e baixar | Aprovado: tarefa `7177d145-6ebb-4027-893c-1c4be2151243`, XLSX de 36.128 bytes |
| 8. Repetição | Aprovado: mesma chave retorna mesma tarefa; nova coleta `538b7aaa-1044-4eb7-af19-a87b0b3799d2` mantém 435 |
| 9. Recuperação | Aprovado: tarefa `9d17409d-c487-440d-91c7-7e60329956cc`, tentativa 2 após 93 s |
| 10. Expiração preserva resultados | Aprovado: link expirado recusado, objetos removidos, 435 resultados disponíveis |

Evento interno: `evt_91fe44bc51e94cf6acf036b6`. CorridasBR validado separadamente, uma edição SC, tarefa `55243d30-2fa4-4499-a79b-a6bd32cfa368`; não foi associada à prova OpenResults.

Auth: sem token 401, token inválido 401, usuário comum na administração 403, API key com escopo insuficiente 403, revogada 401. PostgREST negou leitura operacional a anon e usuário autenticado. Duas identidades próprias temporárias foram criadas sem convite, autenticadas e removidas ao final. Senhas/tokens existiram somente em memória. JWT genuinamente expirado não foi aguardado; a verificação de expiração também possui regressão local.

Banco: migrate deploy aplicado e repetido com sucesso, 11 migrations concluídas; auditoria de 26 tabelas com RLS e privilégios negados aos papéis API; execução das funções da fila negada a esses papéis. Bucket privado com limite 50 MiB, nenhuma política pública de objetos. Download direto anônimo recusado; link assinado funcionou e deixou de funcionar após expirar.

Recuperação controlada: bloqueio transacional apenas no artefato de teste manteve o worker ocupado; processo Python foi encerrado e reiniciado, aguardando o lease verdadeiro de 90 s. Heartbeat, conclusão e barreira de gravação recusaram o token antigo. Uma publicação incompleta foi simulada chamando o publicador real com resultado incompleto: contagem e hash persistidos permaneceram iguais. Isso é injeção controlada, não uma falha provocada nas fontes reais.

Expiração controlada: antecipado expiresAt somente das duas exportações de teste; executada a rotina real de limpeza, confirmando objetos ausentes e resultados permanentes. Os resultados continuam no banco. Processos locais temporários foram encerrados após o ensaio.

### Reproduzir

Depois de `check`, `migrate` e `audit`, com Python/dependências disponíveis:

```powershell
.\scripts\with-staging-secrets.ps1 -Action auth -ProjectRef sggrijhyblejlgimgzzc
.\scripts\with-staging-secrets.ps1 -Action flow -ProjectRef sggrijhyblejlgimgzzc
.\scripts\with-staging-secrets.ps1 -Action recovery -ProjectRef sggrijhyblejlgimgzzc
.\scripts\with-staging-secrets.ps1 -Action corridasbr -ProjectRef sggrijhyblejlgimgzzc
```

Executar sem outros workers concorrentes de staging: o teste de recuperação pressupõe controlar o executor. Relatórios sanitizados ficam em `.secrets/staging-*-report.json`, ignorados pelo Git e protegidos pela ACL. Não imprimir o arquivo de credenciais. A comparação realizada cobre total declarado pela fonte, persistência, repetição, hashes e download; não houve auditoria manual independente de classificação individual.

### Limites e próximos acessos

- Docker/Chromium: imagens reais e navegador DOM/JS aprovados no CI isolado, [job](https://github.com/gustavomf-ykn/universal-race-calendar/actions/runs/35422211603/job/105841846703). Este computador não tem Docker; os processos conectados ao Supabase rodaram nativamente. Fallback Playwright contra a fonte real não foi acionado; smoke separado do navegador passou no CI.
- Hospedagem: identificar serviços/host existentes e exclusivos de staging. Não há URL HTTPS pública da API homologada. Inserir as variáveis da tabela no gerenciador de secrets desses três processos, implantar as imagens e repetir smoke nesse host. Nenhum serviço foi contratado.
- CORS: definir origem exata do futuro painel na API; não colocar credenciais privilegiadas no frontend.
- Backups: ensaio pendente de cópias consistentes e destino descartável confirmado; procedimento em MIGRATIONS.md. Não importar no banco de aceite sem plano explícito.

Parecer para painel: pronto para construir sobre os contratos; integração remota e teste no navegador dependem da API de homologação hospedada. Parecer para produção: não pronto, faltam operação hospedada, configuração final, ensaio de restauração/migração e decisão de corte separada.

## Execução finita validada em 19/09/2026

Decisão atual: Render Free somente API e Actions somente lotes de desenvolvimento/homologação, com alternativa local para operação. Configuração e limites: [BATCH-HOSTING.md](BATCH-HOSTING.md). Nenhum serviço Render foi criado nesta etapa.

`scripts/staging-batch-smoke.py` executou processos locais reais contra o mesmo Supabase isolado, sem fixtures no caminho de coleta. Passaram: fila vazia nos dois workers, modo contínuo preservado, limite de uma tarefa, limite de duração, recuperação após expiração real do lease, idempotência e download do Storage depois do encerramento do worker.

- Coleta OpenResults `39ec58fc-d052-4b68-9ac3-cd52536c5a37`: 9 s no laço do worker, 435 resultados preservados, sem duplicação.
- Exportação `c30b6e89-d8c6-413f-8a6a-c385dd40f03a`: 2 s, download validado após a saída do executor.
- Limite de 4 s interrompeu as tarefas TS `d4bdb212-abcb-4bdb-b46a-0f66406be4b3` e Python `5cb9e22a-0cec-4313-b609-71bc99bfe104`. Após 92 s, lotes seguintes recuperaram ambas e concluíram na tentativa 2, em 1 s e 3 s. Token antigo recusado; 435 resultados mantidos.

Interrupções foram controladas com bloqueios transacionais em registros de teste, sem provocar falhas nas fontes. Relatório sanitizado local: `.secrets/staging-batch-report.json`. Reproduzir com `with-staging-secrets.ps1 -Action batch -ProjectRef sggrijhyblejlgimgzzc`, sem outros workers concorrentes.

Tempos acima não incluem preparação completa e não medem GitHub Actions. Novos workflows contra Supabase e API remota Render permanecem pendentes de configuração externa. Regressões locais: 71 testes TypeScript e 54 Python, build/tipos/lint aprovados. CI de imagens é uma validação separada em banco descartável.
