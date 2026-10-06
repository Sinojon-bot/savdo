$desk = [Environment]::GetFolderPath('Desktop')
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sh = New-Object -ComObject WScript.Shell
$sc = $sh.CreateShortcut((Join-Path $desk 'Savdo.lnk'))
$sc.TargetPath = Join-Path $dir 'OPEN-APP.bat'
$sc.WorkingDirectory = $dir
$sc.WindowStyle = 7
$icon = Join-Path $dir 'icons\icon-192.png'
if (Test-Path $icon) { $sc.IconLocation = $icon }
$sc.Description = 'Savdo — барномаи савдо'
$sc.Save()
Write-Host ("OK: " + (Join-Path $desk 'Savdo.lnk'))
