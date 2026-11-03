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
| ZIP via API, Storage e navegador | Divisão local controlada; faltam seleção/fluxo real no painel | Pendente |
| Campanha e todos os botões no painel publicado com novo projeto | Frontend preparado; exige publicação e sessão nova | Pendente |
| Cobertura nacional/agenda/AWS | Fora do piloto; agenda bloqueada, AWS não provisionada | Não executado |

O controle automatizado do navegador falhou ao inicializar nesta sessão. Não
foi realizado aceite autenticado do painel publicado com o novo projeto. CI,
202, health ou fila vazia não são usados como substitutos desse aceite.
Arquivos completos e relatórios privados ficam em `.secrets/gpkodfsofwiroskdmeax/`.
