# Homologação real — 21/09/2026

Ambiente exclusivo: Supabase `race-platform-staging` (`sggrijhyblejlgimgzzc`).
API: https://universal-race-calendar.onrender.com; painel: https://runfinder-rithmy.lovable.app.
API observada: `97f27f7c98fe5a01b0fe676302b14cc97f9b3886`, versão 2.0.0.
Workers locais compilados a partir da main `89fbf3f` com as correções deste PR.
Nenhum merge, deploy, migration, runner de coleta, agendamento ou alteração de produção.

## Diagnóstico

O banco e `GET /v1/events` tinham exatamente duas edições publicadas. Não era um
limite de duas linhas nem um filtro oculto. A exportação solicitada estava `queued`,
tentativa zero: a API havia aceitado, mas não havia executor para produzir o arquivo.

Havia tarefas de calendário de 10 e 500 candidatos. Para não consumi-las, cada lote
de teste bloqueou temporariamente as demais linhas queued numa transação e iniciou
um worker em batch com limite de uma tarefa; a aquisição usa `SKIP LOCKED`. As
transações foram liberadas ao fim de cada lote. Não se deve iniciar um worker normal
antes de revisar essa fila: MaxTasks=1 não limita quantas provas uma tarefa pede.

`quantity` limita candidatos examinados, não registros novos. CorridasBR descobriu
85 entradas na página de calendário, mas processou apenas três detalhes. TicketSports
também processou três. Concorrência local: um executor por vez.

## Evidências

| Cenário | Tarefa/edição | Esperado | Observado | Pendência |
|---|---|---|---|---|
| TicketSports, quantity=3 | `a2aedeba-f197-4433-be38-fe804a9ee35e` | Crescer catálogo | completed, 3 novas, 0 falhas; 2→5 | Nenhuma |
| CorridasBR, SC, quantity=3 | `b964dbda-cfce-4fd9-bd6b-a84fb8bb549d` | Crescer catálogo | completed, 3 novas, 0 falhas; 5→8 | Nenhuma |
| Repetição TicketSports | `21487f25-2474-487b-b71d-6443d3800d6b` | Deduplicar | completed, 3 inalteradas, 0 novas; total 8 | Nenhuma |
| Mesmo POST/Idempotency-Key | Cada um dos três lotes acima | Mesma tarefa | Mesmo ID retornado, sem duplicação | Nenhuma |
| Resultados e páginas | `evt_91fe44bc51e94cf6acf036b6` | 435 preservados | 5 páginas de até 100, 435 IDs únicos | Não representa nova coleta de resultados |
| Modalidades | Mesma edição | Soma 435 | 5k=91; 9k=160; 21k=135; 42k=49 | Nenhuma |
| Exportação existente | tarefa `e7af7317-be22-40d1-b671-a2c0a86f9af4` | Arquivo real | Python completed, tentativa 1; XLSX 36.121 bytes, 435 linhas | Expira em 24h da solicitação |
| Renovação de link | export `2981e8a6-492f-48f8-9350-ea8a5b69416c` | Link antigo negar; novo baixar | Após 66s: antigo HTTP400; novo HTTP200; arquivo completed | Nenhuma |
| Arquivo já expirado | export `de7b3679-da5d-4d32-a0f6-3e224153f413` | Sem download | expired, downloadUrl ausente; resultados ainda 435 | Nenhuma |
| Segunda edição | inspect `a46fd33c-ab57-41be-be4f-d980b557cc50` | Identificar sem associação falsa | completed; OpenResults39064, Trilha das Bruxas, 21/06/2026, São Pedro de Alcântara/SC | Associação com calendário não comprovada; sem coleta de resultados |
| Calendário publicado | Navegador autenticado | Novas provas visíveis | 8 edições, Mountain Do com acentuação correta e Trail, cidades limpas | Nenhuma |
| Detalhes/resultados publicados | Navegador autenticado | Abrir edição e resultados | Detalhes abriram; 435 registros em 22 páginas de 20 | Nenhuma |
| Download publicado | Navegador autenticado, export existente | Receber XLSX | Clique Baixar mostrou completed; XLSX recebido em Downloads, 36.121 bytes | Melhorias de acompanhamento dependem do PR frontend |

