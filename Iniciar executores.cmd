@echo off
setlocal
set "PSModulePath=%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local-executors.ps1"
echo.
echo Inicializador encerrado. Confira as mensagens acima.
pause
endlocal
