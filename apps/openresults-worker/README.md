# scraper-openresults

Aplicação FastAPI para descobrir provas públicas do [Open Results](https://openresults.run/), normalizar seus metadados e exportar resultados completos por prova, seleção ou período.

## Acesso público

- Frontend: [GitHub Pages](https://gustavomf-ykn.github.io/scraper-openresults/) [EM BREVE]
- API e interface integrada: [Render](https://scraper-openresults.onrender.com)
- Health check: [GET /healthz]((https://scraper-openresults.onrender.com)/healthz)

O GitHub Pages serve apenas HTML, CSS e JavaScript. O Render executa Python, scraping, SQLite e geração de arquivos. No plano gratuito, o serviço pode hibernar após 15 minutos sem tráfego; a primeira chamada pode demorar cerca de um minuto. O disco do serviço gratuito é efêmero, portanto uma reinicialização pode apagar catálogo, checkpoints e arquivos.

## Documentação para desenvolvedores

- [Quickstart de integração](docs/QUICKSTART.md)
- [Referência completa da API](docs/API.md)
- [Hospedagem e configuração de produção](docs/DEPLOYMENT.md)
- [Exemplo Python](examples/python_client.py)
- [Exemplo JavaScript/Node.js](examples/javascript_client.mjs)
- [Política de segurança](SECURITY.md)
- [Como contribuir](CONTRIBUTING.md)

Uma instância em execução oferece Swagger em `/docs`, ReDoc em `/redoc`, contrato OpenAPI em `/openapi.json` e informações da instalação em `/api`.

## Funcionalidades

- Descoberta global e paginada pelo endpoint `/api/eventos.cfm`, com corte padrão em `2025-01-01`.
- Catálogo pesquisável por data, nome, UF e situação do ID.
- Resolução do `id_evento` real exclusivamente pelo `data-remote-url` de `/ajax_resultados_evento.cfm`.
- Metadados Open Results normalizados e enriquecimento RoadRunners opcional, desativado por padrão.
- Escopo de resultados estrito: todas as provas, seleção explícita ou uma URL.
- Paginação de atletas em blocos de 100 para cada modalidade × gênero.
- Checkpoint SQLite por prova, modalidade, gênero e `nextOffset`, com retomada via API.
- Resultados pesquisáveis e filtráveis sem carregar toda a base em RAM.
- Excel simples de provas com exatamente `id` e `nome`; IDs ainda não publicados permanecem vazios.
- Excel completo com uma linha por prova.
- Excel de resultados com `event_id` como primeira coluna. Bases maiores que 1.048.575 linhas são divididas em arquivos dentro de um ZIP.
- Fallback Playwright quando o endpoint não aparece no HTML estático.

O scraper não tenta contornar CAPTCHA, autenticação ou bloqueios. Dados de atletas são gravados somente na tabela de resultados e não são adicionados à API de provas, aos metadados brutos ou aos logs.

## Arquitetura

```text
GitHub Pages (frontend estático)
        │ HTTPS + CORS restrito
        ▼
FastAPI / Render (um processo Uvicorn)
        ├── EventCatalog ─────── /api/eventos.cfm
        ├── EventMetadataService ─ páginas /evento/<slug>/
        ├── ResultsScraper ───── /ajax_resultados_evento.cfm
        ├── Playwright ───────── fallback de descoberta/DOM
        └── SQLite ───────────── catálogo, trabalhos, grupos e atletas
```

`app/storage.py` concentra a interface de persistência para permitir a troca futura por PostgreSQL/Supabase sem misturar SQL nos parsers.

## Instalação local

Requer Python 3.12 ou superior.

Windows PowerShell:

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
playwright install chromium
uvicorn app.main:app --reload
```

Linux/macOS:

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
playwright install chromium
uvicorn app.main:app --reload
```

Abra `http://127.0.0.1:8000`. O Chromium é necessário somente no fallback. Execute um único worker Uvicorn: trabalhos em execução e semáforos são coordenados pelo processo local, embora checkpoints e dados estejam no SQLite.

## Fluxo de uso

1. Na aba **Provas**, informe o período e clique em **Atualizar catálogo**.
2. Pesquise e marque provas. Se necessário, atualize seus metadados.
3. Baixe o Excel simples/completo ou vá à aba **Resultados**.
4. Escolha uma URL, as provas selecionadas ou todas no período. O escopo `all` exige confirmação explícita.
5. Acompanhe o trabalho, consulte os avisos e baixe XLSX/ZIP.
6. Um trabalho interrompido pode ser retomado sem repetir grupos concluídos.

## API

| Método | Rota | Função |
|---|---|---|
| `GET` | `/` | Interface integrada |
| `GET` | `/healthz` | Saúde sem iniciar scraping |
| `POST` | `/api/events/discover` | Descobre e atualiza o catálogo |
| `GET` | `/api/events` | Lista provas com filtros e paginação |
| `GET` | `/api/events/{event_id}` | Detalhe pelo ID interno |
| `GET` | `/api/catalog/events/{catalog_id}` | Detalhe inclusive quando o ID está vazio |
| `POST` | `/api/events/metadata` | Atualiza metadados para um escopo |
| `GET` | `/api/events/export/simple` | `openresults_provas.xlsx` |
| `GET` | `/api/events/export/full` | `openresults_provas_completas.xlsx` |
| `POST` | `/api/results/scrape` | Extrai atletas para um escopo |
| `POST` | `/api/scrape` | Rota compatível para uma única URL |
| `GET` | `/api/jobs/{job_id}` | Estado, etapa, contadores e avisos |
| `GET` | `/api/jobs/{job_id}/events` | Situação de cada prova do trabalho |
| `POST` | `/api/jobs/{job_id}/resume` | Retoma resultados parciais |
| `GET` | `/api/jobs/{job_id}/results` | Pesquisa, filtros, ordenação e paginação |
| `GET` | `/api/jobs/{job_id}/download` | XLSX ou ZIP final |

Exemplo de uma prova:

```json
{
  "scope": {
    "mode": "single",
    "url": "https://openresults.run/evento/2026-mountain-do-costao-do-santinho-2026/"
  }
}
```

Exemplo de todas as provas desde 2025:

```json
{
  "scope": {"mode": "all", "date_from": "2025-01-01"},
  "confirm_all": true
}
```

Estados finais: `completed`, `completed_with_warnings` e `failed`. Após reinicialização, trabalhos que estavam `running` passam a `interrupted` e podem ser retomados. Trabalhos concluídos expiram em uma hora.

## Endpoint de resultados

A página da prova contém `#tableResultados[data-remote-url]`, por exemplo:

```text
/ajax_resultados_evento.cfm?id_evento=37007&modalidade=5k&genero=F
```

A resposta combina JSON e linhas HTML:

```json
{
  "ok": true,
  "recordsTotal": 52,
  "recordsFiltered": 52,
  "nextOffset": 52,
  "hasMore": false,
  "html": "<tr>...</tr>"
}
```

Os totais da página, do endpoint e da base persistida são comparados. Divergências geram avisos e não bloqueiam o download parcial. `Cat.` é exportado como `Categoria` (por exemplo, `F1829`); `Posição na categoria` fica vazia quando não é fornecida.

## Excel

Todos os workbooks possuem uma única aba (`Provas` ou `Resultados`), tabela oficial do Excel, filtros, cabeçalho congelado e larguras ajustadas. Números de peito são texto; valores ausentes permanecem vazios. O Excel simples é ordenado pela data do evento, embora a data não faça parte de suas duas colunas.

## Testes

Determinísticos, sem internet:

```bash
pytest -m "not integration" -q
```

Teste live opcional da prova Mountain do Costão (4 modalidades, 8 grupos, 435 atletas):

```powershell
$env:RUN_OPENRESULTS_INTEGRATION="1"
pytest -m integration -vv
```

No Linux/macOS, prefixe o comando com `RUN_OPENRESULTS_INTEGRATION=1`. O teste live pode falhar legitimamente se o site alterar os totais.

## Configuração

Consulte `.env.example`. As opções principais são:

- `EVENTS_MIN_DATE`: corte padrão do catálogo;
- `OPENRESULTS_DATABASE_PATH`: arquivo SQLite;
- `OPENRESULTS_CATALOG_CONCURRENCY`, `OPENRESULTS_METADATA_CONCURRENCY` e `OPENRESULTS_CONCURRENCY`;
- `OPENRESULTS_TIMEOUT`, `OPENRESULTS_RETRIES` e `OPENRESULTS_MAX_REDIRECTS`;
- `OPENRESULTS_RESULTS_ROWS_PER_WORKBOOK`;
- `OPENRESULTS_MAX_JOBS`, `OPENRESULTS_MAX_QUEUED_JOBS` e rate limiting;
- `OPENRESULTS_ALLOWED_ORIGINS`.

## Segurança

URLs fornecidas pelo usuário exigem HTTPS, host exato `openresults.run`, porta padrão e caminho `/evento/<slug>/`. IPs, credenciais, subdomínios, path traversal e redirecionamentos externos são rejeitados. Links opcionais RoadRunners recebem a mesma validação com host exato. Erros retornados pela API são sanitizados; tracebacks ficam nos logs.

## Deploy

O workflow de CI usa Python 3.12. O workflow Pages gera o frontend a partir do mesmo template da aplicação e injeta a URL pública da API. Em **Settings → Pages → Source**, selecione **GitHub Actions**.

O `render.yaml` cria um Web Service Docker gratuito com health check em `/healthz`, Chromium instalado pela imagem Playwright, um processo Uvicorn e diretório temporário `/tmp/scraper-openresults`.

Para criar ou recriar o serviço:

1. abra `https://render.com/deploy?repo=https://github.com/gustavomf-ykn/scraper-openresults`;
2. conecte o GitHub e confirme o Blueprint gratuito;
3. aguarde `/healthz` responder;
4. se o Render fornecer outro hostname, atualize o meta `api-base` no workflow Pages e a origem CORS.

Pushes posteriores em `main` acionam CI, Pages e auto-deploy do Render.

## Licença

Distribuído sob a [licença MIT](LICENSE). É permitido usar, copiar, modificar, publicar, hospedar, sublicenciar e redistribuir o software, preservando o aviso de licença. O operador continua responsável pelo uso dos dados e pelos termos dos serviços de origem.
