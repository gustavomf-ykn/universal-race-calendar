# AWS: API e executores contínuos do Runfinder

Preparação em 13/10/2026. Nenhum recurso AWS foi criado, nenhuma migration aplicada ao Supabase e nenhuma agenda habilitada por esta entrega. O painel continua na Lovable; PostgreSQL/Auth/Storage continuam exclusivamente em race-platform-staging, ref sggrijhyblejlgimgzzc.

## Arquitetura e custo

Uma instância Ubuntu 24.04 x86-64 Lightsail, 8 GiB/2 vCPUs, sa-east-1. API, calendário TS, resultados/planilhas Python/Chromium e Caddy. Instância única: indisponibilidade do host afeta todos os processos; não há alta disponibilidade.
Preço de referência: US$44/mês, antes de impostos, domínio, snapshots e excedentes. Snapshots US$0,05/GB/mês, opcionais e desativados nesta preparação; uso estimado total deve ficar até US$50. O limite não é um teto imposto à fatura. Conferir CPU/burst, disco, transferência e billing antes de ampliar.
Fontes oficiais: https://aws.amazon.com/lightsail/pricing/ ; https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-regions-and-availability-zones-in-amazon-lightsail.html .
O banco Free continua limitado a 500 MB por projeto; medições internas não confirmam a cota da organização: https://supabase.com/docs/guides/platform/database-size .

## Entradas externas obrigatórias

- Conta/perfil AWS SSO de operador, sa-east-1; não usar access keys permanentes no host. Permissões de leitura Lightsail para o plano, CloudFormation/Lightsail para o provisionamento autorizado e leitura/escrita somente do prefixo SSM /runfinder/staging/ para os secrets.
- Hostname próprio da API, por exemplo api.seudominio.com, e controle do DNS. Nenhum domínio é comprado automaticamente.
- Par de chaves SSH Lightsail existente em sa-east-1 e IPv4 público do administrador /32.
- Dois digests de imagens revisadas linux/amd64, commit de release e digest Caddy testado. release.env contém somente valores públicos.
- Antes da contratação, executar o plano de custo. O script não cria recursos e falha se não confirmar o bundle/blueprint regional ou se estimativa superar US$50.

## Credenciais e configuração

Cadastre na AWS Systems Manager > Parameter Store, região sa-east-1, prefixo /runfinder/staging/. Parâmetros secretos devem ser SecureString Standard. Não enviar valores no chat, em issues, arquivos de release ou commits.

| Nome                | Valor/origem                                                                                              | Exposição |
| ------------------- | --------------------------------------------------------------------------------------------------------- | --------- |
| DATABASE_URL        | Reutilizar URI staging SSL para Prisma                                                                    | secreto   |
| DIRECT_URL          | Reutilizar URI staging SSL de migrations                                                                  | secreto   |
| WORKER_DATABASE_URL | Reutilizar URI session/direct 5432 SSL libpq; sem parâmetros Prisma                                       | secreto   |
| SUPABASE_SECRET_KEY | Reutilizar chave privilegiada do staging; confirmar bucket com diagnóstico                                | secreto   |
| INTERNAL_API_KEY    | Gerar 32 bytes aleatórios, armazenar diretamente no gerenciador; nunca frontend                           | secreto   |
| SUPABASE_URL        | https://sggrijhyblejlgimgzzc.supabase.co                                                                  | público   |
| CORS_ORIGINS        | https://runfinder-rithmy.lovable.app,https://id-preview--e21cded7-e20c-4cde-affb-e861bee99b6e.lovable.app | público   |

Scripts de operador usam boto3/perfil SSO, não credenciais no código. load-secrets.py lê os parâmetros e transfere por SSH com StrictHostKeyChecking=yes, sem mostrar valores. API, TS, Python e migration recebem arquivos distintos com somente os campos necessários em /etc/runfinder/staging/, root:root modo 600. Compose >=2.30 usa env_file format raw; não interpreta caracteres de URI/chave. preflight.py confirma todos os DSNs, o projeto e a chave interna com ao menos 32 caracteres antes do deploy. verify-images.py confere somente o label público OCI de cada imagem e exige o mesmo commit informado na release. Os processos AWS também rejeitam destino divergente antes da primeira conexão. Não execute docker compose config sem --quiet, printenv, docker inspect completo ou shell com set -x.

## Preparar release e provisionar, somente após revisão/autorização

