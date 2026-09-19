# Integração do futuro painel

O painel não está implementado. O backend é a autoridade de migrations; **não criar
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

Supabase: `race-platform-staging`, URL pública `https://sggrijhyblejlgimgzzc.supabase.co`. Login ES256, permissões, Storage e fluxo real com 435 resultados foram testados. Use a chave publishable desse projeto como configuração pública do cliente. A API foi executada temporariamente em localhost durante o ensaio; ainda não há URL HTTPS pública para a Lovable. Não usar localhost como endereço do painel hospedado.

A construção do painel pode começar pelos contratos. A integração remota exige hospedar a API de staging, preencher sua URL base e configurar CORS para a origem do painel. Banco, fila e Storage já foram preparados. Não criar tabelas pelo Lovable. SUPABASE_SECRET_KEY, chaves privilegiadas legadas, URLs do banco e chaves internas ficam exclusivamente no servidor. Evidências, limitações e próximos acessos: [STAGING.md](STAGING.md).