XLSX aberto em memória com openpyxl: cabeçalhos `name,bib,modality,gender,category,
overallPosition,categoryPosition,time,pace,team,source,sourceUrl,updatedAt`, 435 linhas
não vazias. Não publicamos linhas de atletas nem URLs assinadas. Bucket `race-exports`
confirmado privado. O clique no painel foi feito com a sessão já autenticada do usuário;
as demais chamadas usaram usuário técnico temporário de homologação, removido ao final.

Paginação adicional pela API: limit=3, página1 com3, página3 com2, total8. Os testes
reais usaram HTTP das fontes; a configuração histórica `AI_PROVIDER=mock` seleciona
a normalização determinística dos adaptadores, não fixtures de calendário.

## Correções

- A conversão indiscriminada Latin-1→UTF-8 danificava texto Unicode válido como COSTÃO
  e VALORIZAÇÃO. Agora só repara sequências reversíveis, preservando Unicode válido.
- CorridasBR removia marcação, mas deixava o texto dos links de navegação dentro da
  cidade. O parser remove os links específicos, preservando o nome da cidade.
- Modalidade e distâncias respeitam evidência de trilhas na fonte. Mountain Do tem
  descrição explícita de trilhas, bosques, praias e dunas. Texto de suporte como
  “Trilha do Líder” não basta para classificar como trail; há regressão específica.
- Oito edições existentes foram reprocessadas com os adaptadores corrigidos, até
  quatro por fonte, sem novos eventos. Uma correção pontual adicional confirmou a
  classificação do Treino de Verão. Os 435 resultados permaneceram disponíveis.
- Frontend (PR separado): intenção persistente por usuário/operação/edição/payload,
  coalescência de cliques, mesma chave após resposta perdida; polling de exportações,
  invalidação de consultas após tarefa terminal, download com URL nova e navegação
  sem popup, timeout de 120s com mensagem de inicialização e nomes atuais nas referências.

Testes automatizados locais: backend60 aprovados e22 testes de integração ignorados
por não haver banco descartável configurado; regressões finais27 aprovadas. Build,
tipos e lint dos fontes passaram (artefatos privados de diagnóstico excluídos do lint).
Frontend5 testes de regressão, tipos, lint dos arquivos alterados e build aprovados.
As melhorias novas do frontend foram testadas por código; a navegação acima usa a
versão publicada, sem publicar este PR. Nenhum health/fila vazia foi usado como prova
de coleta ou exportação.

## Operação e integração

Workers encerrados. Permanecem tarefas queued, inclusive um pedido de500 provas;
revisar a página Tarefas e cancelar os pedidos que não se deseja executar **antes**
de ligar os executores de uso diário. Não foram cancelados pedidos do usuário.

Após revisar a fila e atualizar/compilar o backend, abra PowerShell na pasta do backend:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-staging-worker.ps1 -Worker calendar -Mode batch -MaxTasks 1 -MaxSeconds 600
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-staging-worker.ps1 -Worker results -Mode batch -MaxTasks 1 -MaxSeconds 600
```

Execute separadamente conforme a tarefa. Calendar atende TicketSports/CorridasBR;
results atende OpenResults e novas exportações. O script usa os secrets DPAPI existentes,
sem pedir para colar valores no chat. O batch termina sozinho; Ctrl+C solicita parada.
Limite de tempo não desfaz o que já foi persistido e pode deixar recuperação por lease.
Leitura do calendário/resultados e download de arquivo já pronto dispensam worker.

Ordem sugerida: revisar/integrar PR backend, atualizar workers locais; depois revisar/
integrar PR frontend e publicar pela Lovable. Mudanças não exigem migration. Deploy
da API é manual, se desejado para alinhar versão; estas correções de extração dependem
principalmente do worker atualizado. Merge no frontend main sincroniza com Lovable;
verificar publicação no editor. Não houve push direto à main.

Após publicação: repetir um pequeno pedido controlado, observar queued/running/completed,
abrir resultados, solicitar exportação, executar batch Python e baixar. Verificar erro
source_access_blocked sem tratar preservação dos resultados antigos como coleta nova.
