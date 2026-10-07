@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;%ProgramFiles(x86)%\Microsoft\Edge\Application;%ProgramFiles%\Microsoft\Edge\Application;%ProgramFiles%\Google\Chrome\Application;%ProgramFiles(x86)%\Google\Chrome\Application;%PATH%"
set "URL=http://127.0.0.1:4173/"

where node >nul 2>nul
if errorlevel 1 (
  echo Нужен Node.js: https://nodejs.org
  pause
  exit /b 1
)

:: Если сервер не отвечает — запустить в фоне
powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri '%URL%' -UseBasicParsing -TimeoutSec 1).StatusCode } catch { exit 1 }" >nul 2>nul
if errorlevel 1 (
  echo Сервер запускается...
  start "Savdo Hub" /MIN cmd /c "cd /d \"%~dp0\" && node server.mjs"
  timeout /t 2 /nobreak >nul
)

set "BROWSER="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

if defined BROWSER (
  start "" "%BROWSER%" --app=%URL% --new-window
) else (
  start "" "%URL%"
)
exit /b 0
