# Novo Supabase: ensaio local de 02/11/2026

Destino único: `gpkodfsofwiroskdmeax`. Projeto anterior preservado. Banco confirmado
vazio antes de aplicar as 32 migrations. Reexecução sem reaplicar migrations.
Não houve reset, importação de backup, AWS, Render, contratação ou agenda ativa.
Horários dos relatórios privados usam UTC; a rodada começou em 02/11 em São Paulo.

## Código e infraestrutura

Os pilotos de calendário e a API executaram `55ae175b91f20286790dc8fc13a5750de2730cb1`.
A tentativa corrigida de resultados e a exportação executaram o worker
`684684321fff19dcfbdfc0a4b16c602c74b66b6a`. O CI deste último passou:
[execução 41548476525](https://github.com/gustavomf-ykn/universal-race-calendar/actions/runs/41548476525).
Foram 377 testes TypeScript e 252 Python (um desmarcado), tipos, build, lint,
OpenAPI, lifecycle e imagens reais com Chromium. Docker foi testado no CI, pois
não está disponível neste PC. A primeira suíte local completa teve problemas
de ambiente Python e uma falha de integração no Windows; não é apresentada como
suíte local integralmente aprovada. As regressões dirigidas do parser/perfil
passaram localmente (28 casos após a correção).

API nativa em `127.0.0.1:3000`, dois executores locais e túnel temporário
`https://commons-wrapped-dublin-depot.trycloudflare.com`. O túnel encaminha a API;
não é usado para consultar as fontes. Sua URL depende desta sessão e muda ao
reiniciar. Conta admin própria preparada por formulário protegido, sem armazenar
senha. O usuário confirmou Site URL e Redirect URLs do novo Auth.

RLS/privilégios de 42 tabelas e funções de aquisição/heartbeat/finalização
auditados. Bucket `race-exports` privado, XLSX/ZIP permitidos. Capacidade interna:
64 MiB de crescimento inicial para banco, além da margem de segurança, e 32 MiB
de Storage, após confirmação do espaço no Usage pelo proprietário. Não é compra
de capacidade. Native Chromium DOM/JavaScript passou.

## Pilotos reais por API e workers locais

| Fonte/cenário | Tarefa principal | Descobertos | Processados | Novos | Existentes |
| --- | --- | ---: | ---: | ---: | ---: |
| TicketSports | `f8f3c4a9-d6aa-4c38-8f7c-9eb4ca66ece6` | 25 | 5 | 5 | 0 |
| CorridasBR | `afaf44f2-bd04-4a35-b826-558a3c65167b` | 89 | 5 | 5 | 0 |
| OpenResults | `f6cc1460-4bd4-4a12-a4d1-f1dad3a91616` | 3 | 3 | 3 | 0 |
| TicketSports: novo lote intencional | `01e04245-a975-419f-8b0c-7df37de5578d` | 25 | 5 | 0 | 5 |

Todas as tarefas de enriquecimento desses lotes concluíram. Houve algumas
retentativas automáticas por falha transitória de provedor nos lotes iniciais,
sem bloqueio observado. O ciclo fica `ready` para uma continuação explícita;
isso não significa cobertura completa. Os 89 candidatos CorridasBR são os itens
descobertos no calendário estadual lido; apenas cinco foram processados.
Pedidos repetidos com a mesma chave retornaram a mesma tarefa. A repetição
intencional TicketSports criou zero edições/referências adicionais.

Os 13 primeiros registros ficaram pendentes de revisão. Uma edição conhecida
adicional foi verificada e publicada depois: total 14, uma publicada e 13
pendentes. A lista pública não inclui pendentes/incompletas. Modalidades e país
ausentes não foram inventados. Não foram encontrados caracteres U+FFFD nos nomes
persistidos desse piloto; a saída de alguns terminais Windows pode exibi-los.

## Associação, resultados e XLSX

Edição `evt_e27edbae921b459b9fa8bf1f`: Mountain Do Costão do Santinho 2026,
25/07/2026, Florianópolis/SC. Referências TicketSports `74857` e OpenResults
`37007`, conferidas por nome, ano, data e cidade/UF. O país BR tem evidência
explícita no endereço da TicketSports; a OpenResults não informou país. Essa
ausência ficou registrada, sem atribuir confirmação inexistente à segunda fonte.
A modalidade trail foi revisada pela descrição explícita de trilhas, bosques,
praias e dunas nos percursos principais, com auditoria via API.

- Metadados calendário: `9782c9c4-05c0-4cac-bacb-83f0624fb299`.
- Metadados resultados: `484d52b7-3ddb-4af5-8d52-dbf1347647fa`.
- Coleta original: `9c5736fa-3234-4672-9882-82f1e6024b57`, falhou uma vez com
  `source_structure_changed`; histórico mantido, nenhum resultado publicado.
- Nova tentativa após correção: `7a16950a-96b4-47cb-a149-b8e2d096c46f`, concluída.
  A fonte serializou o offset como `52.0`. O parser passou a aceitar números JSON
  inteiros nessa representação e continua recusando frações, infinito, NaN,
  offsets inválidos, lacunas e totais divergentes. Resposta real capturada foi
  validada offline antes de repetir. Não houve bloqueio nem contorno de proteção.
- Resultado persistido: **435**, em oito grupos confirmados: 5k F52/M39, 9k
  F94/M66, 21k F52/M83, 42k F5/M44. A contagem atual da fonte confirmou a
  referência histórica; os dados foram coletados novamente, sem importar o banco
  antigo. Consulta em cinco páginas e filtros das quatro modalidades passaram.
- Exportação `7c8562aa-c594-4725-b1ad-06b5b8d0cf91`, tarefa
  `3be705de-0eaa-49c7-9e66-1dd96d3d49ed`: concluída pelo Python, XLSX baixado e
  aberto, 435 linhas + cabeçalho, 19 colunas, 49.947 bytes, SHA256
  `8faed528b2108d624d26cee45e903c5a730ec6035fee4b37e573d6cf2d562c32`.
  Cabeçalhos preservam o exportador original, incluindo `event_id`, campos em
  português e Pace/Gap. Foram conferidos estrutura e cabeçalhos renderizados,
  sem alterar o arquivo. Mesmo pedido/chave retornou o mesmo artefato/tarefa.
  O primeiro diagnóstico atingiu seu prazo antes de observar a conclusão;
  acompanhamento posterior retomou o pedido existente, sem duplicar trabalho.
- Bucket privado e acesso direto sem assinatura negados. URLs assinadas e
  dados pessoais não são incluídos nesta documentação nem no Git.
  A URL assinada anterior foi negada após aguardar sua expiração real de 60
  segundos. Uma nova consulta autorizada da mesma exportação forneceu outro
  link, baixado com sucesso. O artefato permaneceu concluído e os 435 resultados
  continuaram persistidos. Expiração do arquivo (24h) é outro ciclo, coberto
  pelos testes controlados; não foi antecipada neste arquivo de homologação.
- ZIP: teste controlado local sobre os mesmos 435 resultados, divisão em
  200/200/35 linhas, três XLSX com 19 colunas, sem nova coleta ou upload. Esse
  ensaio não comprova download ZIP pelo painel/Storage. O limite normal dos
  workers permanece 25.000 linhas por parte.

## Distinção entre evidências

| Cenário | Evidência | Situação |
| --- | --- | --- |
| Novo banco/migrations/auditoria | Supabase real, aplicação repetida, RLS/grants/bucket | Aprovado |
| Auth admin/comum, ausente/inválido, chave restrita/revogada, PostgREST negado | Ensaio real; dois usuários técnicos removidos | Aprovado por API |
| Token real do projeto anterior | Nenhuma credencial antiga lida; validação de issuer coberta pelos testes | Pendente no ambiente real |
| CORS das duas origens | Ensaio Auth/API, Authorization e Idempotency-Key | Aprovado por API |
| HTTPS público, filtros, detalhes e paginação administrativa | Túnel real: três páginas, 14 edições; filtro de fonte suplementar/SC/data/trail encontrou a edição publicada | Aprovado por API |
| Expiração de URL e obtenção de link novo | Espera real, acesso antigo negado, novo download, 435 resultados preservados | Aprovado por API/Storage |
| Calendário/enriquecimento/deduplicação | Lotes pequenos acima, persistência real | Aprovado na amostra |
| Associação/435 resultados/XLSX | API local, workers locais, Storage real | Aprovado |
| Cancelamento, resposta perdida, checkpoints, interrupção, lease antigo e preservação após falhas/expiração | Testes automatizados no PostgreSQL descartável/CI | Aprovado controlado; não equivale a interrupção desta coleta real |
| ZIP e XLSX consolidado via API, Storage e navegador | Duas edições selecionadas pelo painel, 435 + 327 linhas, arquivos baixados e abertos | Aprovado |
| Login, calendário, detalhes, resultados, coleta, exportação, download e repetição de cliques no painel | Publicação confirmada e ensaio autenticado em Chromium isolado abaixo | Aprovado nos cenários descritos |
| Cancelamento, nova tentativa e controles de campanha no painel | Executores desligados, cinco tarefas técnicas canceladas antes da execução | Aprovado controlado |
| Continuação prolongada da campanha com dados reais | Controles testados separadamente; não foi executada varredura integral | Pendente |
| Cobertura nacional/agenda/AWS | Fora do piloto; agenda bloqueada, AWS não provisionada | Não executado |

O helper de controle do navegador nativo falhou ao inicializar. Após o proprietário
confirmar publicação/login, o site foi testado em Chromium headless isolado, com
identidades técnicas próprias e sem ler sua sessão/senha. As tentativas iniciais
do harness exigiram aguardar hidratação e manter o tab de polling em primeiro
plano; não foram interpretadas como falha de login do proprietário. CI, 202,
health ou fila vazia não substituem as evidências de processamento/download.
Arquivos completos e relatórios privados ficam em `.secrets/gpkodfsofwiroskdmeax/`.

## Aceite após publicação e correção do Session Pooler

O painel publicado consultou a URL HTTPS/Supabase novos. Login técnico via Auth
retornou 200; detalhes abriram; a interface mostrou 435 registros e filtro 5k com
91 registros, incluindo página dois. Nenhum erro JavaScript foi observado. As
contas técnicas foram removidas após cada ensaio, sem convites.

Durante a espera, o Python encerrou e o supervisor parou ambos os executores. A
investigação confirmou `EMAXCONNSESSION`: 15 clientes no Session Pooler. A causa
não foi atribuída à senha. O PR #16 limita API e TypeScript a duas conexões Prisma
cada no perfil piloto (nativo/Docker), preserva SSL/credenciais e mantém a URI
Python livre de opções Prisma. Também recupera falhas transitórias ociosas com
backoff/health indisponível, sem repetir I/O ativa ou batch. Erros permanentes
de senha, tenant e certificado, inclusive sem SQLSTATE, não são repetidos. Os
logs incluem só fase, classe e SQLSTATE, omitindo mensagens/DSNs.

O candidato `934a61b14df8f07a20d0d502bae8af0a77a1c966` passou no CI
[41553831289](https://github.com/gustavomf-ykn/universal-race-calendar/actions/runs/41553831289)
e no ensaio abaixo. Os dois executores permaneceram disponíveis após a redução
de conexões, inclusive além do intervalo em que a interrupção havia ocorrido.
Os testes extras de classificação de erros permanentes e este relatório devem
ser integrados somente após o CI do último commit do PR. Não há nova migration
nem alteração de frontend; atualizar API/TypeScript/Python requer reiniciar os
processos com o código integrado.

- **Coleta efetiva pelo painel:** `97df5400-6697-4ab0-8087-1220b8a4d7a8`,
  concluída pelo Python local. Repetição da mesma intenção retornou o mesmo ID.
  Foram confirmados novamente 435 resultados: zero chaves novas, zero removidas,
  zero duplicatas. Isso é coleta bem-sucedida de dados iguais, não mera
  preservação após falha. Nenhum executor GitHub processou a tarefa.
- **Exportação pelo painel após essa coleta:**
  `9382bfd9-63d6-43a1-b050-f0911c28e450`, tarefa
  `ab50cb69-50dc-4efa-b714-a2a256512c02`. A primeira resposta foi descartada pelo
  harness após a API aceitar. Dois cliques posteriores usaram a mesma chave e
  retornaram o mesmo artefato/tarefa. A interface mostrou pronto para baixar e o
  navegador baixou do Storage (200) o XLSX: 435 linhas e 19 colunas, aberto e
  conferido. Há uma tarefa por intenção; ensaios técnicos separados usam usuários
  diferentes e geraram suas próprias exportações pequenas.
- **Controles pelo painel, executores desligados:** campanha
  `campaign_1f0199e247d34e9cb1adb255f22f0d01`, início, pausa, retomada e
  cancelamento aprovados. Suas três tarefas `catalog-sync`, a tarefa de coleta
  técnica `e34d3a98-4bdb-49ce-8d7d-58ff4a08b31b` e a nova tentativa
  `e1ff1a54-550f-42ac-b76a-f06757ef6a7d` foram canceladas com attempt=0. A falha
  original foi mantida e o checkpoint inválido não ofereceu retomada. Resultados
  permaneceram em 435 e a fila terminou sem tarefas pendentes/em execução. Não
  houve processamento de coleta nesses testes de controle.

## Segunda edição, revisão e exportações selecionadas pelo painel

A edição existente `evt_1cf7803294e8c66bf1e1d4f0`, Circuito De Corrida De Rua
Aabb Maravilha, OpenResults `42536`, foi conferida em 01/11/2026, Maravilha/SC.
O adaptador verificou metadados estruturados da página relacionada compatível
por data/cidade/UF, incluindo país BR. O nome observado declara corrida de rua.
Revisão/publicação foram feitas na administração do painel, com justificativa
auditada; não foi criada outra edição nem inferido país apenas pela UF.

- Coleta pelo painel `1848558f-0783-4561-b230-511e7e54baf5`: concluída pelo
  Python local, 327 resultados novos; 5 km F139/M83, 10 km F46/M59. A interface
  mostrou 327. Nenhum bloqueio da fonte ou contorno foi observado.
- Seleção das duas edições e opção individual/ZIP: exportação
  `105b2534-92b3-4131-8001-d8d0a3e7e6e2`, tarefa
  `47f0501a-6fa4-42bf-9cdb-f78a68fe32e6`, concluída. Download real pelo navegador,
  Storage 200 `application/zip`. ZIP aberto: dois XLSX, 327 e 435 linhas,
  19 colunas cada. A divisão em partes menores continua coberta pelo ensaio
  controlado anterior; este ZIP real usa o limite normal.
- Seleção consolidada: exportação `569b65d4-8a8c-405b-9b73-63d68972bfea`, tarefa
  `6027ee59-1698-447c-9020-e21d1211c80e`, concluída. Download real pelo navegador,
  Storage 200 XLSX, aberto: 762 linhas, 19 colunas. Contagem pela coluna de edição
  confirmou 37007=435 e 42536=327. Não houve nova coleta nesta exportação.

Estado após os ensaios: 14 edições, duas publicadas, 12 pendentes de revisão,
dois conjuntos e 762 resultados. As contas técnicas foram removidas. O vínculo
Mountain Do/TicketSports/OpenResults já estava resolvido; não foi recriada uma
pendência artificial para repetir sua resolução.

O script reproduzível é `scripts/profile-panel-smoke.py`; modos e limites no
runbook. A suíte de recuperação/interrupção por lease continua separada, no
PostgreSQL descartável do CI. Uma campanha prolongada com processamento real
permanece pendente; não há afirmação de cobertura nacional ou prontidão de produção.
