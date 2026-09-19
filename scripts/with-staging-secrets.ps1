param([ValidateSet('check','migrate','audit','auth','flow','corridasbr','recovery','api','calendar','results')][string]$Action='check',[Parameter(Mandatory=$true)][ValidatePattern('^[a-z]{20}$')][string]$ProjectRef)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$config=Get-Content -Raw -LiteralPath (Join-Path $root '.secrets/staging.dpapi.json') | ConvertFrom-Json
$previous=@{}
try {
 foreach($property in $config.PSObject.Properties){
  $previous[$property.Name]=[Environment]::GetEnvironmentVariable($property.Name,'Process')
  $secret=$property.Value | ConvertTo-SecureString
  $plain=[System.Net.NetworkCredential]::new('', $secret).Password
  [Environment]::SetEnvironmentVariable($property.Name,$plain,'Process')
 }
 Push-Location $root
 & node scripts/staging-preflight.mjs check $ProjectRef
 if($LASTEXITCODE -ne 0){throw 'Staging identity validation failed'}
 switch($Action){
  'migrate' { & node scripts/staging-preflight.mjs migrate $ProjectRef }
  'audit' { & python scripts/staging-audit.py $ProjectRef }
  'auth' { & python scripts/staging-auth-smoke.py }
  'flow' { & python scripts/staging-real-flow.py }
  'corridasbr' { & python scripts/staging-real-flow.py --corridasbr }
  'recovery' { & python scripts/staging-recovery.py }
  'api' { & node apps/api/dist/apps/api/src/server.js }
  'calendar' { & node apps/worker/dist/apps/worker/src/queue.js }
  'results' { Push-Location apps/openresults-worker;try { & python -m worker } finally {Pop-Location} }
 }
 if($LASTEXITCODE -ne 0){throw 'Staging operation failed; inspect sanitized operation status'}
} finally {
 foreach($name in $previous.Keys){[Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')}
 if((Get-Location).Path -eq $root){Pop-Location}
}
