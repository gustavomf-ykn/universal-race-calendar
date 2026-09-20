param(
 [Parameter(Mandatory=$true)][ValidateSet('results','calendar')][string]$Worker,
 [ValidateSet('batch','continuous')][string]$Mode='batch',
 [ValidateRange(1,100)][int]$MaxTasks=1,
 [ValidateRange(1,3600)][int]$MaxSeconds=600
)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$names=@('PATH','WORKER_MODE','WORKER_MAX_TASKS','WORKER_MAX_SECONDS','WORKER_REPORT_PATH')
$previous=@{}
foreach($name in $names){$previous[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
try {
 $pythonScripts=Join-Path (Split-Path -Parent $root) '.venv\Scripts'
 if(Test-Path (Join-Path $pythonScripts 'python.exe')){$env:PATH=$pythonScripts+';'+$env:PATH}
 if(-not (Get-Command node -ErrorAction SilentlyContinue)){throw 'Node.js is required on PATH.'}
 if($Worker -eq 'results' -and -not (Get-Command python -ErrorAction SilentlyContinue)){throw 'Python and worker dependencies are required.'}
 if($Worker -eq 'calendar' -and -not (Test-Path (Join-Path $root 'apps\worker\dist\apps\worker\src\queue.js'))){throw 'Build the TypeScript worker before starting it.'}
 $env:WORKER_MODE=$Mode
 $env:WORKER_MAX_TASKS=[string]$MaxTasks
 $env:WORKER_MAX_SECONDS=[string]$MaxSeconds
 [Environment]::SetEnvironmentVariable('WORKER_REPORT_PATH',$null,'Process')
 Write-Host "Staging worker: $Worker; mode: $Mode. Ctrl+C requests shutdown."
 & (Join-Path $PSScriptRoot 'with-staging-secrets.ps1') -Action $Worker -ProjectRef sggrijhyblejlgimgzzc
} finally {
 foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')}
}
