param([ValidateSet('configure','configure-gui','check','inventory','migrate','audit','frontend-config','api','workers','browser','stop','install-tunnel','tunnel')][string]$Action='check',[string]$Python)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
if(-not $Python) {
 foreach($candidate in @((Join-Path $root '.venv\Scripts\python.exe'),(Join-Path (Split-Path -Parent $root) '.venv\Scripts\python.exe'))) {
  if(Test-Path -LiteralPath $candidate){$Python=$candidate;break}
 }
}
if(-not $Python){$Python='python'}
& $Python -c 'import sys;sys.exit(0 if sys.version_info >= (3,12) else 1)'
if($LASTEXITCODE -ne 0){throw 'Use Python 3.12 ou superior com requirements-worker.txt.'}
& $Python -u (Join-Path $PSScriptRoot 'local-staging.py') $Action
if($LASTEXITCODE -ne 0){throw 'Operação local não concluída. Confira o diagnóstico sanitizado, sem compartilhar credenciais.'}
