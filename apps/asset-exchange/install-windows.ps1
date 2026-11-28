# Cai dat / cap nhat TokenVN tren Windows (khong can Git, khong can file zip).
# Chay trong Command Prompt:
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/Tt-cyber25/js/claude/asset-digitization-app-0c7pwb/apps/asset-exchange/install-windows.ps1 | iex"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$base = 'https://raw.githubusercontent.com/Tt-cyber25/js/claude/asset-digitization-app-0c7pwb/apps/asset-exchange'
$dest = 'C:\TokenVN'
$files = @(
  'package.json', '.env.example', 'README.md',
  'src/assetTypes.js', 'src/auth.js', 'src/config.js', 'src/db.js', 'src/exchange.js',
  'src/ledger.js', 'src/seed.js', 'src/server.js', 'src/admin-password.js', 'chia-se-link.ps1',
  'public/index.html', 'public/app.js', 'public/styles.css', 'public/icon.svg', 'public/manifest.webmanifest',
  'public/sw.js', 'public/icon-192.png', 'public/icon-512.png', 'public/icon-maskable-512.png',
  'public/docs/custody-demo.html', 'public/docs/sample-redacted.html',
  'docs/NGHIEN_CUU_SAN_GIAO_DICH.md', 'test/ledger.test.js'
)

Write-Host "Dang tai TokenVN ve $dest ..."
foreach ($f in $files) {
  $out = Join-Path $dest ($f -replace '/', '\')
  New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$f" -OutFile $out
  Write-Host "  + $f"
}

$bat = "@echo off`r`ncd /d `"%~dp0`"`r`nstart `"`" cmd /c `"timeout /t 3 >nul & start http://localhost:3000`"`r`nnpm start`r`npause`r`n"
Set-Content -Path (Join-Path $dest 'chay-app.bat') -Value $bat -Encoding ASCII
$share = "@echo off`r`ncd /d `"%~dp0`"`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0chia-se-link.ps1`"`r`npause`r`n"
Set-Content -Path (Join-Path $dest 'chia-se-link.bat') -Value $share -Encoding ASCII

Write-Host ""
Write-Host "XONG! App nam o $dest"
Write-Host "Lan sau chi can nhap dup file C:\TokenVN\chay-app.bat"
Write-Host "Muon mo tren dien thoai o bat ky dau: nhap dup C:\TokenVN\chia-se-link.bat"
Write-Host "Neu bao loi 'cau truc cu': xoa thu muc C:\TokenVN\data roi chay lai."
Write-Host ""
Set-Location $dest
& (Join-Path $dest 'chay-app.bat')
