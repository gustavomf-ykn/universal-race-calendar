# Integração do painel

Painel de homologação: https://runfinder-rithmy.lovable.app. API:
https://universal-race-calendar.onrender.com. Evidências e limites da rodada real:
[homologação de calendário e exportação](STAGING-ROUND-2026-09-21.md).

O backend é a autoridade de migrations; **não criar
ou modificar tabelas no Lovable**. Consumir HTTP da API, não as tabelas via PostgREST.
Contrato gerado: [openapi.json](openapi.json); Swagger: `GET /docs`.

## Autenticação e permissões

Configuração pública: URL da API, `SUPABASE_URL`, chave publishable do Supabase.
Login pelo SDK Supabase Auth. Enviar o `session.access_token` como
`Authorization: Bearer <token>`. O backend valida assinatura JWKS ES256/RS256,
issuer, audience `authenticated`, expiração e `role=authenticated`.
Renovar sessão pelo SDK quando receber 401. Não decodificar o JWT no frontend
para decidir autorização: a decisão ocorre no servidor.

Usuários autenticados leem resultados, criam suas exportações e acompanham suas
tarefas. `app_metadata.role=admin`, definido exclusivamente por administrador
via Supabase Auth Admin, permite coletas, curadoria, associações e gestão de keys.
`user_metadata` nunca concede administração. Após alterar a função do usuário,
renovar a sessão; um access token emitido anteriormente vale até sua expiração.

Clientes externos usam `X-Client-Key`, separado do login do painel. Escopos:
`results:read`, `exports:write`, `tasks:read`. Não podem obter escopo administrativo.
Chave aparece apenas uma vez ao criar; armazenada no backend como SHA-256, com
revogação e contador horário compartilhado em PostgreSQL. Nunca inserir
`INTERNAL_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` ou URLs do banco no Lovable.

## Operações

| Ação | Endpoint | Permissão |
|---|---|---|
| Listar edições | `GET /v1/events` | Pública |
| Consultar edição | `GET /v1/events/{id}` | Pública |
| Modalidades de resultados | `GET /v1/events/{id}/modalities` | Pública |
| Resultados | `GET /v1/events/{id}/results?page=1&limit=20` | results:read |
| Coletar calendário/resultados | `POST /v1/collections` | Admin |
| Descobrir OpenResults | `POST /v1/admin/openresults/discover` | Admin |
| Inspecionar URL OpenResults | `POST /v1/admin/source-matches` | Admin |
| Pendências | `GET /v1/admin/source-matches` | Admin |
| Resolver associação | `POST /v1/admin/source-matches/{id}/resolve` | Admin |
| Histórico/progresso | `GET /v1/tasks`, `GET /v1/tasks/{id}` | tasks:read; próprio ou admin |
| Cancelar tarefa aguardando | `POST /v1/tasks/{id}/cancel` | Admin |
| Solicitar XLSX | `POST /v1/events/{id}/exports` | exports:write |
| Consultar exportação/link | `GET /v1/exports/{id}` | exports:write; próprio ou admin |
| Criar/revogar API key | `POST /v1/admin/api-keys`, `DELETE /v1/admin/api-keys/{id}` | Admin |

Filtros do calendário: `country`, `state`, `city`, `sourceType` (lista separada por
vírgula), `from`, `to`, `distanceMin`, `distanceMax`, `modality`, `status`, `search`,
`sort`, `page`, `limit`. Datas ISO `YYYY-MM-DD`; limite máximo 100. País suportado
pela publicação atual: BR. Cada `Event.id` é uma edição; nunca agrupar resultados
de anos diferentes ou criar perfil global de atleta por nome.

## Fluxo principal

1. Listar calendário e guardar o ID interno da edição.
2. Inspecionar a URL OpenResults (ou descobrir até 10 páginas do catálogo):

```http
POST /v1/admin/source-matches
Authorization: Bearer <admin-access-token>
Idempotency-Key: inspect-unique-request-id
Content-Type: application/json

{"url":"https://openresults.run/evento/slug-da-prova/"}
```

Resposta `202`, `Location: /v1/tasks/<id>`:

```json
{"id":"uuid","source":"openresults","kind":"inspect","status":"queued","progress":{},"attempt":0,"maxAttempts":3,"errorCode":null,"createdAt":"2026-09-18T15:00:00.000Z","updatedAt":"2026-09-18T15:00:00.000Z","finishedAt":null}
```

3. Consultar pendências e enviar `{"eventId":"id-interno"}` a `/resolve`.
Datas conhecidas devem coincidir. Nome parecido não autoriza associação automática.
4. Solicitar a extração:

