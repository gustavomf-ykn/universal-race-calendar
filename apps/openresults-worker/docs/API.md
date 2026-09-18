# Referência da API

Esta referência descreve a API HTTP v2 do `scraper-openresults`. O contrato executável também está disponível em:

- `GET /docs` — Swagger UI;
- `GET /redoc` — ReDoc;
- `GET /openapi.json` — OpenAPI 3.1;
- `GET /api` — versão e links da instalação atual.

Base pública mantida pelo projeto:

```text
https://scraper-openresults-gustavomf-ykn.onrender.com
```

Substitua essa origem pela URL da sua instalação. Todas as respostas JSON usam UTF-8. Datas são `YYYY-MM-DD`; timestamps são ISO 8601 em UTC.

## Autenticação e acesso

A configuração padrão não exige autenticação. Isso permite frontend e clientes de terceiros, mas significa que qualquer pessoa pode criar trabalhos até os limites configurados. Para uma instalação privada, adicione autenticação no proxy reverso ou em um middleware próprio.

CORS não é autenticação. Ele restringe navegadores, mas não impede cURL, scripts ou servidores de chamar a API.

## Rate limiting e capacidade

As rotas que criam ou retomam trabalhos podem retornar `429 Too Many Requests`.

```http
Retry-After: 60
```

Há dois limites independentes:

- solicitações por IP dentro de uma janela;
- trabalhos pendentes/retidos na instância.

O rate limiting é local ao processo. Para múltiplas réplicas, use um limitador compartilhado no proxy ou substitua a implementação.

## Trabalhos assíncronos

Operações de scraping retornam `202 Accepted`:

```json
{
  "job_id": "6ad486c8-3f01-45d3-b3ed-42fe06504ce2",
  "status": "queued",
  "status_url": "/api/jobs/6ad486c8-3f01-45d3-b3ed-42fe06504ce2"
}
```

Consulte `status_url` até chegar a um estado final. Intervalo recomendado: 1–3 segundos, com backoff para clientes de grande volume.

| Estado | Significado |
|---|---|
| `queued` | Aguardando o semáforo global |
| `running` | Em processamento |
| `interrupted` | O processo reiniciou; resultados podem ser retomados |
| `completed` | Concluído sem avisos |
| `completed_with_warnings` | Concluído ou parcialmente concluído com dados aproveitáveis |
| `failed` | Falha sem conclusão utilizável |

Trabalhos e arquivos expiram conforme `OPENRESULTS_JOB_TTL`, por padrão uma hora. O SQLite preserva checkpoints enquanto o arquivo do banco existir.

## Objeto `scope`

As rotas de metadados e resultados usam um escopo explícito.

### Uma prova

```json
{
  "mode": "single",
  "url": "https://openresults.run/evento/2026-mountain-do-costao-do-santinho-2026/"
}
```

### Provas selecionadas

É possível combinar IDs internos e URLs canônicas:

```json
{
  "mode": "selected",
  "event_ids": ["37007"],
  "event_urls": [
    "https://openresults.run/evento/outra-prova/"
  ]
}
```

### Todas em um período

```json
{
  "mode": "all",
  "date_from": "2025-01-01",
  "date_to": "2026-12-31"
}
```

`date_to` é opcional. Para resultados, `mode=all` exige `confirm_all=true` no objeto externo.

## Sistema

### `GET /healthz`

Health check sem acesso ao Open Results ou execução de scraping.

```json
{"status":"ok"}
```

### `GET /api`

Identifica a instalação e retorna URLs absolutas da documentação.

```json
{
  "name": "scraper-openresults",
  "version": "2.0.0",
  "license": "MIT",
  "documentation": "https://api.example.com/docs",
  "redoc": "https://api.example.com/redoc",
  "openapi": "https://api.example.com/openapi.json",
  "health": "https://api.example.com/healthz"
}
```

## Catálogo de provas

### `POST /api/events/discover`

Percorre o catálogo global, persiste provas no SQLite e tenta resolver IDs/metadados com concorrência limitada.

```bash
curl -X POST "$API/api/events/discover" \
  -H "Content-Type: application/json" \
  -d '{"date_from":"2025-01-01","date_to":null}'
```

Corpo:

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---:|---|
| `date_from` | `date \| null` | não | Usa `EVENTS_MIN_DATE` quando ausente |
| `date_to` | `date \| null` | não | Limite inclusivo superior |

Retorna um trabalho do tipo `catalog`.

### `GET /api/events`

Lista o catálogo local.

