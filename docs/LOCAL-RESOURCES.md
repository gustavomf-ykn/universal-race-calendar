# Recursos locais dos executores — branch nacional

Implementação em desenvolvimento no Backend #12 e Frontend #3. Não publicada em homologação; nenhuma agenda é habilitada por esta proteção. Testes controlados não comprovam uma carga nacional.

## Política e configuração

Os dois executores conferem recursos antes de adquirir uma tarefa, durante as etapas e antes das requisições externas. O Python confere também antes do Chromium e da geração de planilhas. São medições periódicas, sem reserva de RAM, preempção ou limite imposto pelo sistema operacional: um crescimento entre verificações ainda pode causar interrupção, cuja recuperação depende do lease/checkpoint existente.

Configuração não secreta, no ambiente dos executores locais, não no frontend:

| Variável | Padrão | Significado |
|---|---:|---|
| `WORKER_MIN_FREE_MEMORY_MB` | 512 | Memória disponível mínima, em MiB |
| `WORKER_MIN_FREE_TEMP_MB` | 1024 | Espaço livre mínimo, em MiB, tanto no diretório temporário quanto no diretório de trabalho |
| `WORKER_MAX_RSS_MB` | 1024 | Teto de RSS, em MiB; alcançar o teto impede continuar |

Aceitam somente inteiros entre 128 e 1048576. Zero, negativos, decimais e valores inválidos falham na configuração; não desabilitam a proteção. A memória/espaço exatamente iguais ao mínimo são suficientes; RSS exatamente igual ao teto já exige espera. Não reduzir margens para esconder falta de recursos sem medir o consumo real.

TypeScript usa Node 22+ e [`process.availableMemory()`](https://nodejs.org/docs/latest-v22.x/api/process.html#processavailablememory), RSS do processo e [`statfsSync`](https://nodejs.org/api/fs.html#fsstatfssyncpath-options). Python usa [`psutil`](https://psutil.io/), disponível em `requirements-worker.txt`; considera limites de memória visíveis dos cgroups Linux e soma RSS do processo com seus descendentes, incluindo Chromium. A soma pode contar páginas compartilhadas mais de uma vez, conservadoramente. Medição ausente, inválida ou negada impede aquisição; não substitui limites desconhecidos pela RAM livre do host.

O snapshot inclui apenas motivo, horário e números de recursos/limites. Não inclui caminhos, nomes de processos, variáveis de ambiente ou mensagens brutas do sistema operacional.

## Espera, retenção e retomada

- Executor ocioso sem recursos: presença `resource_wait`, verificação periódica e nenhuma aquisição. Em modo batch, saída com motivo `local_resource_wait`, diferente de `queue_empty`.
- Pressão durante trabalho: tarefa volta a `queued`, com `executionHold=true`, `holdReason=local_resource_wait` e um dos códigos abaixo. Lease é liberado somente se ainda válido e pertencente ao executor. A tentativa é devolvida, progress/checkpoint persistidos são conservados e resultados válidos não são removidos.
- Após resolver a causa, a presença pode voltar a disponível. Uma tarefa retida não é liberada automaticamente: administrador usa **Liberar execução**, pela rota existente `POST /v1/tasks/{id}/hold`, com `hold=false` e justificativa. Backend verifica autorização e audita o motivo anterior. O código de erro local é limpo; checkpoint/histórico permanecem. Outros holds de fonte/capacidade não são liberados por esta ação de recursos.
- Uma medição nova pode recusar novamente o trabalho. Liberar uma tarefa não comprova capacidade suficiente nem coleta concluída.

| Código | Ação operacional |
|---|---|
| `local_memory_limit` | Liberar memória de aplicações desnecessárias e conferir o consumo/limite do executor |
| `local_disk_limit` | Liberar espaço no disco que contém temporários ou diretório de trabalho |
| `local_resource_measurement_unavailable` | Conferir runtime, dependências e permissões de medição |

`GET /v1/executors`, autenticado, expõe somente `resourceReason` além dos campos de presença existentes. Não expõe números nem tarefa ativa. `GET /v1/admin/workers` permite ao administrador consultar o snapshot. Presença antiga/desconectada nunca confirma disponibilidade. O painel diferencia espera local de falta de executor, limite do provedor e falha da fonte; um hold histórico não aparece como espera de tarefa encerrada.

## Planilhas

Exportações selecionadas conservam cabeçalhos/formatos portugueses e dividem partes com até 25000 linhas e aproximadamente 16 MiB de conteúdo textual serializado. Um registro individual acima desse orçamento exige refinar a seleção. A soma dos arquivos da exportação permanece limitada a 50 MiB; partes múltiplas são ZIP. O catálogo simples consulta apenas os campos necessários.

O gerador ainda usa workbook em memória; esses limites e verificações reduzem consumo, sem garantir um teto absoluto de alocação. Divisão não descarta linhas. A proteção não implementa checkpoint por página no fallback DOM: essa retomada continua pendente.

## Integração e validação

Migrations aditivas `20261003000300_local_resources` e `20261003000400_local_resources_checkpoint`, na ordem completa do PR, adicionam snapshot de presença e retenção com preservação de progress. Função operacional sem EXECUTE de PUBLIC/anon/authenticated. A segunda migration conserva campos já gravados antes da primeira etapa; aplicar toda a sequência, não apenas a primeira.

Aplicadas e repetidas somente em PostgreSQL local isolado nesta rodada. Antes de homologar: autorização de integração, confirmação de `race-platform-staging`, backup, parada de consumidores antigos, todas as migrations, build/Prisma/dependências dos dois executores, deploy explícito da API e publicação do frontend compatível. Merge não comprova atualização. Nenhuma migration Supabase ou publicação foi executada nesta entrega.

O inicializador confere schema/dependências. Quando há pressão inicial, adia o smoke do navegador e inicia consumidores em espera para informar a causa no painel; isso não significa Chromium validado. O smoke real requer recursos suficientes e verifica também a medição com descendentes do Chromium.

Regressões controladas cobrem fronteiras, medições desconhecidas, cgroups, consumo dos descendentes, recusa antes de requisição, checkpoint/resultados preservados, token vencido, autorização/auditoria, privilégios e espera/encerramento de processos reais em banco local. XLSX/ZIP são abertos pelos testes e conferidos. Não são testes no navegador autenticado, download do Storage real ou importação nacional.
