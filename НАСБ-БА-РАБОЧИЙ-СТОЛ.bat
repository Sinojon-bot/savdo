@echo off
chcp 65001 >nul
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$desk=[Environment]::GetFolderPath('Desktop');" ^
  "$dir=Split-Path -Parent '%~f0';" ^
  "$sh=New-Object -ComObject WScript.Shell;" ^
  "$sc=$sh.CreateShortcut((Join-Path $desk 'Savdo.lnk'));" ^
  "$sc.TargetPath=(Join-Path $dir 'OPEN-APP.bat');" ^
  "$sc.WorkingDirectory=$dir;" ^
  "$sc.WindowStyle=7;" ^
  "$icon=Join-Path $dir 'icons\icon-192.png'; if(Test-Path $icon){ $sc.IconLocation=$icon };" ^
  "$sc.Description='Savdo — приложение продаж';" ^
  "$sc.Save();" ^
  "Write-Host ('Готово: ' + (Join-Path $desk 'Savdo.lnk'))"

echo.
echo  На рабочем столе появилась иконка Savdo.
echo  Дважды нажмите — откроется как приложение.
echo.
pause
