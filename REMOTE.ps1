$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Tools = Join-Path $Root 'tools'
$Data = Join-Path $Root 'data'
$Cf = Join-Path $Tools 'cloudflared.exe'
$UrlFile = Join-Path $Data 'remote-url.txt'

New-Item -ItemType Directory -Force -Path $Tools | Out-Null
New-Item -ItemType Directory -Force -Path $Data | Out-Null

function Test-Hub {
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:4173/' -UseBasicParsing -TimeoutSec 3
    return $true
  } catch {
    return $false
  }
}

if (-not (Test-Hub)) {
  Write-Host ''
  Write-Host '  Сначала откройте START.bat (сервер Savdo на 4173).' -ForegroundColor Yellow
  Write-Host ''
  exit 1
}

if (-not (Test-Path $Cf)) {
  Write-Host '  Скачиваю cloudflared (один раз)...'
  $uri = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
  try {
    Invoke-WebRequest -Uri $uri -OutFile $Cf -UseBasicParsing
  } catch {
    Write-Host '  Не удалось скачать cloudflared. Проверьте интернет.' -ForegroundColor Red
    exit 1
  }
}

Write-Host '  Туннель запускается...'
Write-Host '  Не закрывайте это окно.'
Write-Host ''

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $Cf
$psi.Arguments = 'tunnel --url http://127.0.0.1:4173'
$psi.RedirectStandardError = $true
$psi.RedirectStandardOutput = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$p = New-Object System.Diagnostics.Process
$p.StartInfo = $psi
[void]$p.Start()

$found = $false
$deadline = (Get-Date).AddMinutes(3)

while (-not $p.HasExited -and (Get-Date) -lt $deadline) {
  $line = $p.StandardError.ReadLine()
  if ($null -eq $line) { Start-Sleep -Milliseconds 200; continue }
  Write-Host $line
  if ($line -match 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com') {
    $url = $Matches[0].TrimEnd('/')
    Set-Content -Path $UrlFile -Value $url -Encoding UTF8
    Write-Host ''
    Write-Host '  ============================================' -ForegroundColor Green
    Write-Host "  ССЫЛКА ДЛЯ ТЕЛЕФОНА:" -ForegroundColor Green
    Write-Host "  $url" -ForegroundColor Cyan
    Write-Host '  ============================================' -ForegroundColor Green
    Write-Host '  На телефоне откройте ссылку и войдите'
    Write-Host '  тем же email/паролем, что на компьютере.'
    Write-Host '  Можно также сохранить ссылку в Savdo → Танзимот.'
    Write-Host ''
    $found = $true
    try { Set-Clipboard -Value $url } catch {}
  }
}

if (-not $found) {
  Write-Host '  Ссылка не появилась. Проверьте интернет и START.bat.' -ForegroundColor Yellow
}

# Keep process output flowing until exit
while (-not $p.HasExited) {
  $line = $p.StandardError.ReadLine()
  if ($null -ne $line) { Write-Host $line }
  else { Start-Sleep -Milliseconds 300 }
}

$p.WaitForExit()
exit $p.ExitCode
