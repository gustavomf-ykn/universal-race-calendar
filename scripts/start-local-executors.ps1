param()
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$previousPath=$env:PATH
$previousVersion=$env:WORKER_CODE_VERSION
try {
 Push-Location $root
 $python=Join-Path (Split-Path -Parent $root) '.venv\Scripts'
 if(Test-Path (Join-Path $python 'python.exe')){$env:PATH=$python+';'+$env:PATH}
 if(-not (Get-Command python -ErrorAction SilentlyContinue)){throw 'Instale Python e as dependências requirements-worker.txt antes de iniciar.'}
 if(-not (Get-Command node -ErrorAction SilentlyContinue)){throw 'Instale Node.js antes de iniciar.'}
 if(-not (Test-Path '.secrets/staging.dpapi.json')){throw 'Cadastre as credenciais protegidas com set-staging-secrets.ps1.'}
 Write-Host 'Preparando os dois executores; nenhuma migration será aplicada.'
 $bundled=Join-Path (Split-Path -Parent $root) '.tooling\node_modules\pnpm\bin\pnpm.cjs'
 if(Test-Path $bundled){& node $bundled --filter @race-calendar/database db:generate}else{& pnpm --filter @race-calendar/database db:generate}
 if($LASTEXITCODE -ne 0){throw "Geração do cliente de banco falhou."}
 if(Test-Path $bundled){& node $bundled -r build}else{& pnpm -r build}
 if($LASTEXITCODE -ne 0){throw 'Build falhou. Os executores não foram iniciados.'}
 & python -c 'import psycopg,httpx,openpyxl,playwright'
 if($LASTEXITCODE -ne 0){throw 'Instale as dependências de requirements-worker.txt antes de iniciar.'}
 & python apps/openresults-worker/browser_smoke.py
 if($LASTEXITCODE -ne 0){throw 'Chromium indisponível. Execute python -m playwright install chromium e tente novamente.'}
 $env:WORKER_CODE_VERSION=(& git rev-parse HEAD)
 & (Join-Path $PSScriptRoot 'with-staging-secrets.ps1') -Action executors -ProjectRef sggrijhyblejlgimgzzc
} finally {
 $env:PATH=$previousPath
 $env:WORKER_CODE_VERSION=$previousVersion
 Pop-Location
}
