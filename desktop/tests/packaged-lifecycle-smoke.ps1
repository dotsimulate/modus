param(
  [string]$Executable = (Join-Path $PSScriptRoot '..\src-tauri\target\release\modus-desktop.exe'),
  [ValidateSet('managed', 'remote', 'close-hide', 'job-close', 'tailscale')]
  [string]$Scenario = 'managed'
)

$ErrorActionPreference = 'Stop'
$Executable = [System.IO.Path]::GetFullPath($Executable)
if (!(Test-Path -LiteralPath $Executable -PathType Leaf)) {
  throw "Packaged desktop executable not found: $Executable"
}

$existing3778 = @(
  Get-NetTCPConnection -LocalPort 3778 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
)
$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("modus-packaged-$Scenario-" + [guid]::NewGuid().ToString('N'))
$modusTestHome = Join-Path $smokeRoot 'home'
$runtime = Join-Path $smokeRoot 'runtime'
$logs = Join-Path $smokeRoot 'logs'
$config = Join-Path $smokeRoot 'config'
New-Item -ItemType Directory -Path $modusTestHome, $runtime, $logs, $config -Force | Out-Null

$env:MODUS_HOME = $modusTestHome
$env:MODUS_CONFIG_DIR = $config
$testSecrets = Join-Path $config 'secrets.env'
[System.IO.File]::WriteAllText($testSecrets, "HARNESS_PIN=packaged-smoke-pin`n", [System.Text.UTF8Encoding]::new($false))
$env:HARNESS_SECRETS_FILE = $testSecrets
$env:MODUS_INSTANCE = "packaged-$Scenario"
$env:MODUS_RUNTIME_DIR = $runtime
$env:MODUS_LOGS_DIR = $logs
$env:MODUS_DESKTOP_SMOKE_ALLOW_PARALLEL = '1'
$env:MODUS_DESKTOP_SMOKE_QUIT_MS = if ($Scenario -eq 'job-close') {
  ''
} elseif ($Scenario -eq 'close-hide' -or $Scenario -eq 'tailscale') {
  '10000'
} else {
  '7000'
}
if ($Scenario -eq 'tailscale') {
  [System.IO.File]::WriteAllText((Join-Path $config 'remote'), "tailscale`n", [System.Text.UTF8Encoding]::new($false))
  $env:MODUS_TAILSCALE_CLI = Join-Path $PSScriptRoot 'fake-tailscale.cmd'
  $env:MODUS_TAILSCALE_STATUS_ATTEMPTS = '1'
  $env:MODUS_TAILSCALE_STATUS_DELAY_MS = '0'
  $env:MODUS_FAKE_TAILSCALE_STATE = Join-Path $smokeRoot 'fake-tailscale-state.json'
  $env:MODUS_FAKE_TAILSCALE_LOG = Join-Path $smokeRoot 'fake-tailscale.log'
  $env:MODUS_FAKE_TAILSCALE_DNS = 'modus-desktop-smoke.example.ts.net'
  $env:MODUS_FAKE_TAILSCALE_INITIAL_PORT = '3779'
  $initialOwner = [ordered]@{
    version = 1
    dnsName = 'modus-desktop-smoke.example.ts.net'
    endpoint = 'modus-desktop-smoke.example.ts.net:443'
    proxy = 'http://127.0.0.1:3779'
    targetPort = 3779
    createdAt = 'packaged-smoke'
    managedBy = 'cli'
  } | ConvertTo-Json
  [System.IO.File]::WriteAllText((Join-Path $config 'tailscale-serve-owner.json'), $initialOwner, [System.Text.UTF8Encoding]::new($false))
} else {
  Remove-Item Env:MODUS_TAILSCALE_CLI -ErrorAction SilentlyContinue
  Remove-Item Env:MODUS_TAILSCALE_STATUS_ATTEMPTS -ErrorAction SilentlyContinue
  Remove-Item Env:MODUS_TAILSCALE_STATUS_DELAY_MS -ErrorAction SilentlyContinue
  Remove-Item Env:MODUS_FAKE_TAILSCALE_STATE -ErrorAction SilentlyContinue
  Remove-Item Env:MODUS_FAKE_TAILSCALE_LOG -ErrorAction SilentlyContinue
  Remove-Item Env:MODUS_FAKE_TAILSCALE_DNS -ErrorAction SilentlyContinue
  Remove-Item Env:MODUS_FAKE_TAILSCALE_INITIAL_PORT -ErrorAction SilentlyContinue
}
if ($Scenario -eq 'remote') {
  $env:MODUS_DESKTOP_MODE = 'remote'
  $env:MODUS_DESKTOP_TARGET_URL = 'https://modus-packaged-smoke.invalid'
} else {
  Remove-Item Env:MODUS_DESKTOP_MODE -ErrorAction SilentlyContinue
  Remove-Item Env:MODUS_DESKTOP_TARGET_URL -ErrorAction SilentlyContinue
}

