param([string]$SelectedTaskFile)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$previousPath=$env:PATH
$previousVersion=$env:WORKER_CODE_VERSION
$previousSelection=$env:WORKER_TASK_SELECTION_FILE
try {
 Push-Location $root
 if($SelectedTaskFile){$env:WORKER_TASK_SELECTION_FILE=(Resolve-Path -LiteralPath $SelectedTaskFile).Path}
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
 & python -c 'import psycopg,httpx,openpyxl,playwright,psutil'
 if($LASTEXITCODE -ne 0){throw 'Instale as dependências de requirements-worker.txt antes de iniciar.'}
 & python -c 'import sys; sys.path.insert(0,"apps/openresults-worker"); from local_resources import inspect_resources; sys.exit(3 if inspect_resources()["reason"] else 0)'
 if($LASTEXITCODE -eq 0){
  & python apps/openresults-worker/browser_smoke.py
  if($LASTEXITCODE -ne 0){throw 'Chromium indisponível. Execute python -m playwright install chromium e tente novamente.'}
 } elseif($LASTEXITCODE -eq 3){
  Write-Host 'Recursos locais insuficientes ou medição indisponível. O teste do Chromium foi adiado; executores aguardarão sem adquirir tarefas.'
 } else {throw 'Confira os limites locais WORKER_MIN_FREE_MEMORY_MB, WORKER_MIN_FREE_TEMP_MB e WORKER_MAX_RSS_MB.'}
 $env:WORKER_CODE_VERSION=(& git rev-parse HEAD)
 & (Join-Path $PSScriptRoot 'with-staging-secrets.ps1') -Action executors -ProjectRef sggrijhyblejlgimgzzc
} finally {
 $env:PATH=$previousPath
 $env:WORKER_CODE_VERSION=$previousVersion
 $env:WORKER_TASK_SELECTION_FILE=$previousSelection
 Pop-Location
}