1. Integrar backend antes do frontend. Backend inclui duas migrations aditivas: 20261013000000_catalog_campaign e 20261013000100_catalog_campaign_indexes. APIs antigas continuam compatíveis; workers novos exigem schema novo.
2. Depois do CI do commit integrado, executar manualmente AWS immutable images na main. Só publica imagens; não implanta ou coleta. Confirmar os pacotes runfinder-api e runfinder-results como públicos nas configurações GHCR, após conferir exclusão de secrets. Registrar digests do resumo da execução.
3. Em ambiente de operador com Python, instalar deploy/aws/requirements.txt e validar custo:
   python deploy/aws/aws-cost-plan.py --profile SEU_PERFIL --snapshot-gb 0
4. Conferir os IDs retornados. Criar um change set com stack.yaml, região sa-east-1, AdminCidr /32 e KeyPairName. Revisar custo/recursos antes de executar. Não executar stack create/update sem autorização do proprietário.
5. Conferir IP/SSH fingerprint no console. Conectar por SSH, transferir deploy/aws para /opt/runfinder/deploy/aws e executar bootstrap.sh. Bootstrap instala Docker; não inicia aplicações, não aplica migrations e não recebe secrets.
6. Apontar DNS para o IP estático. Preencher release.env a partir do exemplo com hostname, SHA/digests. Caddy usa 443 para API; 80 apenas redireciona e atende emissão/renovação do certificado. Não expor 3000 ou portas dos workers.
7. Cadastrar parâmetros e executar load-secrets.py --profile SEU_PERFIL --host IP --ssh-key CAMINHO_PROTEGIDO. Nenhuma credencial AWS é transferida ao servidor.

DeletionPolicy/UpdateReplacePolicy Retain protegem instância/IP. Excluir o stack não encerra a cobrança desses recursos; desativação definitiva exige limpeza explícita e revisada.

## Integração do banco e implantação manual

Antes de atualizar uma instalação existente: encerrar consumidores locais/GitHub/AWS, conferir leases, inventariar a fila e fazer backup protegido do staging. Preservar os pedidos antigos protegidos e qualquer tarefa fora do teste aprovado. Nenhum comando faz reset.

No host, com release/credenciais conferidas:

- sudo python3 /opt/runfinder/deploy/aws/preflight.py /opt/runfinder/deploy/aws/release.env
- cd /opt/runfinder/deploy/aws
- sudo docker compose --env-file release.env -f compose.yaml --profile maintenance run --rm migration
- Repetir o comando de migration: não deve reaplicar migrations concluídas.
- sudo bash deploy.sh api
- sudo bash diagnose.sh

Conferir /health, /ready, /v1/version (SHA/features), JWT admin/membro/ausente, CORS de publicação/preview e bucket privado. /ready testa banco/schema/configuração, não coleta nem permissão real de Storage. Para Storage:
sudo docker compose --env-file release.env -f compose.yaml exec -T api node scripts/check-staging-storage.mjs

## Liberar workers e testar a fila

Workers estão no profile workers; deploy da API não os inicia.

1. Conferir IDs/estados/holds/tentativas de todas as tarefas pendentes pela API autenticada.
2. Decidir explicitamente quais pedidos elegíveis podem ser consumidos; proteger pedidos não aprovados pelo mecanismo administrativo, sem cancelar histórico.
3. Criar /etc/runfinder/staging/worker-approval.json a partir do exemplo com projectRef, releaseSha e IDs aprovados. É configuração de IDs, não credencial.
4. sudo bash deploy.sh workers. O preflight somente leitura recusa worker recente, tarefa running ou qualquer queued sem hold fora da lista. Não adquire/cancela/libera tarefas.
5. Para atualizar workers já ligados, parar primeiro com stop.sh e aguardar o término/lease; preflight também impede disputa com executores de outra máquina.
6. Validar os três processos e Chromium real. Executar primeiro provas pequenas com a descoberta por fonte, lote cinco e autoContinue false. Só depois usar a campanha ampla (25/etapa).
7. Validar reinício, recuperação, fences e download XLSX/ZIP real; health/queue_empty/202 não substituem resultado.

Para watchdog de heartbeat, somente após liberar e validar workers:
sudo install -m 644 runfinder-watchdog.service runfinder-watchdog.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now runfinder-watchdog.timer
A cada cinco minutos ele reinicia somente worker unhealthy quando a API está pronta; resource_wait com heartbeat é saudável e não provoca churn. Interrupção forçada exige recuperação por lease. Docker restart policy sozinho não reinicia um contêiner apenas por unhealthy.

stop.sh encerra os workers com prazo para terminar a tarefa. rollback.sh previous-release.env volta somente a API compatível; não reverte banco e exige revisão antes de iniciar workers antigos. Conservar digests/configuração pública anterior e secrets no gerenciador.

## Frontend e operação diária

