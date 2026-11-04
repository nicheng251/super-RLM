@echo off
setlocal
set "DIR=%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" (
    "%ProgramFiles%\nodejs\node.exe" "%DIR%..\src\main.ts" %*
    exit /b %ERRORLEVEL%
  )
  echo node not found; install Node.js ^>= 22.19 >&2
  exit /b 1
)
node "%DIR%..\src\main.ts" %*