| Query | Tipo | Padrão | Limites |
|---|---|---|---|
| `page` | inteiro | `1` | mínimo 1 |
| `limit` | inteiro | `50` | 1–200 |
| `date_from` | data | vazio | inclusivo |
| `date_to` | data | vazio | inclusivo |
| `search` | texto | vazio | nome, ID ou slug; máximo 200 |
| `state` | texto | vazio | UF com 2 caracteres |
| `id_status` | texto | vazio | `pending`, `resolved`, `unavailable` ou `error` |

Resposta:

```json
{
  "items": [
    {
      "catalog_id": 42,
      "event_id": "37007",
      "event_slug": "2026-mountain-do-costao-do-santinho-2026",
      "event_url": "https://openresults.run/evento/2026-mountain-do-costao-do-santinho-2026/",
      "name": "MOUNTAIN DO COSTÃO DO SANTINHO 2026",
      "start_date": "2026-07-25",
      "end_date": null,
      "city": "Florianópolis",
      "state": "SC",
      "country": "BR",
      "expected_total": 435,
      "modalities": [],
      "id_status": "resolved",
      "metadata_status": "completed",
      "discovered_at": "2026-08-10T12:00:00+00:00",
      "updated_at": "2026-08-10T12:00:05+00:00",
      "metadata_fetched_at": "2026-08-10T12:00:05+00:00"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 50
}
```

`event_id` pode ser `null` quando a prova ainda não publicou resultados. Use `catalog_id` para consultar esses eventos.

### `GET /api/events/{event_id}`

Retorna uma prova pelo ID interno do Open Results. Responde `404` se o ID não existir no catálogo local.

### `GET /api/catalog/events/{catalog_id}`

Retorna uma prova pelo identificador local SQLite. É a rota indicada para provas sem `event_id`.

O detalhe pode incluir:

- datas, cidade, UF, país, endereço e coordenadas;
- descrição, imagem e status de origem/derivado;
- modalidades, totais, melhores tempos e tempos médios quando disponíveis;
- links oficiais, inscrição e página relacionada;
- IDs externos;
- metadados brutos sanitizados, sem atletas.

### `POST /api/events/metadata`

Atualiza metadados para um escopo.

```json
{
  "scope": {
    "mode": "selected",
    "event_ids": ["37007"]
  },
  "enrich_roadrunners": false
}
```

`enrich_roadrunners=true` habilita uma consulta opcional ao host exato `roadrunners.run`. O cache padrão é de sete dias.

### `GET /api/events/export/simple`

Gera `openresults_provas.xlsx`, aba `Provas`, com exatamente:

```text
id | nome
```

Aceita `date_from` e `date_to`. IDs indisponíveis são células vazias.

### `GET /api/events/export/full`

Gera `openresults_provas_completas.xlsx`, uma linha por prova. Aceita os mesmos filtros de data.

## Resultados

### `POST /api/results/scrape`

Cria um trabalho de resultados.

Uma prova:

```bash
curl -X POST "$API/api/results/scrape" \
  -H "Content-Type: application/json" \
  -d '{
    "scope": {
      "mode": "single",
      "url": "https://openresults.run/evento/2026-mountain-do-costao-do-santinho-2026/"
    },
    "confirm_all": false
  }'
```

Todas as provas:

```json
{
  "scope": {
    "mode": "all",
    "date_from": "2025-01-01"
  },
  "confirm_all": true
}
```

Para cada prova, a API processa modalidades × gêneros e persiste cada página antes de avançar. Provas sem `id_evento` são ignoradas com aviso, sem invalidar as demais.

### `POST /api/scrape` — legado

Rota de compatibilidade para uma URL:

```json
{"url":"https://openresults.run/evento/nome-da-prova/"}
```

Está marcada como descontinuada no OpenAPI. Novas integrações devem usar `/api/results/scrape`.

## Trabalhos

### `GET /api/jobs/{job_id}`

Resposta típica de resultados:

```json
{
  "job_id": "6ad486c8-3f01-45d3-b3ed-42fe06504ce2",
  "job_type": "results",
  "scope": {"mode":"single","event_urls":["https://openresults.run/evento/exemplo/"]},
  "status": "running",
  "stage": "Extraído 5k feminino",
  "progress": 42,
  "created_at": "2026-08-10T12:00:00+00:00",
  "updated_at": "2026-08-10T12:00:12+00:00",
  "expires_at": null,
  "current_event": "Evento exemplo",
  "current_modality": null,
  "current_gender": null,
  "counters": {
    "events_total": 1,
    "events_completed": 0,
    "events_failed": 0,
    "events_skipped": 0,
    "athletes_extracted": 200
  },
  "warnings": [],
  "error": null,
  "download_ready": false,
  "total_extracted": 200,
  "by_gender": {"Feminino":100,"Masculino":100},
  "by_group": {"5k | Feminino":100,"5k | Masculino":100}
}
```

