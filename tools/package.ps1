# Builds the upload zip for the Chrome Web Store.
#
#   powershell -ExecutionPolicy Bypass -File tools/package.ps1
#
# Ships only what the extension needs at runtime. Tests, tooling and the README stay
# out so the reviewed package is exactly the code that runs.

$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$manifestPath = Join-Path $root 'manifest.json'
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version

$distDir = Join-Path $root 'dist'
$stageDir = Join-Path $distDir 'stage'
$zipPath = Join-Path $distDir "color-coded-clients-$version.zip"

if (Test-Path $stageDir) { Remove-Item $stageDir -Recurse -Force }
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

Copy-Item (Join-Path $root 'manifest.json') $stageDir
Copy-Item (Join-Path $root 'src') $stageDir -Recurse
Copy-Item (Join-Path $root 'icons') $stageDir -Recurse

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $stageDir '*') -DestinationPath $zipPath
Remove-Item $stageDir -Recurse -Force

$sizeKb = [Math]::Round((Get-Item $zipPath).Length / 1KB, 1)
Write-Output "Packaged version $version -> $zipPath ($sizeKb KB)"
Write-Output ''
Write-Output 'Upload at https://chrome.google.com/webstore/devconsole'
Write-Output 'Bump "version" in manifest.json before every upload; the store rejects a repeat.'