$desktop = $null
$state = $null
$closeHidden = $null
try {
  $desktop = Start-Process -FilePath $Executable -WorkingDirectory (Split-Path -Parent $Executable) -WindowStyle Hidden -PassThru
  $statePath = Join-Path $runtime 'desktop-supervisor.json'
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  while ([DateTime]::UtcNow -lt $deadline -and !$desktop.HasExited) {
    if (Test-Path -LiteralPath $statePath) {
      try {
        $candidate = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
        if (($Scenario -eq 'remote' -and $candidate.mode -eq 'remote') -or
            ($Scenario -eq 'tailscale' -and $candidate.uiConnected -eq $true -and $candidate.tailscale.state -eq 'active') -or
            ($Scenario -ne 'remote' -and $Scenario -ne 'tailscale' -and $candidate.uiConnected -eq $true)) {
          $state = $candidate
          break
        }
      } catch {
        # The supervisor replaces this small diagnostic file atomically.
      }
    }
    Start-Sleep -Milliseconds 100
    $desktop.Refresh()
  }
  if (!$state) {
    $candidateDetails = if ($candidate) { $candidate | ConvertTo-Json -Depth 8 -Compress } else { 'no supervisor state' }
    $backendLogPath = Join-Path $logs 'desktop-backend.log'
    $backendDetails = if (Test-Path -LiteralPath $backendLogPath) { Get-Content -Raw -LiteralPath $backendLogPath } else { 'no backend log' }
    throw "Desktop did not reach $Scenario readiness. State: $candidateDetails Backend: $backendDetails"
  }

  if ($Scenario -eq 'remote') {
    if ($state.backendPid -or $state.port -or (Test-Path -LiteralPath (Join-Path $logs 'desktop-backend.log'))) {
      throw 'Remote mode started a local backend'
    }
  } else {
    if ($state.port -le 0 -or $state.port -eq 3778) { throw "Invalid managed port: $($state.port)" }
    $health = Invoke-RestMethod -Uri ("http://127.0.0.1:$($state.port)/health") -TimeoutSec 5
    if ($health.status -ne 'ok') { throw 'Managed backend health failed' }
    if (!(Get-Process -Id ([int]$state.backendPid) -ErrorAction SilentlyContinue)) {
      throw 'Managed backend process is missing'
    }

    $templateProfile = Join-Path $modusTestHome 'profiles\agents\modus-dev.json'
    if (!(Test-Path -LiteralPath $templateProfile -PathType Leaf)) {
      throw 'Packaged backend did not seed the tracked default profile into the isolated Modus home'
    }
    $profileRoot = Join-Path $modusTestHome 'profiles'
    $unexpectedProfiles = @(
      Get-ChildItem -LiteralPath $profileRoot -Recurse -File |
        Where-Object { $_.FullName -ne $templateProfile }
    )
    if ($unexpectedProfiles.Count -gt 0) {
      throw "Packaged backend leaked legacy checkout profile data: $($unexpectedProfiles.FullName -join ', ')"
    }

    if ($Scenario -eq 'tailscale') {
      if ($state.tailscale.url -ne 'https://modus-desktop-smoke.example.ts.net') {
        throw "Unexpected managed Tailnet URL: $($state.tailscale.url)"
      }
      if ([int]$state.tailscale.targetPort -ne [int]$state.port) {
        throw "Tailnet route does not target the managed dynamic port: route=$($state.tailscale.targetPort) backend=$($state.port)"
      }
      $fakeConfig = Get-Content -Raw -LiteralPath $env:MODUS_FAKE_TAILSCALE_STATE | ConvertFrom-Json
      $endpoint = 'modus-desktop-smoke.example.ts.net:443'
      if ($fakeConfig.Web.$endpoint.Handlers.'/'.Proxy -ne "http://127.0.0.1:$($state.port)") {
        throw 'Fake Tailscale route was not rebound to the managed backend'
      }
      if (!$fakeConfig.Web.'modus-desktop-smoke.example.ts.net:8443') {
        throw 'Managed route reconciliation altered the unrelated :8443 rule'
      }
    }

    if ($Scenario -eq 'close-hide' -or $Scenario -eq 'tailscale') {
      Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ModusWindowSmoke {
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
'@
      $windowDeadline = [DateTime]::UtcNow.AddSeconds(5)
      do {
        $desktop.Refresh()
        $windowHandle = $desktop.MainWindowHandle
        if ($windowHandle -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 100
      } while ([DateTime]::UtcNow -lt $windowDeadline)
      if ($windowHandle -eq [IntPtr]::Zero) { throw 'Desktop window handle was not available' }
      if (![ModusWindowSmoke]::IsWindowVisible($windowHandle)) {
        throw 'Desktop window was not visible before Close'
      }
      if (![ModusWindowSmoke]::PostMessage($windowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) {
        throw 'Could not send Close to the desktop window'
      }
      Start-Sleep -Milliseconds 1000
      $desktop.Refresh()
      if ($desktop.HasExited) { throw 'Close exited the desktop instead of hiding it' }
      if ([ModusWindowSmoke]::IsWindowVisible($windowHandle)) {
        throw 'Close left the desktop window visible'
      }
      if (!(Get-Process -Id ([int]$state.backendPid) -ErrorAction SilentlyContinue)) {
        throw 'Close stopped the managed backend instead of hiding the desktop'
      }
      $hiddenHealth = Invoke-RestMethod -Uri ("http://127.0.0.1:$($state.port)/health") -TimeoutSec 5
      if ($hiddenHealth.status -ne 'ok') { throw 'Managed backend became unhealthy after Close' }
      if ($Scenario -eq 'tailscale') {
        $hiddenServe = Get-Content -Raw -LiteralPath $env:MODUS_FAKE_TAILSCALE_STATE | ConvertFrom-Json
        if (!$hiddenServe.Web.'modus-desktop-smoke.example.ts.net:443') {
          throw 'Close removed the managed Tailscale route instead of keeping it available'
        }
      }
      $closeHidden = $true
    }
  }

  if ($Scenario -eq 'job-close') {
    Stop-Process -Id $desktop.Id -Force
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    do {
      Start-Sleep -Milliseconds 100
      $backend = Get-Process -Id ([int]$state.backendPid) -ErrorAction SilentlyContinue
    } while ($backend -and [DateTime]::UtcNow -lt $deadline)
    if ($backend) { throw 'Job Object left the managed backend running' }
  } else {
    if (!$desktop.WaitForExit(20000)) { throw 'Explicit Quit did not exit the desktop' }
    if ($state.backendPid -and (Get-Process -Id ([int]$state.backendPid) -ErrorAction SilentlyContinue)) {
      throw 'Explicit Quit left the managed backend running'
    }
  }

  if ($state.port) {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, [int]$state.port)
    $listener.Start()
    $listener.Stop()
  }
  if ($Scenario -eq 'tailscale') {
    $afterServe = Get-Content -Raw -LiteralPath $env:MODUS_FAKE_TAILSCALE_STATE | ConvertFrom-Json
    if ($afterServe.Web.'modus-desktop-smoke.example.ts.net:443') {
      throw 'Explicit Quit left the desktop-owned Tailscale route active'
    }
    if (!$afterServe.Web.'modus-desktop-smoke.example.ts.net:8443') {
      throw 'Explicit Quit removed an unrelated Tailscale route'
    }
    if (Test-Path -LiteralPath (Join-Path $config 'tailscale-serve-owner.json')) {
      throw 'Explicit Quit left stale desktop Tailscale ownership metadata'
    }
    if (!(Test-Path -LiteralPath (Join-Path $config 'remote'))) {
      throw 'Explicit Quit removed the persisted Tailnet opt-in'
    }
    $fakeCommands = Get-Content -LiteralPath $env:MODUS_FAKE_TAILSCALE_LOG
    if (($fakeCommands -join "`n") -match 'serve reset') { throw 'Desktop invoked forbidden tailscale serve reset' }
    if (!($fakeCommands -contains "serve --bg --yes $($state.port)")) { throw 'Desktop did not publish the managed port' }
    if (!($fakeCommands -contains 'serve --https=443 off')) { throw 'Desktop did not remove its route on explicit Quit' }
  }
  $after3778 = @(
    Get-NetTCPConnection -LocalPort 3778 -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
  )
  if (($existing3778 -join ',') -ne ($after3778 -join ',')) {
    throw "Listener 3778 changed: before=$($existing3778 -join ',') after=$($after3778 -join ',')"
  }

  [pscustomobject]@{
    Scenario = $Scenario
    Mode = $state.mode
    DesktopPid = $desktop.Id
    BackendPid = $state.backendPid
    Port = $state.port
    UiConnected = $state.uiConnected
    CloseHidden = $closeHidden
    TailscaleState = $state.tailscale.state
    TailscaleUrl = $state.tailscale.url
    Listener3778 = $after3778 -join ','
  }
} finally {
  if ($desktop) {
    $desktop.Refresh()
    if (!$desktop.HasExited) { Stop-Process -Id $desktop.Id -Force }
  }
  $fullSmokeRoot = [System.IO.Path]::GetFullPath($smokeRoot)
  $fullTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if (!$fullSmokeRoot.StartsWith($fullTempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
      !(Split-Path -Leaf $fullSmokeRoot).StartsWith("modus-packaged-$Scenario-")) {
    throw "Refusing smoke cleanup outside the intended temporary root: $fullSmokeRoot"
  }
  if (Test-Path -LiteralPath $fullSmokeRoot) {
    Remove-Item -LiteralPath $fullSmokeRoot -Recurse -Force
  }
}