Alterar somente VITE_API_BASE_URL e VITE_API_DOCS_URL para a API AWS HTTPS, publicar explicitamente na Lovable e validar as duas origens. SUPABASE_URL/chave publicável e usuário admin atuais são reaproveitados. Nenhuma chave interna, DSN ou service key no navegador.
Painel novo detecta features.catalogCampaigns em /v1/version e mantém a carga ampla desabilitada em API antiga, sem tentar criar campanhas em rotas inexistentes.
Um clique inicia três ciclos, metadados e cruzamento; processos AWS ficam ligados. Pedidos de coleta/exportação confirmados mantêm chave e acompanham o mesmo trabalho; nova solicitação é explícita.
Agenda continua desativada. Após aceite, configurar pelo painel segunda 08:00 America/Sao_Paulo, 90 dias recentes, histórico a cada quatro semanas, lote 25/27 UFs, habilitar explicitamente e acompanhar a primeira ocorrência.

## Limitações e provas ainda necessárias

Acesso a fontes a partir da AWS não foi comprovado. Bloqueios não são contornados; fonte bloqueada não cancela as outras. Catalogação/enriquecimento/cruzamento/publicação/resultados são etapas distintas. Novos candidatos incompletos permanecem na administração.
Contagens por fonte não são soma de edições nacionais: referências podem se cruzar. Novos/existentes têm contadores transacionais; recibos anteriores sem counters continuam desconhecidos. Repetições só são exibidas quando medidas.
Supabase Free pode limitar espaço/transferência. Ajustar reserva apenas após conferir uso/cota da organização; nunca apagar provas/resultados ou aumentar plano automaticamente.
Aceite remoto pendente: hostname/conta/secrets, deploy, pilotos nas três fontes, carga prolongada, cruzamento real, 435 resultados, XLSX/ZIP aberto, recuperação e navegador autenticado. Testes sintéticos e CI são evidências técnicas, não homologação AWS.

O CI constrói as imagens e inicia os três processos em PostgreSQL descartável com filesystem somente leitura, limites de memória, tmpfs, heartbeat e Chromium (`tests/compose.aws-runtime.yaml`). Esse smoke testa a execução dos contêineres; não prova conectividade real à AWS, Supabase ou fontes.

## Comandos do operador, após autorização de provisionamento

Os valores abaixo são públicos. Substituir os exemplos antes de executar; nunca acrescentar secrets a esses argumentos. O change set não inicia a instância. Revisar seu resultado antes de executar pelo console.

```bash
aws sso login --profile SEU_PERFIL
python deploy/aws/aws-cost-plan.py --profile SEU_PERFIL --snapshot-gb 0
aws cloudformation create-change-set \
  --profile SEU_PERFIL --region sa-east-1 \
  --stack-name runfinder-staging --change-set-name initial-staging \
  --change-set-type CREATE --template-body file://deploy/aws/stack.yaml \
  --parameters ParameterKey=BundleId,ParameterValue=ID_CONFERIDO \
    ParameterKey=BlueprintId,ParameterValue=ubuntu_24_04 \
    ParameterKey=AdminCidr,ParameterValue=SEU_IPV4/32 \
    ParameterKey=KeyPairName,ParameterValue=CHAVE_EXISTENTE
aws cloudformation describe-change-set \
  --profile SEU_PERFIL --region sa-east-1 \
  --stack-name runfinder-staging --change-set-name initial-staging
```

Após provisionamento autorizado, IP/fingerprint/DNS e transferência dos scripts:

```bash
# No host; scripts não contêm credenciais:
sudo bash /opt/runfinder/deploy/aws/bootstrap.sh
# Na máquina do operador, depois de cadastrar Parameter Store:
python deploy/aws/load-secrets.py --profile SEU_PERFIL --host IP_CONFERIDO --ssh-key CAMINHO_PROTEGIDO
# No host, com release.env preenchido:
cd /opt/runfinder/deploy/aws
sudo python3 preflight.py release.env
sudo docker compose --env-file release.env -f compose.yaml --profile maintenance run --rm migration
sudo docker compose --env-file release.env -f compose.yaml --profile maintenance run --rm migration
sudo bash deploy.sh api
sudo bash diagnose.sh
# Somente após aprovar a fila e preencher worker-approval.json:
sudo bash deploy.sh workers
# Encerramento ou atualização:
sudo bash stop.sh
# Rollback de API, com release anterior compatível:
sudo bash rollback.sh previous-release.env
```

Conservar os arquivos públicos da release anterior antes de substituir release.env. Parar API/proxy também, quando solicitado: `sudo docker compose --env-file release.env -f compose.yaml stop api caddy`. Parar processos ou excluir o stack não apaga dados do Supabase e não encerra automaticamente a cobrança dos recursos retidos.