```http
POST /v1/collections
Authorization: Bearer <admin-access-token>
Idempotency-Key: extraction-unique-request-id
Content-Type: application/json

{"source":"openresults","eventId":"id-interno"}
```

5. Consultar a tarefa a cada 3–5 segundos; aumentar o intervalo quando em fila.
Fechar a página não cancela o trabalho. Para uma nova coleta, gerar nova chave de
idempotência. Reenviar a mesma intenção com a mesma chave retorna a mesma tarefa;
reutilizar a chave para outro conteúdo retorna 409.
6. Consultar resultados paginados. `resultSet` contém fonte, URL e atualização.

```json
{"data":[{"id":"uuid","name":"Nome publicado pela fonte","bib":"007","modality":"5 km","gender":"feminino","category":"F3039","overallPosition":1,"categoryPosition":1,"time":"00:25:00","pace":"05:00","team":"","resultSet":{"source":"openresults","sourceUrl":"https://openresults.run/evento/slug/","updatedAt":"2026-09-18T15:03:00.000Z"}}],"pagination":{"page":1,"limit":20,"total":1,"totalPages":1}}
```

7. Criar exportação com `Idempotency-Key`, acompanhar o `taskId`, então buscar
`downloadUrl`. Link assinado dura no máximo 60 segundos. Artefato expira após 24h;
solicitar outro com nova chave após expirar. Nunca persistir o link assinado como
URL permanente. Exportação e histórico de tarefas não são proprietários dos resultados.

## Estados para a interface

`source_access_blocked` é um **errorCode**, não um estado novo. Em tarefa failed, mostrar “Fonte bloqueou o acesso; resultados anteriores mantidos”, conservar a última atualização dos resultados e não criar retries automáticos. Workers antigos podem devolver apenas `collection_failed`; tratar como falha genérica, sem presumir bloqueio. `completed` significa publicação concluída, mas não necessariamente novos registros: uma coleta válida pode retornar conteúdo igual.

### Campos efetivamente disponíveis

| Recurso | Campos/limites para a interface |
|---|---|
| Evento | `id`, `slug`, `name`, `date`, `city`, `state`, `country`, `eventStatus`, `modality`, `display`, `sources`, `lastUpdatedAt`; demais detalhes e nulabilidade no OpenAPI. Não usar `event.updatedAt`, que não faz parte desse contrato |
| Modalidade | `id`, `name`, `distanceKm`, `externalId`, `resultSet.source`, `resultSet.updatedAt` |
| Resultado | `id`, `name`, `bib`, `modality`, `gender`, `category`, `team`, `overallPosition`, `categoryPosition`, `time`, `pace`, `resultSet.{source,sourceUrl,updatedAt}`; campos opcionais podem ser null |
| Tarefa | `id`, `source`, `kind`, `status`, `progress`, `attempt`, `maxAttempts`, `errorCode`, `createdAt`, `updatedAt`, `finishedAt` |
| POST exportação | `id`, `taskId`, `status`, `expiresAt`; não retorna arquivo imediatamente |
| GET exportação | Campos anteriores + `downloadUrl` (null enquanto indisponível); status pode ser `expired`, específico do artefato |

`GET /v1/tasks` admite apenas `page` e `limit`, sem filtro de status/fonte. `GET /v1/events/{id}/results` admite `page`, `limit` e `modality` (nome exato); não há busca por atleta, gênero ou categoria no servidor. Respostas paginadas usam `{data,pagination:{page,limit,total,totalPages}}`, limite máximo 100. Não inventar filtros, endpoint de disponibilidade de worker, endpoint de retry ou disparo de GitHub/local pela interface. Para os detalhes restantes, seguir o OpenAPI publicado.

`POST /v1/collections` para OpenResults usa `source` e `eventId` já associado; a URL é resolvida pelo servidor. Ausência de associação retorna 409 `source_association_required`. Para calendário, admite `source` ticketsports/corridasbr, `quantity` (1–500), `force` e `states`. `POST /v1/events/{id}/exports` não exige corpo nem oferece seleção de formato/filtros: exporta a edição em XLSX. Persistir `id` e `taskId` retornados, pois não existe listagem geral de exportações nesse contrato.

| status | Rótulo | Tratamento |
|---|---|---|
| queued | Aguardando | Pode ser espera por retry; mostrar attempt/errorCode |
| running | Executando | Mostrar progress.stage, percent e contadores disponíveis |
| completed | Concluído | Atualizar consultas de dados |
| partial | Parcial | Exibir pendência; extração incompleta não substitui resultados |
| failed | Falhou | Tentativas esgotadas; solicitar nova tarefa após diagnóstico |
| cancelled | Cancelado | Cancelamento disponível somente antes da execução |