Campos podem ser vazios dependendo do tipo e etapa do trabalho. `error` contém somente uma mensagem sanitizada.

### `GET /api/jobs/{job_id}/events`

Lista o estado de cada prova de um trabalho multi-evento:

```json
{
  "items": [
    {
      "job_id": "...",
      "catalog_id": 42,
      "event_id": "37007",
      "event_name": "Evento",
      "event_url": "https://openresults.run/evento/evento/",
      "event_date": "2026-07-25",
      "status": "completed",
      "groups_total": 8,
      "groups_completed": 8,
      "athletes_extracted": 435,
      "error": null,
      "started_at": "...",
      "completed_at": "..."
    }
  ],
  "total": 1
}
```

Estados de prova: `pending`, `processing`, `partial`, `completed`, `no_results` e `skipped`.

### `POST /api/jobs/{job_id}/resume`

Retoma um trabalho `results` em `interrupted`, `failed` ou `completed_with_warnings`. Grupos concluídos são ignorados; grupos parciais continuam do `next_offset` persistido.

Possíveis respostas:

- `202` — retomada aceita;
- `404` — trabalho não encontrado/expirado;
- `409` — tipo ou estado não retomável;
- `429` — limite de criação por IP.

### `GET /api/jobs/{job_id}/results`

Disponível após um estado final.

| Query | Tipo | Padrão | Descrição |
|---|---|---|---|
| `page` | inteiro | `1` | página, mínimo 1 |
| `page_size` | inteiro | `25` | 1–200 |
| `search` | texto | vazio | nome, número ou equipe |
| `event_id` | texto | vazio | ID da prova |
| `gender` | texto | vazio | `Feminino` ou `Masculino` |
| `modality` | texto | vazio | nome exato |
| `category` | texto | vazio | código exato, como `F1829` |
| `sort_by` | texto | `distance_km` | coluna permitida |
| `sort_dir` | texto | `asc` | `asc` ou `desc` |

Colunas ordenáveis: `event_id`, `event`, `event_date`, `city`, `state`, `modality`, `distance_km`, `gender`, `overall_position`, `category_position`, `category`, `bib`, `name`, `team`, `pace`, `time`, `gap`, `source_url` e `extracted_at`.

Resposta:

```json
{
  "items": [{"event_id":"37007","name":"ATLETA","bib":"007"}],
  "page": 1,
  "page_size": 25,
  "total": 435,
  "filtered_total": 1,
  "facets": {
    "genders": ["Feminino","Masculino"],
    "modalities": ["5k","9k","21k","42k"],
    "categories": ["F1829"],
    "events": ["37007"]
  }
}
```

### `GET /api/jobs/{job_id}/download`

Retorna:

- XLSX com uma aba `Resultados`; ou
- ZIP com partes XLSX quando a base ultrapassa o limite de linhas.

Use o nome fornecido em `Content-Disposition`. Responde `409` quando o arquivo ainda não está pronto ou quando o trabalho terminou sem atletas.

## Erros

Formato padrão:

```json
{"detail":"Mensagem segura para o cliente."}
```

| Status | Uso |
|---|---|
| `400` | URL/escopo inválido |
| `404` | prova ou trabalho inexistente/expirado |
| `409` | operação incompatível com o estado atual |
| `422` | corpo ou query não atende ao schema Pydantic |
| `429` | rate limit ou capacidade esgotada |
| `500` | erro interno inesperado |

Erros individuais de provas em um trabalho multi-evento normalmente aparecem em `warnings` e em `/events`, permitindo download parcial.

## Garantias e limitações

- A API depende da estrutura pública do Open Results e pode precisar de atualização quando o site mudar.
- Não há garantia de disponibilidade ou estabilidade dos dados de origem.
- IDs vazios são válidos para provas ainda sem resultados.
- O armazenamento padrão é SQLite e pode ser efêmero conforme o provedor.
- Use um único processo Uvicorn. Para escala horizontal, implemente fila, rate limiter e banco compartilhados.
- O uso e a redistribuição do software são regidos pela licença MIT; o operador continua responsável por termos do site de origem e legislação aplicável.
