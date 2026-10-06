@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo  ============================================
echo   Savdo — доступ с телефона ИЗДАЛЕКА
echo  ============================================
echo   1) Сначала запустите START.bat (база)
echo   2) Это окно держите открытым
echo   3) Появится ссылка https://....trycloudflare.com
echo   4) Откройте её на телефоне
echo   5) Войдите тем же email и паролем, что на ПК
echo      = одна база
echo  ============================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0REMOTE.ps1"
echo.
pause