`progress` é um objeto por tipo de tarefa: `stage`, `percent` (Python), `processed`,
`failed`, `requested`, `discovered`, `runId` ou `exportId`, quando disponíveis.
Não presumir porcentagem quando a fonte não informa o total.
Erros usam `{"error":"codigo"}`; 400 entrada inválida, 401 login, 403 permissão,
404 indisponível/não pertence ao usuário, 409 conflito, 429 limite, 503 Storage.

## Limites desta versão

Coletas: até 500 eventos por solicitação do calendário; OpenResults descobre no
máximo 10 páginas/100 metadados por tarefa e extrai uma edição por tarefa.
XLSX até 50 MiB; arquivo maior falha sem apagar resultados. ZIP da aplicação Python
antiga permanece no código de compatibilidade, não é um endpoint da API unificada.
Sem identidade global de atleta, cobrança ou painel. Contratos novos usam a API
unificada; a API FastAPI antiga não deve ser publicada junto desta implantação.

Consulte [VALIDATION.md](VALIDATION.md) para distinguir fixtures e integrações reais.

## Homologação atual

API: `https://universal-race-calendar.onrender.com`. Supabase: `race-platform-staging`, URL pública `https://sggrijhyblejlgimgzzc.supabase.co`. Commit remoto observado em 20/09/2026: `97f27f7c98fe5a01b0fe676302b14cc97f9b3886`. O OpenAPI publicado em `/v1/openapi.json` corresponde ao contrato do repositório.

Login real admin, rejeições 401/403, consulta paginada dos 435 resultados anteriores e exportação pelo runner para bucket privado foram aprovados. A nova coleta foi adquirida pelo runner, mas falhou por bloqueio de acesso à fonte; os dados anteriores permaneceram intactos. O código implantado informa `collection_failed`; a correção proposta distingue `source_access_blocked`, ainda sem deploy. Não apresentar essa tentativa como atualização bem-sucedida. A integração remota é parcial, embora login, consultas e exportação já possam ser construídos e conectados. Evidências e IDs: [STAGING.md](STAGING.md).

Complemento: a tarefa `1acc7940-7868-405a-80bc-e8d3c0e2a00f`, criada pela mesma API hospedada, foi concluída por um worker local com a correção do PR #6. Publicou 435 resultados na primeira tentativa; conteúdo igual, timestamp renovado. Assim, novas coletas funcionaram neste computador, sem validar novamente o GitHub runner bloqueado. O painel pode integrar esse modelo manual; instruções de operação: [LOCAL-WORKERS.md](LOCAL-WORKERS.md). Não é necessário migration ou redeploy da API para o novo código de erro; basta atualizar o worker.

### Informações públicas para entregar à Lovable

- URL base da API acima, URL pública do Supabase e chave **publishable** obtida em Supabase → Project Settings → API Keys desse projeto.
- Este documento, [openapi.json](openapi.json), [STAGING.md](STAGING.md) e Swagger público `https://universal-race-calendar.onrender.com/docs`.
- Implementar login pelo Supabase SDK; enviar o access token na API. Não criar tabelas, workers ou acesso direto ao banco. `SUPABASE_SECRET_KEY`, chaves privilegiadas legadas, URLs do banco, chave interna e tokens GitHub ficam exclusivamente no servidor.

### Criar o administrador e liberar a origem do painel

1. Criar uma identidade própria no Supabase Auth do **staging**, com email/senha cadastrados pelos mecanismos seguros do Supabase. Não reutilizar as identidades temporárias do ensaio: elas foram removidas.
2. Um operador confiável promove esse usuário via Auth Admin, em ambiente de servidor com segredo protegido. Com um cliente administrativo Supabase, usar `auth.admin.updateUserById(userId, { app_metadata: { ...existingAppMetadata, role: 'admin' } })`, preservando outros metadados. Nunca executar esse código ou disponibilizar a chave administrativa no Lovable. [Referência oficial](https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid).
3. Fazer novo login/renovar a sessão depois da promoção. Usuário comum deve continuar recebendo 403 em operações administrativas; `user_metadata` não concede permissão.
4. Em Render → Web Service → Environment, ajustar **CORS_ORIGINS** para a origem HTTPS exata do painel publicado, sem caminho nem barra final. Múltiplas origens explícitas usam vírgula; não usar `*`. Substituir a origem provisória `https://frontend-not-configured.invalid`. Aplicar essa configuração ao serviço quando autorizado; auto deploy permanece desligado.
5. Em Supabase → Authentication → URL Configuration, configurar Site URL e URLs de redirecionamento realmente utilizadas pelo painel (confirmação, recuperação, OAuth se implementado). Isso é separado do CORS da API.

