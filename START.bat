@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js не найден: https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
echo  ============================================
echo   Savdo
echo  ============================================
echo   [1] Открыть как ПРИЛОЖЕНИЕ  (рекомендуется)
echo   [2] Только сервер + браузер
echo   [3] Иконка на рабочий стол
echo  ============================================
echo.
choice /C 123 /N /M " Выбор (1/2/3): "
if errorlevel 3 goto shortcut
if errorlevel 2 goto server
if errorlevel 1 goto app

:app
call "%~dp0OPEN-APP.bat"
exit /b 0

:shortcut
call "%~dp0НАСБ-БА-РАБОЧИЙ-СТОЛ.bat"
exit /b 0

:server
echo.
echo  Основная база. Это окно не закрывайте.
echo  http://127.0.0.1:4173/
echo.
start "" "http://127.0.0.1:4173/"
timeout /t 1 /nobreak >nul
node server.mjs
echo.
echo  Сервер остановлен.
pause
