@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  STRIKE ZONE — demarrage du serveur (HTTP + WebSocket Multi)
echo.

:: Priorite 1 : Node.js (si dispo)
where node >nul 2>&1
if %errorlevel%==0 (
  if not exist "node_modules" (
    echo  Installation des dependances npm...
    npm install
  )
  echo  Serveur Node.js — http://127.0.0.1:8080/
  echo  WebSocket multi sur le meme port
  echo.
  timeout /t 1 /nobreak >nul
  start "" "http://127.0.0.1:8080/"
  node server.js
  goto fin
)

:: Priorite 2 : PowerShell (toujours dispo sur Windows, supporte WebSocket natif)
echo  Node.js non trouve — lancement via PowerShell (multi inclus)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0demarrer-serveur.ps1"

:fin
echo.
echo  Serveur arrete.
pause
