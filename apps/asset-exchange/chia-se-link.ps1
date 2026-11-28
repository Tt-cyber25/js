# Tao duong link cong khai (HTTPS) de mo TokenVN tu bat ky dau, ke ca dien thoai dung 4G.
# Dung Cloudflare Quick Tunnel: mien phi, khong can tai khoan. Link doi moi lan chay.
# Luu y: may tinh phai bat va cua so nay phai mo thi link moi hoat dong.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Set-Location $PSScriptRoot

$tools = Join-Path $PSScriptRoot 'tools'
$exe = Join-Path $tools 'cloudflared.exe'
if (-not (Test-Path $exe)) {
  New-Item -ItemType Directory -Force -Path $tools | Out-Null
  Write-Host 'Dang tai cloudflared (lan dau, ~20MB)...'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $exe
}

# Link cong khai: khong de mat khau admin demo cong khai
Write-Host ''
Write-Host '=== Doi mat khau quan tri (admin@demo.vn) vi link se cong khai ==='
node --disable-warning=ExperimentalWarning src/admin-password.js admin@demo.vn
Write-Host 'GHI LAI mat khau tren. Cac tai khoan nha dau tu demo van dung Demo@12345 (tien ao).'
Write-Host ''

# Chay app (neu chua chay) o cua so rieng, tin cay header cua tunnel
$running = $false
try { $running = (Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3000/api/meta' -TimeoutSec 2).StatusCode -eq 200 } catch {}
if (-not $running) {
  Start-Process cmd -ArgumentList '/k', "cd /d `"$PSScriptRoot`" && set `"TRUST_PROXY=1`" && npm start"
  Start-Sleep -Seconds 4
}

Write-Host '=== Dang mo duong link cong khai... Tim dong co chu https://....trycloudflare.com ben duoi ==='
Write-Host '=== Mo link do tren dien thoai. Dong cua so nay de tat link. ==='
& $exe tunnel --no-autoupdate --url http://localhost:3000
