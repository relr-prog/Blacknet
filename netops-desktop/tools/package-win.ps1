# Builds the BlackNet Windows installer (NSIS) in a staged copy so the Linux
# tree's node_modules and build artifacts never leak into the package.

param(
  [string]$OutDir = "$env:LOCALAPPDATA\blacknet-win-build"
)

$ErrorActionPreference = "Stop"

function Assert-Command([string]$name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "required tool not found on PATH: $name (install the WinLibs MinGW64 toolchain)"
  }
}

Assert-Command cmake
Assert-Command mingw32-make
Assert-Command gendef
Assert-Command dlltool
Assert-Command node
Assert-Command npm

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Write-Host "repo: $repo"

$package = Get-Content (Join-Path $repo "package.json") -Raw | ConvertFrom-Json
$productExe = "$($package.build.productName).exe"
$nodeVersion = (node -p "process.versions.node").Trim()

$stage = Join-Path $OutDir "src"
if (Test-Path $OutDir) { Remove-Item -LiteralPath $OutDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Host "staging source into $stage (excluding node_modules, build, dist, .git, state)"
robocopy $repo $stage /E /XD node_modules .git build dist var data /XF *.log /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }

Write-Host "installing dependencies (npm ci)"
Push-Location $stage
try {
  npm ci --no-audit --no-fund
  $electronExe = Join-Path $stage "node_modules\electron\dist\electron.exe"
  if (-not (Test-Path $electronExe)) {
    Write-Host "electron binary missing, fetching it"
    node "node_modules\electron\install.js"
  }

  Write-Host "fetching N-API headers for node $nodeVersion"
  npx node-gyp install --target=$nodeVersion --silent
  $headerCache = Join-Path $env:LOCALAPPDATA "node-gyp\cache\$nodeVersion\include\node"
  if (-not (Test-Path (Join-Path $headerCache "node_api.h"))) {
    throw "node headers not found in $headerCache"
  }
  $headerTarget = Join-Path $stage "node_modules\node\include\node"
  New-Item -ItemType Directory -Force -Path (Split-Path $headerTarget -Parent) | Out-Null
  Copy-Item $headerCache $headerTarget -Recurse -Force

  New-Item -ItemType Directory -Force -Path (Join-Path $stage "build") | Out-Null
  Push-Location (Join-Path $stage "build")
  try {
    Write-Host "generating an N-API import library from the packaged binary name ($productExe)"
    gendef $electronExe 2>&1 | Out-Null
    if (-not (Test-Path "electron.def")) { throw "gendef failed to produce electron.def" }
    dlltool -d electron.def -l electron.lib -D $productExe 2>&1 | Out-Null
    if (-not (Test-Path "electron.lib")) { throw "dlltool failed to produce electron.lib" }
  } finally {
    Pop-Location
  }

  Write-Host "building the C++ policy addon (MinGW)"
  $importLib = ((Join-Path $stage "build") -replace "\\", "/") + "/electron.lib"
  cmake -S (Join-Path $stage "native") -B (Join-Path $stage "build") `
    -G "MinGW Makefiles" -DCMAKE_BUILD_TYPE=Release -DNETOPS_BUILD_TESTS=OFF `
    "-DNODE_IMPORT_LIB=$importLib"
  cmake --build (Join-Path $stage "build") --parallel
  $addon = Join-Path $stage "build\native\netops_native.node"
  if (-not (Test-Path $addon)) { throw "addon build produced no netops_native.node" }

  Write-Host "packaging with electron-builder (NSIS, per-user)"
  npx electron-builder --win nsis
  $artifact = Get-ChildItem (Join-Path $stage "dist\*.exe") | Where-Object { $_.Name -notlike "*.blockmap" } | Select-Object -First 1
  if (-not $artifact) { throw "electron-builder produced no installer" }
  Write-Host ""
  Write-Host "installer: $($artifact.FullName)"
  Write-Host "size:      $([math]::Round($artifact.Length / 1MB, 1)) MB"
} finally {
  Pop-Location
}