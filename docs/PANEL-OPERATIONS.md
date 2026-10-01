# Operação pelo painel: atualização de homologação

## Estado e limites desta entrega

Atualização em 30/09/2026: Backend #9 e #10 integrados; API publicada em `91e9941c91ac7a4230ddd55ae3e11876aeb3c1d1`, comprovada por `/v1/version`. Frontend #2 integrado em `49643f893d6e1d046250b6fb022576e02523b34c` e publicação Lovable confirmada. Quatro migrations operacionais foram aplicadas exclusivamente no `race-platform-staging`, após backup. O procedimento abaixo é referência de implantação, não uma solicitação para repetir ações já concluídas.

O PATCH já passou no preflight para publicação e preview. Garuva foi revisada/publicada pelo navegador. A correção do parser CorridasBR está integrada, mas não corrige retroativamente snapshots e registros antigos; essa revisão de dados permanece pendente. O [diagnóstico de CORS](STAGING-CORS-2026-09-30.md) documenta a falha anterior.

Diagnóstico somente leitura em 24/09/2026: nenhum worker local ativo. Dois pedidos TicketSports aguardavam executor, sem tentativas:

| Tarefa | Quantidade | Criação UTC |
|---|---:|---|
| `5e8fe9d7-d889-4cd5-b427-972498115f2b` | 120 | 22/09/2026 00:25:13 |
| `8278a9e1-9eaa-41ea-8e72-856d8b631665` | 15 | 22/09/2026 00:56:40 |

Nenhum deles foi cancelado ou consumido. Ambos permanecem `queued`, com `executionHold=true`, e não são elegíveis para aquisição pelos executores atualizados. Não remover essa proteção. Quantidade representa provas examinadas, não necessariamente novas provas. Antes de iniciar o executor, revisar os demais pedidos elegíveis, incluindo tarefas recuperáveis cujo lease expirou.

## Ordem de atualização — executar somente quando autorizado

1. Integrar o PR do backend; manter os workers parados. Atualizar o checkout local com `git pull --ff-only` na main, preservando alterações locais.
2. Instalar dependências (`pnpm install --frozen-lockfile`; Python 3.12+ com `pip install -r apps/openresults-worker/requirements-worker.txt`; `python -m playwright install chromium`). Nesta máquina, reutilizar o Python de `../.venv/Scripts/python.exe`. Gerar cliente com `pnpm db:generate`.
3. Confirmar exclusivamente `race-platform-staging`, referência `sggrijhyblejlgimgzzc`. As migrations `20260922000000_worker_presence`, `20260922000100_panel_catalog`, `20260922000200_administrative_review` e `20260924000000_selective_execution` já foram aplicadas em 25/09; segunda execução confirmou idempotência. Backup e recuperação: [procedimento de rollout](STAGING-OPERATIONS-ROLLOUT.md). Não usar reset. PRs #9/#10 não exigem migration.
4. Render: no serviço da API, **Manual Deploy → Deploy latest commit**, após conferir o SHA integrado. Auto deploy continua desligado. Conferir `/v1/version` e `/health`. As novas rotas exigem atualizar a API, além dos workers; não basta atualizar o computador.
5. Integrar o PR do frontend, conferir a sincronização da Lovable e publicar explicitamente. Merge não comprova atualização do site. Não adicionar secrets ao frontend: somente API base URL, Supabase URL e publishable key; login JWT com `app_metadata.role=admin` validado no backend.
6. Revisar a fila e preservar a retenção dos pedidos de 120 e 15. Para homologação seletiva, usar `scripts/start-local-executors.ps1 -SelectedTaskFile .secrets/selected-operations.json`: somente os IDs desse arquivo serão consumidos; lista vazia não consome tarefas. Não iniciar outro runner ou worker em paralelo.

## Uso cotidiano no Windows

Abrir **Iniciar executores.cmd**, na raiz do backend. Ele gera o cliente, compila o código, verifica Python/Chromium, carrega as credenciais protegidas, valida a identidade de staging e inicia os dois processos contínuos. Não aplica migrations nem instala serviço do Windows.

Se houver pedidos na fila, a janela mostra IDs e escopo e pede `INICIAR`. Confirme apenas se deseja processar os pedidos apresentados. Depois mantenha a janela aberta e use o painel para solicitar catálogo, metadados, resultados e planilhas. Não é necessário um comando por solicitação. Para encerrar, pressione **Ctrl+C uma vez** e aguarde a tarefa atual. Uma segunda interrupção força a parada e pode exigir recuperação por lease.

Logs operacionais ficam em `.secrets/executors/operations.log`, sem payloads, nomes de atletas ou credenciais. Duas instâncias são impedidas por lock local e lock do banco. Presença ociosa é renovada a cada 20 segundos; após 75 segundos sem comunicação, o painel considera o executor desconectado. Comunicação recente não garante início imediato. O navegador não liga processos no computador.

Sem workers, calendário e resultados já persistidos continuam consultáveis, e arquivos prontos ainda não expirados podem ser baixados. Novas coletas e novas exportações aguardam executor. Links assinados duram até 60 segundos, arquivos 24 horas; um novo clique obtém novo link, mas não ressuscita arquivo expirado.

## Catálogo, revisão e recuperação

A seção administrativa permite descobrir provas, selecionar entre páginas, atualizar metadados, solicitar resultados, revisar, publicar, ocultar e rejeitar. Publicação requer data, cidade e UF. Revisões têm justificativa e auditoria; atualizações de metadados preservam a decisão administrativa de publicação. A apresentação pública dos detalhes continua existente.

