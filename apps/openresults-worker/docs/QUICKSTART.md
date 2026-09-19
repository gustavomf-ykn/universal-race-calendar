# Quickstart para integrações

## 1. Verificar a API

```bash
export API=https://scraper-openresults-gustavomf-ykn.onrender.com
curl --fail "$API/healthz"
curl --fail "$API/api"
```

Em PowerShell:

```powershell
$API = "https://scraper-openresults-gustavomf-ykn.onrender.com"
Invoke-RestMethod "$API/healthz"
```

No plano gratuito, repita o health check após alguns segundos se a instância estiver despertando.

## 2. Criar uma extração

```bash
response=$(curl -sS -X POST "$API/api/results/scrape" \
  -H "Content-Type: application/json" \
  -d '{"scope":{"mode":"single","url":"https://openresults.run/evento/2026-mountain-do-costao-do-santinho-2026/"}}')

echo "$response"
```

Copie o `job_id` retornado.

## 3. Acompanhar

```bash
curl "$API/api/jobs/SEU_JOB_ID"
```

Continue enquanto o estado for `queued` ou `running`.

## 4. Consultar atletas

```bash
curl "$API/api/jobs/SEU_JOB_ID/results?page=1&page_size=25&gender=Feminino"
```

## 5. Baixar

```bash
curl -L -OJ "$API/api/jobs/SEU_JOB_ID/download"
```

Clientes completos estão em `examples/python_client.py` e `examples/javascript_client.mjs`.
