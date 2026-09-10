$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$requiredVersion = (Get-Content -Raw -LiteralPath (Join-Path $projectRoot '.node-version')).Trim()
$localNode = Join-Path $projectRoot ".local\toolchains\node-v$requiredVersion-win-x64"

if (Test-Path -LiteralPath (Join-Path $localNode 'node.exe')) {
  $env:Path = "$localNode;$env:Path"
}

Push-Location $projectRoot
try {
  node (Join-Path $projectRoot 'scripts\check-node.mjs')
  npm start
} finally {
  Pop-Location
}