- TicketSports: snapshot limitado (padrão 250 candidatos), percorrido por cursor, cinco por etapa no painel. A fonte atual não oferece paginação comprovada nessa integração; o estado final é **limited**, nunca catálogo completo.
- CorridasBR: uma página de calendário por UF, com cursor interno e avanço entre UFs. Cobertura significa apenas calendários consultados.
- OpenResults: uma página nativa por vez, com cursor e interrupção se a fonte repetir uma página ou não confirmar o fim. Datas desconhecidas permanecem pendentes de revisão. URLs têm identidade provisória `url:...` até resolver o ID numérico; nenhuma junção por semelhança de nome.

Continuar usa o checkpoint; repetir uma tarefa falha cria outra tarefa e preserva a anterior. Somente `catalog-sync` oferece retomada por checkpoint; outras operações reiniciam a edição/operação. Cancelamento é permitido apenas em `queued`. Bloqueio da fonte é falha, não atualização concluída; resultados válidos anteriores permanecem.

Cadastro por URL: inspecionar em Associações e usar **Registrar edição independente para revisão** ou selecionar visualmente uma edição existente, conferindo data e cidade. A inscrição no catálogo não pressupõe resultados disponíveis.

## Planilhas e diferenças conhecidas

Resultados reutilizam as 19 colunas portuguesas do exporter OpenResults original, incluindo ID da fonte, evento/data/cidade/UF, modalidade, distância, gênero, posições, categoria, número, nome, equipe, pace, tempo, gap, URL e data de extração. Número e ID permanecem texto, datas são formatadas, cabeçalho e tabela estilizados, linhas congeladas e conteúdo semelhante a fórmula protegido.

Dados antigos que não armazenaram distância e gap ficam em branco; não são inventados. Campos não persistidos pelo schema atual também não podem ser reconstruídos. O catálogo simples distingue ID interno e ID da fonte; o completo acrescenta campos canônicos e JSON com metadados/coleções persistidos. Não se afirma equivalência de metadados que nunca foram armazenados.

Exportação individual cria arquivos por edição; múltiplos arquivos ou partes geram ZIP. Consolidada divide em partes de 25 mil resultados quando necessário. Limite final de 50 MiB: se excedido, a tarefa falha explicitamente e requer seleção menor. Seleção manual aceita até 100 edições; exportação de todo o filtro captura IDs de todas as páginas, até 10 mil provas, sem truncar silenciosamente. Uma seleção de resultados contendo edição sem resultados falha explicitamente.

Histórico é por usuário no servidor. Storage permanece privado e a API autoriza e assina o download. Expirar exportação não apaga resultados.

## Evidências e aceite pendente

Testes automatizados locais cobrem presença ociosa, desligamento/reconexão, rejeição de duplicidade de inicializador, autorização, cursor transacional, identidade por URL, lease antigo, revisão auditada, idempotência, exportação de filtro com 21 registros, XLSX aberto com openpyxl, cabeçalhos/acentos/IDs/fórmulas e ZIP. São testes controlados, sem coleta real.

Aceite restante: tratar o snapshot antigo CorridasBR sem reiniciar seu cursor nem substituir a lista por uma descoberta posterior; revisar nove registros afetados ainda pendentes. A nova sessão de navegador em 01/10 UTC está desautenticada; a observação final do download ZIP aguarda novo login. Não repetir coletas externas já comprovadas apenas para testar interface ou idempotência. Falha de fonte deve manter resultados anteriores.

Evidências reais posteriores, até 30/09: catálogo administrativo com 29 provas; dois lotes CorridasBR de cinco com avanço do checkpoint, lotes pequenos TicketSports e cinco OpenResults. Resultados: Mountain Do 435 e Garuva Run 387; filtro 3KM de Garuva mostrou 113 no navegador. Exportações simples/completa de 23 provas (antes do lote OpenResults) e resultados de 435 linhas foram geradas e abertas tecnicamente. Cancelamento de uma exportação pendente e novo pedido distinto foram comprovados pelo painel. O usuário confirmou o download da última exportação individual; isso não comprova o download visual do novo ZIP.

O lote TicketSports `67e76b79-7909-4673-b34c-2dc7207457bc` concluiu cinco candidatos: uma prova nova e quatro existentes. A tarefa de metadados `b7d44860-7176-48e9-832d-6cbde87a1c81` corrigiu a Maratona de Criciúma (cidade e data), mantendo revisão pendente.

Em 30/09 às 19:54 UTC o usuário iniciou os executores em sua própria janela. Ambos continuavam disponíveis em 01/10 às 01:51 UTC, no commit `91e9941`, independentemente da sessão do agente. O pedido ZIP pelo painel `de6113ea-cb9c-42db-9d6d-dc9012ff2b91` foi processado automaticamente nessa janela e concluiu na terceira tentativa, após corrigir o MIME permitido do bucket privado. Artefato `83684a4a-8157-4481-914f-1ce952a50050`: ZIP com duas planilhas de 435 e 387 linhas, 19 colunas e congelamento A2; download técnico assinado 200, acesso público sem assinatura 400. Não houve coleta adicional nem novo pedido para recuperar a exportação.

A restrição antiga do bucket aceitava somente XLSX. A configuração de staging foi ajustada preservando privacidade, limite de 50 MiB e políticas. A migration aditiva `20261001000000_storage_zip` versiona essa compatibilidade para outros ambientes; não exige alteração da API ou do frontend. Executar o histórico de migrations pelo procedimento de staging, nunca editar checksums de migrations anteriores. A reversão da configuração deve restaurar os MIME types anteriores somente após interromper novas exportações ZIP; não apagar artefatos ou resultados.
