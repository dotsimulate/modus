param(
  [string]$InstallDirectory = (Join-Path $PSScriptRoot '..\src-tauri\target\release')
)

$ErrorActionPreference = 'Stop'
$InstallDirectory = [System.IO.Path]::GetFullPath($InstallDirectory)
$cli = Join-Path $InstallDirectory 'modus.exe'
foreach ($required in @(
  $cli,
  (Join-Path $InstallDirectory 'bun.exe'),
  (Join-Path $InstallDirectory 'modus\cli.js'),
  (Join-Path $InstallDirectory 'modus\server.js')
)) {
  if (!(Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Packaged CLI file is missing: $required"
  }
}

$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$smokeRoot = Join-Path $tempRoot ("modus-packaged-cli-" + [guid]::NewGuid().ToString('N'))
$project = Join-Path $smokeRoot 'project'
$config = Join-Path $smokeRoot 'config'
$environmentNames = @(
  'USERPROFILE', 'HOME', 'MODUS_HOME', 'MODUS_CONFIG_DIR', 'MODUS_DATA_DIR',
  'MODUS_LOGS_DIR', 'MODUS_RUNTIME_DIR', 'MODUS_CACHE_DIR',
  'HARNESS_SECRETS_FILE', 'MODUS_INSTANCE'
)
$originalEnvironment = @{}
foreach ($name in $environmentNames) {
  $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

function Invoke-PackagedCli([string[]]$Arguments) {
  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = (& $script:cli @Arguments 2>&1 | Out-String)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
  return [pscustomobject]@{ Output = $output; ExitCode = $exitCode }
}

try {
  New-Item -ItemType Directory -Path $project, $config -Force | Out-Null
  $env:USERPROFILE = $smokeRoot
  $env:HOME = $smokeRoot
  $env:MODUS_HOME = Join-Path $smokeRoot 'home'
  $env:MODUS_CONFIG_DIR = $config
  $env:MODUS_DATA_DIR = Join-Path $smokeRoot 'data'
  $env:MODUS_LOGS_DIR = Join-Path $smokeRoot 'logs'
  $env:MODUS_RUNTIME_DIR = Join-Path $smokeRoot 'runtime'
  $env:MODUS_CACHE_DIR = Join-Path $smokeRoot 'cache'
  $env:HARNESS_SECRETS_FILE = Join-Path $config 'secrets.env'
  Remove-Item Env:MODUS_INSTANCE -ErrorAction SilentlyContinue

  $versionResult = Invoke-PackagedCli @('--version')
  $version = $versionResult.Output.Trim()
  if ($versionResult.ExitCode -ne 0 -or $version -notmatch '^modus \S+ \(.+\)$') {
    throw "Packaged modus --version failed: $($versionResult.Output)"
  }

  $helpResult = Invoke-PackagedCli @('--help')
  if ($helpResult.ExitCode -ne 0 -or $helpResult.Output -notmatch 'start\s+Start the server' -or $helpResult.Output -notmatch '--instance <slug>') {
    throw "Packaged modus --help is incomplete: $($helpResult.Output)"
  }

  $setupResult = Invoke-PackagedCli @('setup')
  if ($setupResult.ExitCode -ne 1 -or $setupResult.Output -notmatch 'source-checkout command') {
    throw "Installed modus setup did not fail closed: $($setupResult.Output)"
  }

  $initResult = Invoke-PackagedCli @('init', $project)
  if ($initResult.ExitCode -ne 0 -or !(Test-Path -LiteralPath (Join-Path $project '.modus'))) {
    throw "Packaged modus init failed: $($initResult.Output)"
  }

  $statusResult = Invoke-PackagedCli @('status', '--instance', 'private')
  if ($statusResult.ExitCode -ne 0 -or $statusResult.Output -notmatch 'Modus is not running') {
    throw "Packaged Vault status failed: $($statusResult.Output)"
  }

  [pscustomobject]@{
    cli = $cli
    version = $version
    help = 'ok'
    installedSetupGuard = 'ok'
    init = 'ok'
    vaultStatus = 'ok'
  } | Format-List
} finally {
  foreach ($name in $environmentNames) {
    $value = $originalEnvironment[$name]
    if ($null -eq $value) {
      Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    } else {
      Set-Item "Env:$name" $value
    }
  }

  $resolvedSmokeRoot = [System.IO.Path]::GetFullPath($smokeRoot)
  if ($resolvedSmokeRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
      ([System.IO.Path]::GetFileName($resolvedSmokeRoot) -like 'modus-packaged-cli-*')) {
    Remove-Item -LiteralPath $resolvedSmokeRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
