$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$executable = Join-Path $projectRoot 'out\release\SQLExplorer-win32-x64\SQLExplorer.exe'

if (-not (Test-Path -LiteralPath $executable)) {
  throw 'Packaged application was not found. Run npm run package first.'
}

$env:SQLX_CONFIG_ROOT = $projectRoot
Start-Process -FilePath $executable -WorkingDirectory (Split-Path -Parent $executable)
