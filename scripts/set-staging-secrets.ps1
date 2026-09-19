param([Parameter(Mandatory=$true)][ValidatePattern('^[a-z]{20}$')][string]$ProjectRef)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$secretDir=Join-Path $root '.secrets'
New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls $secretDir /inheritance:r /grant:r "${identity}:(OI)(CI)F" | Out-Null
if($LASTEXITCODE -ne 0){throw 'Could not restrict secret directory permissions'}
$values=@{}
$values.STAGING_PROJECT_NAME='race-platform-staging' | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString
$values.STAGING_PROJECT_REF=$ProjectRef | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString
$values.SUPABASE_URL="https://${ProjectRef}.supabase.co" | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString
$publicConfigPath=Join-Path $secretDir 'staging-public.json'
if(Test-Path -LiteralPath $publicConfigPath){
 $publicConfig=Get-Content -Raw -LiteralPath $publicConfigPath | ConvertFrom-Json
 if($publicConfig.projectRef -ne $ProjectRef){throw 'Public staging project identity does not match'}
 $values.SUPABASE_PUBLISHABLE_KEY=$publicConfig.publishableKey | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString
} else {
 $values.SUPABASE_PUBLISHABLE_KEY=(Read-Host 'Enter staging publishable key' -AsSecureString) | ConvertFrom-SecureString
}
foreach($name in @('DATABASE_URL','DIRECT_URL','WORKER_DATABASE_URL','SUPABASE_SECRET_KEY')) {
  $value=Read-Host "Enter staging $name (hidden; stored encrypted for this Windows user)" -AsSecureString
  $values[$name]=$value | ConvertFrom-SecureString
}
$bytes=New-Object byte[] 32
$rng=[System.Security.Cryptography.RandomNumberGenerator]::Create();$rng.GetBytes($bytes);$rng.Dispose()
$key=[Convert]::ToBase64String($bytes)
$values.INTERNAL_API_KEY=$key | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString
$values | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $secretDir 'staging.dpapi.json')
Write-Output 'Staging secrets encrypted with Windows DPAPI. Values were not displayed.'
