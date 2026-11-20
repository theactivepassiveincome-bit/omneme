@echo off
rem Omneme first-run launcher. Double-click to start the local web UI (127.0.0.1 only).
rem Passwords are typed in the browser only, never here. Closing this window stops Omneme and locks the vault.
setlocal
title Omneme
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.18 or newer is required. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
node "%~dp0..\bin\omneme-start.mjs" %*
echo.
echo Omneme has stopped.
pause
