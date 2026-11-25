# Builds the Windows host. Same arguments as scripts\build-windows.ps1, which does the work.
& (Join-Path $PSScriptRoot "..\..\scripts\build-windows.ps1") @args
exit $LASTEXITCODE