Após existir a URL do painel, validar o preflight a partir dessa origem e fazer login/coleta/exportação conforme a permissão. As chaves públicas não concedem administração por si só.


## API suspensível e execução em lotes

A API responde 202 quando a tarefa foi registrada; isso não significa que já existe executor ativo. Nesta homologação, workers iniciam **manualmente**, no computador ou no GitHub, sem disputar a fila. Agendamentos continuam desativados. Iniciar/encerrar e dependências de cada função: [LOCAL-WORKERS.md](LOCAL-WORKERS.md). Novas exportações exigem o worker Python, mesmo quando os resultados já existem. Não prometer uma próxima execução automática. Para uso operacional fora de desenvolvimento/testes, ver [BATCH-HOSTING.md](BATCH-HOSTING.md).

O estado queued deve aparecer como **Aguardando executor ou nova tentativa**, running como **Em processamento**, partial como **Parcial**, completed como **Concluída**, failed como **Falhou** e cancelled como **Cancelada**. Não inventar um estado scheduled nem ETA exato. Uma tarefa em running pode permanecer assim após interrupção até outra execução recuperar seu lease.

Render Free suspende a API por inatividade: no primeiro acesso pode haver demora de aproximadamente um minuto. Após timeout na criação, repetir a mesma intenção com a **mesma Idempotency-Key**, persistida no cliente até obter a resposta; trocar a chave pode criar outra tarefa. Não implementar dispatch do GitHub pelo navegador e não expor token GitHub ou secrets dos workers.

Enquanto queued, evitar consultas de poucos segundos durante horas: atualizar sob demanda, ao voltar à tela, ou com backoff durante sessão ativa. Quando running, acompanhar a cada 5–10 s e reduzir frequência se não houver mudança; parar ao fechar a tela ou chegar ao estado terminal. Não usar polling/pings para impedir a suspensão do Render.

Mostrar a última atualização dos dados usando resultSet.updatedAt dos resultados e lastUpdatedAt do evento, sem confundir com updatedAt da tarefa. Resultados válidos anteriores continuam disponíveis se uma nova coleta for parcial/falhar. Exportações também aguardam executor; link assinado dura até 60 s, artefato expira em 24 h e limpeza física aguarda lote Python. Solicitar uma nova exportação pode ser necessário se a anterior expirar antes de ser processada. Configuração/agenda, Secrets por serviço e procedimento manual: [BATCH-HOSTING.md](BATCH-HOSTING.md).


## Operação contínua e catálogo administrativo (atualização pendente de publicação)

Consulte [operação pelo painel](PANEL-OPERATIONS.md) para ordem das migrations/deploys, inicializador Windows, limites de cobertura e aceite.

Novos contratos (JWT admin nas rotas administrativas):

| Rota | Uso |
|---|---|
| GET `/v1/executors` | Presença resumida autenticada; sem credenciais ou conteúdo das tarefas |
| GET `/v1/admin/workers` | Diagnóstico administrativo de executores |
| GET/PATCH `/v1/admin/catalog/events[/:id]` | Listar todas as situações/revisar; PATCH exige `reason` |
| GET `/v1/admin/catalog/events/:id/audit` | Histórico de revisão |
| POST `/v1/admin/catalog/events/collect` | `eventIds`, `operation=metadata|results`; uma tarefa por edição |
| GET/POST `/v1/admin/syncs` | Histórico e início com `source`, `states`, `from`, `to`, `batchSize`, `snapshotLimit` |
| POST `/v1/admin/syncs/:id/continue` | Próxima etapa do checkpoint |
| POST `/v1/tasks/:id/retry` | `mode=resume|restart`; nova tarefa preserva histórico |
| POST `/v1/tasks/:id/cancel` | Cancelar somente pendente |
| POST `/v1/admin/source-matches/:id/register` | Edição independente pendente de revisão |
| GET/POST `/v1/exports` | Histórico por usuário/exportação de seleção ou filtro completo |
| GET `/v1/exports/:id` | Estado real e link assinado renovado no clique |

POSTs que criam tarefas/exportações exigem `Idempotency-Key`. Cadastro independente por identidade e cancelamento são idempotentes sem criar trabalho adicional. Não enviar chave interna do Render ao navegador. Exibir `queued` como espera, `running` como processamento e `partial`/`failed` como resultado incompleto/falha; `completed` de uma etapa de catálogo não significa cobertura total. A exportação admite `kind=catalog-simple|catalog-full|results`, `layout=individual|consolidated` e exatamente um de `eventIds` ou `filter`. Paginação de histórico/listas: `page`, `limit` até 100.
