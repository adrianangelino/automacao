@echo off
cd /d "%~dp0"
set "NODEHOME=%ProgramFiles%\nodejs"
if not exist "%NODEHOME%\node.exe" set "NODEHOME=%ProgramFiles(x86)%\nodejs"
if not exist "%NODEHOME%\node.exe" (
  echo [ERRO] node.exe nao encontrado. Instale Node.js LTS: https://nodejs.org
  exit /b 1
)
set "PATH=%NODEHOME%;%PATH%"
call "%NODEHOME%\npm.cmd" start
