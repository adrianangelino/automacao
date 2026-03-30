# No PowerShell:  powershell -ExecutionPolicy Bypass -File .\start.ps1
# (Se aparecer "execucao desabilitada", rode uma vez:)
# Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
# Alternativas: cmd /c start.cmd   |   .\run-bot.cmd   |   npm run start:win
$nodeHome = Join-Path $env:ProgramFiles 'nodejs'
if (-not (Test-Path (Join-Path $nodeHome 'node.exe'))) {
  $pf86 = [Environment]::GetFolderPath('ProgramFilesX86')
  $nodeHome = Join-Path $pf86 'nodejs'
}
if (-not (Test-Path (Join-Path $nodeHome 'node.exe'))) {
  Write-Error "node.exe nao encontrado. Instale Node.js LTS: https://nodejs.org"
  exit 1
}
$env:Path = "$nodeHome;$env:Path"
Set-Location $PSScriptRoot
& (Join-Path $nodeHome 'npm.cmd') start
