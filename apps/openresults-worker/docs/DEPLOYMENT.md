# Guia de hospedagem

O projeto pode ser hospedado livremente sob a licença MIT. A topologia recomendada para a implementação atual é uma instância persistente com um processo Uvicorn e um volume gravável.

## Requisitos de produção

- Python 3.12+
- saída HTTPS para `openresults.run` e, opcionalmente, `roadrunners.run`
- diretório gravável para SQLite e arquivos temporários
- Chromium/Playwright somente para fallback
- proxy com HTTPS, limites de corpo e timeout adequado

Não use múltiplos workers ou réplicas sem substituir o coordenador em memória, o rate limiter e o SQLite por componentes compartilhados.

## Docker

```bash
docker build -t scraper-openresults:latest .

docker volume create scraper-openresults-data

docker run -d \
  --name scraper-openresults \
  --restart unless-stopped \
  -p 8000:8000 \
  -e PORT=8000 \
  -e OPENRESULTS_DATABASE_PATH=/data/scraper-openresults.sqlite3 \
  -e OPENRESULTS_TEMP_DIR=/data/files \
  -e OPENRESULTS_ALLOWED_ORIGINS=https://frontend.example.com \
  -v scraper-openresults-data:/data \
  scraper-openresults:latest
```

Valide:

```bash
curl --fail http://127.0.0.1:8000/healthz
curl http://127.0.0.1:8000/api
```

## Docker Compose

O arquivo `compose.yaml` incluído usa um volume persistente:

```bash
docker compose up -d --build
docker compose logs -f api
```

Configure origens e limites em um arquivo `.env` antes de expor o serviço.

## Python/Uvicorn sem Docker

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
playwright install --with-deps chromium

export OPENRESULTS_DATABASE_PATH=/var/lib/scraper-openresults/state.sqlite3
export OPENRESULTS_TEMP_DIR=/var/lib/scraper-openresults/files
export OPENRESULTS_ALLOWED_ORIGINS=https://frontend.example.com

uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
```

Crie o diretório persistente e conceda acesso somente ao usuário do serviço. Use systemd, supervisord ou o gerenciador equivalente para reiniciar o processo.

## Proxy reverso

Exemplo Nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name api.example.com;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 120s;
        client_max_body_size 1m;
    }
}
```

Ative `OPENRESULTS_TRUST_PROXY_HEADERS=1` somente quando o proxy substituir — e não apenas acrescentar — `X-Forwarded-For`. Caso contrário, clientes podem falsificar o IP usado pelo rate limiting.

## Render

`render.yaml` cria a API Docker com health check e um processo. No plano gratuito:

- o serviço pode hibernar;
- o filesystem é efêmero;
- reinicializações podem apagar SQLite, trabalhos e arquivos.

Para retenção real, escolha um plano com disco persistente, monte-o (por exemplo em `/var/data`) e configure:

```text
OPENRESULTS_DATABASE_PATH=/var/data/scraper-openresults.sqlite3
OPENRESULTS_TEMP_DIR=/var/data/files
```

O frontend GitHub Pages pode continuar apontando para a nova API pelo meta `api-base`.

## Outros provedores

Railway, Fly.io, VPS, Kubernetes e plataformas compatíveis com Docker funcionam desde que respeitem:

1. um único processo consumidor;
2. volume persistente compartilhado com esse processo;
3. health check em `/healthz`;
4. timeout do proxy maior que o tempo de cold start;
5. `PORT` fornecido pelo provedor;
6. CORS configurado com as origens exatas do frontend.

Funções serverless não são adequadas sem refatorar estado, fila e arquivos para serviços externos.

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `EVENTS_MIN_DATE` | `2025-01-01` | corte padrão do catálogo |
| `OPENRESULTS_DATABASE_PATH` | diretório temporário | arquivo SQLite |
| `OPENRESULTS_TEMP_DIR` | diretório temporário | arquivos de download |
| `OPENRESULTS_TIMEOUT` | `20` | timeout HTTP em segundos |
| `OPENRESULTS_RETRIES` | `3` | tentativas transitórias |
| `OPENRESULTS_MAX_REDIRECTS` | `3` | redirecionamentos seguros |
| `OPENRESULTS_CONCURRENCY` | `3` | grupos de resultados simultâneos |
| `OPENRESULTS_CATALOG_CONCURRENCY` | `3` | resolução do catálogo |
| `OPENRESULTS_METADATA_CONCURRENCY` | `3` | leituras de metadados |
| `OPENRESULTS_METADATA_TTL` | `604800` | cache em segundos |
| `OPENRESULTS_CATALOG_MAX_PAGES` | `1000` | limite de páginas do catálogo |
| `OPENRESULTS_PAGE_SIZE` | `100` | atletas por requisição |
| `OPENRESULTS_RESULTS_ROWS_PER_WORKBOOK` | `1048575` | linhas por parte XLSX |
| `OPENRESULTS_JOB_TTL` | `3600` | retenção após conclusão |
| `OPENRESULTS_CLEANUP_INTERVAL` | `60` | intervalo de limpeza |
| `OPENRESULTS_MAX_JOBS` | `2` | trabalhos simultâneos |
| `OPENRESULTS_MAX_QUEUED_JOBS` | `20` | fila máxima |
| `OPENRESULTS_MAX_RETAINED_JOBS` | `100` | trabalhos retidos |
| `OPENRESULTS_RATE_LIMIT_REQUESTS` | `5` | criações por janela/IP |
| `OPENRESULTS_RATE_LIMIT_WINDOW` | `600` | janela em segundos |
| `OPENRESULTS_ALLOWED_ORIGINS` | Pages + localhost | origens CORS separadas por vírgula |
| `OPENRESULTS_TRUST_PROXY_HEADERS` | `0` | confiar no primeiro `X-Forwarded-For` |
| `OPENRESULTS_USER_AGENT` | identificador do projeto | User-Agent de saída |
| `OPENRESULTS_DEBUG` | `0` | logs de debug |

## Backup e atualização

Com o processo parado ou usando uma ferramenta compatível com WAL, copie:

- arquivo SQLite;
- diretório de downloads, se trabalhos em andamento precisarem sobreviver.

Antes de atualizar:

1. faça backup;
2. construa a nova imagem;
3. pare a instância antiga;
4. inicie a nova versão apontando para o mesmo volume;
5. consulte `/healthz`, `/api` e `/api/events`.

Migrações atuais são aditivas e executadas na inicialização. Não faça downgrade sobre o único backup.

## Hardening

- limite acesso à API ou adicione autenticação quando apropriado;
- mantenha CORS com origens exatas;
- aplique rate limiting também no proxy para instalações públicas;
- use HTTPS;
- monitore espaço do SQLite e dos arquivos;
- não registre corpos de resultados ou nomes de atletas;
- atualize dependências e a imagem Playwright regularmente;
- leia `SECURITY.md` antes de abrir a instalação ao público.
