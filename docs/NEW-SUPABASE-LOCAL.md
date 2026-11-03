# Novo Supabase e backend local

Destino exclusivo autorizado em 02/11/2026: gpkodfsofwiroskdmeax. Banco inicialmente vazio, sem copiar Auth, arquivos, catálogo ou resultados do projeto anterior. O perfil público fica em config/staging-profiles.json; não substituir identidades em registros históricos.

## Configuração e operação no Windows

1. Usar Node 22 para o backend (imagem/CI), pnpm 9.15.4 e Python 3.12 com requirements-worker.txt e Chromium. Node 24 é usado pelo CI do frontend. Recriar dependências pelos manifests; nenhuma pasta de outro computador é obrigatória.
2. Abrir **Configurar novo Supabase.cmd**. A janela tem campos ocultos e aceita Ctrl+V/botão direito. Copiar a URI Session Pooler 5432 de Connect. Se ela contém [YOUR-PASSWORD], preencher a senha original no campo separado; caracteres especiais são codificados. SSL require é acrescentado quando ausente.
3. Informar as chaves sb_secret_ e sb_publishable_ do novo projeto. A chave interna é gerada localmente. O cadastro fica em .secrets/gpkodfsofwiroskdmeax/credentials.dpapi.json, com ACL restrita e criptografia do usuário Windows. Cadastros existentes não são sobrescritos. O projeto antigo não é lido.
4. Após aplicar e auditar migrations, abrir **Iniciar API local.cmd**, **Iniciar executores novo Supabase.cmd** e **Iniciar tunel HTTPS.cmd**. Os executores são iniciados uma vez e aguardam pedidos do painel. Conferir fila e consumidores antes de aceitar um início com tarefas pendentes.
5. Para parar os dois workers, abrir **Encerrar executores novo Supabase.cmd** e aguardar a tarefa atual. Só então encerrar API e túnel com Ctrl+C nas janelas correspondentes. Um encerramento forçado exige recuperação por lease.

O túnel usa um binário oficial com digest SHA256 verificado e encaminha somente a API 127.0.0.1:3000. A API conserva Auth/JWT nas rotas protegidas. A URL muda a cada sessão; manter o túnel aberto durante o aceite. Não usar esse endereço como hospedagem permanente.

## Preparação controlada

scripts/local-staging.ps1 aceita check, inventory, migrate, audit, api, workers, browser, stop, install-tunnel e tunnel. configure-gui é o cadastro visual; configure é uma alternativa de terminal oculto. Iniciar os serviços não aplica migrations.

Aplicar migrate somente depois de check confirmar o destino e schema esperado. O histórico completo usa migrate deploy, sem reset, seed ou importação. Repetir migrate para conferir idempotência. audit confere RLS, privilégios, funções da fila e o bucket race-exports privado com XLSX/ZIP e limite 50 MiB.

O limite de capacidade é interno e não contrata recursos. Depois de conferir Usage, a ação capacity --quota-confirmed do CLI Python configura crescimento de 64 MiB além do tamanho agregado medido e da margem de segurança de 16 MiB; Storage total de 32 MiB, margem de 1 MiB. A confirmação não substitui a medição do provedor. Configurações existentes não são ampliadas automaticamente.

## Perfil piloto

/v1/version anuncia supabaseProjectRef e environmentProfile.catalogPilot. O painel exige que a identidade da API coincida com o Auth antes de enviar consultas ou tokens; configurações públicas ausentes não retornam silenciosamente ao projeto antigo.

Campanha: SC, batchSize até 5, prefixLimit até 25 por fonte. Coletas de calendário/discovery até 5 por pedido, uma página OpenResults. A API rejeita excessos antes de enfileirar; os workers verificam novamente antes de acessar fontes. Quantidade não significa novos registros. Agenda semanal é bloqueada nesse perfil.

## Configuração da Lovable

Preencher o build com VITE_API_BASE_URL e VITE_API_DOCS_URL do túnel atual, VITE_SUPABASE_URL=https://gpkodfsofwiroskdmeax.supabase.co, VITE_SUPABASE_PUBLISHABLE_KEY do novo projeto e VITE_APP_ENV_LABEL=Homologação local.

Após iniciar o túnel, a ação `frontend-config` prepara
`.secrets/gpkodfsofwiroskdmeax/lovable-public.env` com somente esses cinco valores
públicos. Ela confere a identidade da API HTTPS antes de gravar e não imprime a
chave. Nenhuma chave privilegiada é incluída. O `.env` público do PR do frontend
foi preparado para a sessão de 02/11/2026. Confirmar se há variáveis externas da
Lovable sobrescrevendo o arquivo antes de publicar. Ao trocar a URL do túnel,
atualizar as duas URLs da API no build e publicar novamente.

Publicação: https://runfinder-rithmy.lovable.app .
Preview: https://id-preview--e21cded7-e20c-4cde-affb-e861bee99b6e.lovable.app .
Essas origens exatas são usadas no CORS. Configurar Site URL/Redirect URLs do novo Supabase, sair e entrar novamente. O usuário do projeto anterior não é transferido. scripts/profile-owner.py prepara a conta do proprietário por formulário, preservando metadados/senha de uma conta já existente.

Revisar os PRs antes da publicação. Merge sincroniza o editor conectado; não comprova atualização do site. Confirmar no navegador a URL da API e o novo projeto efetivamente usados.

## Docker e futura AWS

Dockerfile.backend e apps/openresults-worker/Dockerfile.worker já contêm os três processos e Chromium. compose.local-staging.yaml usa apenas o Supabase externo, sem banco local ou credenciais de teste. API inicia separadamente; workers exigem profile workers e migration exige maintenance.

LOCAL_STAGING_ENV_FILE deve apontar para um arquivo protegido fora do repositório, fornecido pelo gerenciador de secrets. Compose >=2.30 usa format raw para preservar os valores. Não copiar DPAPI para Linux. A mesma configuração por ambiente funciona em contêineres; os guardas de destino também se aplicam a esse perfil.

A receita AWS anterior continua fixada no projeto antigo até uma revisão explícita de release, prefixo SSM e destino. Para este novo perfil, o Compose é a referência; não executar o deploy AWS antigo esperando troca automática de projeto. Nenhum recurso AWS, agenda ou plano pago é ativado por esta entrega.

## Aceite

Registrar separadamente testes automatizados em PostgreSQL descartável, ensaios reais por API e navegador autenticado. Realizar pilotos pequenos, comparação com fontes, deduplicação, associação por identidade, resultados, XLSX/ZIP aberto, links autorizados e recuperação. Não repetir bloqueios ou tratar health/202/queue_empty como coleta concluída. Relatórios privados ficam somente no diretório do novo perfil; senhas/tokens/dados de atletas não entram nos relatórios públicos.

Evidências desta rodada: [02/11/2026](evidence/2026-11-02-new-supabase-local.md).
Os scripts `profile-calendar-pilot.py` e `profile-real-results.py` usam intenções
fixas e relatórios privados para acompanhar o mesmo pedido após interrupções.
Não são importadores em massa. Uma nova tentativa de resultado, após correção
de estrutura, usa a rota de retry/restart e preserva a tarefa original falha.
