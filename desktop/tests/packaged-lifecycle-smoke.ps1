param(
  [string]$Executable = (Join-Path $PSScriptRoot '..\src-tauri\target\release\modus-desktop.exe'),
  [ValidateSet('managed', 'remote', 'close-hide', 'job-close', 'tailscale', 'two-vault')]
  [string]$Scenario = 'managed'
)

$ErrorActionPreference = 'Stop'
$Executable = [System.IO.Path]::GetFullPath($Executable)
if (!(Test-Path -LiteralPath $Executable -PathType Leaf)) {
  throw "Packaged desktop executable not found: $Executable"
}

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class ModusVisibleWindowProbe {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

  public static string[] Find(uint[] processIds) {
    var targets = new HashSet<uint>(processIds);
    var found = new List<string>();
    EnumWindows((window, _) => {
      if (!IsWindowVisible(window)) return true;
      uint processId;
      GetWindowThreadProcessId(window, out processId);
      if (!targets.Contains(processId)) return true;
      var title = new StringBuilder(512);
      GetWindowText(window, title, title.Capacity);
      found.Add(string.Format("{0}:{1}:{2}", processId, window.ToInt64(), title));
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
}
'@

$existing3778 = @(
  Get-NetTCPConnection -LocalPort 3778 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
)
$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("modus-packaged-$Scenario-" + [guid]::NewGuid().ToString('N'))
$modusTestHome = Join-Path $smokeRoot 'home'
$runtime = Join-Path $smokeRoot 'runtime'
$logs = Join-Path $smokeRoot 'logs'
$config = Join-Path $smokeRoot 'config'
$project = Join-Path $smokeRoot 'project'
New-Item -ItemType Directory -Path $modusTestHome, $runtime, $logs, $config, $project -Force | Out-Null

$env:MODUS_HOME = $modusTestHome
$env:HOME = $smokeRoot
$env:USERPROFILE = $smokeRoot
$env:XDG_CONFIG_HOME = Join-Path $smokeRoot 'xdg-config'
$env:XDG_DATA_HOME = Join-Path $smokeRoot 'xdg-data'
$env:XDG_CACHE_HOME = Join-Path $smokeRoot 'xdg-cache'
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $smokeRoot 'webview'
$env:MODUS_CONFIG_DIR = $config
$testSecrets = Join-Path $config 'secrets.env'
[System.IO.File]::WriteAllText($testSecrets, "HARNESS_PIN=packaged-smoke-pin`n", [System.Text.UTF8Encoding]::new($false))
$env:HARNESS_SECRETS_FILE = $testSecrets
Remove-Item Env:MODUS_INSTANCE -ErrorAction SilentlyContinue
Remove-Item Env:MODUS_VAULT_ROOT -ErrorAction SilentlyContinue
$env:MODUS_RUNTIME_DIR = $runtime
$env:MODUS_LOGS_DIR = $logs
$env:MODUS_DESKTOP_SMOKE_ALLOW_PARALLEL = '1'
$env:MODUS_DESKTOP_SMOKE_ID = "packaged-$Scenario"
$env:MODUS_DESKTOP_SMOKE_QUIT_MS = if ($Scenario -eq 'job-close') {
  ''
} elseif ($Scenario -eq 'close-hide' -or $Scenario -eq 'tailscale') {
  '10000'
} else {
  if ($Scenario -eq 'two-vault') { '20000' } else { '7000' }
}
if ($Scenario -eq 'two-vault') {
  $secondarySlug = 'packaged-two-vault-alpha'
  $tertiarySlug = 'packaged-two-vault-beta'
  $secondaryRoot = Join-Path $smokeRoot 'vault-folders\alpha-arbitrary-root'
  $tertiaryRoot = Join-Path $smokeRoot 'portable\beta-arbitrary-root'
  New-Item -ItemType Directory -Path $secondaryRoot, $tertiaryRoot -Force | Out-Null
  $denyAllPolicy = @{
    plugins = @{ mode = 'deny'; allow = @() }
    projectAutomation = @{ mode = 'deny'; allow = @() }
    channels = @{ mode = 'deny'; allow = @() }
  } | ConvertTo-Json -Depth 4
  foreach ($vault in @(
    @{ Slug = $secondarySlug; Root = $secondaryRoot; Secret = 'alpha-secret'; Profile = 'alpha-canary' },
    @{ Slug = $tertiarySlug; Root = $tertiaryRoot; Secret = 'beta-secret'; Profile = 'beta-canary' }
  )) {
    $manifest = @{ version = 1; slug = $vault.Slug; createdAt = 1 } | ConvertTo-Json
    [System.IO.File]::WriteAllText((Join-Path $vault.Root 'vault-manifest.json'), $manifest, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $vault.Root 'vault.json'), $denyAllPolicy, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $vault.Root 'secrets.env'), "BOUNDARY_SECRET=$($vault.Secret)`n", [System.Text.UTF8Encoding]::new($false))
    $profileDir = Join-Path $vault.Root 'profiles\agents'
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $profileDir "$($vault.Profile).json"), '{"prompt":"named Vault canary"}', [System.Text.UTF8Encoding]::new($false))
  }
  [System.IO.File]::WriteAllText((Join-Path $modusTestHome 'main-root-canary.txt'), 'Main must remain isolated', [System.Text.UTF8Encoding]::new($false))
  $registry = @{
    vaults = @(
      @{ slug = $secondarySlug; name = 'Alpha smoke Vault'; root = $secondaryRoot; createdAt = 1; autostart = $true },
      @{ slug = $tertiarySlug; name = 'Beta smoke Vault'; root = $tertiaryRoot; createdAt = 1; autostart = $true }
    )
  } | ConvertTo-Json -Depth 4
  [System.IO.File]::WriteAllText((Join-Path $modusTestHome 'vaults.json'), $registry, [System.Text.UTF8Encoding]::new($false))
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
  # Pin lifecycle scenarios to the managed path independently of saved choices.
  $env:MODUS_DESKTOP_MODE = 'managed-local'
  Remove-Item Env:MODUS_DESKTOP_TARGET_URL -ErrorAction SilentlyContinue
}

$desktop = $null
$state = $null
$secondaryState = $null
$tertiaryState = $null
$closeHidden = $null
$brainBridgeVerified = $null
$claudeOpus5Listed = $null
$backendVisibleWindows = @()
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
    $scopedArtifacts = @(Get-ChildItem -LiteralPath $smokeRoot -Recurse -File -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty FullName)
    $desktop.Refresh()
    $desktopState = if ($desktop.HasExited) { "exited with $($desktop.ExitCode)" } else { 'still running' }
    throw "Desktop did not reach $Scenario readiness ($desktopState). State: $candidateDetails Backend: $backendDetails Scoped artifacts: $($scopedArtifacts -join ', ')"
  }

  if ($Scenario -eq 'two-vault') {
    $secondaryStatePath = Join-Path $secondaryRoot 'runtime\desktop-supervisor.json'
    $tertiaryStatePath = Join-Path $tertiaryRoot 'runtime\desktop-supervisor.json'
    $secondaryDeadline = [DateTime]::UtcNow.AddSeconds(45)
    while ([DateTime]::UtcNow -lt $secondaryDeadline -and !$desktop.HasExited) {
      if (Test-Path -LiteralPath $secondaryStatePath) {
        try {
          $candidateSecondary = Get-Content -Raw -LiteralPath $secondaryStatePath | ConvertFrom-Json
          if ($candidateSecondary.mode -eq 'managed-local' -and $candidateSecondary.port -gt 0) {
            $secondaryState = $candidateSecondary
          }
        } catch {
          # Each Vault publishes its own record atomically.
        }
      }
      if (Test-Path -LiteralPath $tertiaryStatePath) {
        try {
          $candidateTertiary = Get-Content -Raw -LiteralPath $tertiaryStatePath | ConvertFrom-Json
          if ($candidateTertiary.mode -eq 'managed-local' -and $candidateTertiary.port -gt 0) {
            $tertiaryState = $candidateTertiary
          }
        } catch {
          # Each Vault publishes its own record atomically.
        }
      }
      if ($secondaryState -and $tertiaryState) { break }
      Start-Sleep -Milliseconds 100
      $desktop.Refresh()
    }
    if (!$secondaryState -or !$tertiaryState) { throw 'Both autostart Vaults must publish root-scoped supervisor records' }
    $smokePorts = @([int]$state.port, [int]$secondaryState.port, [int]$tertiaryState.port) | Select-Object -Unique
    $smokePids = @([int]$state.backendPid, [int]$secondaryState.backendPid, [int]$tertiaryState.backendPid) | Select-Object -Unique
    if ($smokePorts.Count -ne 3) { throw 'Main and the two named Vaults did not receive distinct ports' }
    if ($smokePids.Count -ne 3) { throw 'Main and the two named Vaults did not receive distinct backend processes' }
    $secondaryHealth = Invoke-RestMethod -Uri ("http://127.0.0.1:$($secondaryState.port)/health") -TimeoutSec 5
    if ($secondaryHealth.status -ne 'ok') { throw 'Autostart Vault health failed' }
    $tertiaryHealth = Invoke-RestMethod -Uri ("http://127.0.0.1:$($tertiaryState.port)/health") -TimeoutSec 5
    if ($tertiaryHealth.status -ne 'ok') { throw 'Second autostart Vault health failed' }
    if (!(Test-Path -LiteralPath (Join-Path $secondaryRoot 'data\harness.db')) -or
        !(Test-Path -LiteralPath (Join-Path $tertiaryRoot 'data\harness.db'))) {
      throw 'Named Vault databases were not created beneath both registered roots'
    }
    if (!(Test-Path -LiteralPath (Join-Path $secondaryRoot 'profiles\agents\alpha-canary.json')) -or
        !(Test-Path -LiteralPath (Join-Path $tertiaryRoot 'profiles\agents\beta-canary.json'))) {
      throw 'Named Vault profile canaries did not remain in their registered roots'
    }
    if ((Test-Path -LiteralPath (Join-Path $secondaryRoot 'profiles\agents\beta-canary.json')) -or
        (Test-Path -LiteralPath (Join-Path $tertiaryRoot 'profiles\agents\alpha-canary.json')) -or
        (Test-Path -LiteralPath (Join-Path $modusTestHome 'profiles\agents\alpha-canary.json')) -or
        (Test-Path -LiteralPath (Join-Path $modusTestHome 'profiles\agents\beta-canary.json'))) {
      throw 'Profile state crossed a named Vault or Main boundary'
    }
    if ((Test-Path -LiteralPath (Join-Path $modusTestHome $secondarySlug)) -or
        (Test-Path -LiteralPath (Join-Path $modusTestHome $tertiarySlug))) {
      throw 'A slug-derived named Vault folder appeared beneath Main'
    }
    if ((Get-Content -Raw -LiteralPath (Join-Path $modusTestHome 'main-root-canary.txt')) -ne 'Main must remain isolated') {
      throw 'Named Vault startup modified the Main root canary'
    }
    if ((Get-Content -Raw -LiteralPath (Join-Path $secondaryRoot 'secrets.env')) -ne "BOUNDARY_SECRET=alpha-secret`n" -or
        (Get-Content -Raw -LiteralPath (Join-Path $tertiaryRoot 'secrets.env')) -ne "BOUNDARY_SECRET=beta-secret`n") {
      throw 'Named Vault startup rewrote or shared its secrets file'
    }
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

    $baseUri = "http://127.0.0.1:$($state.port)"
    $auth = Invoke-RestMethod `
      -Method Post `
      -Uri "$baseUri/api/auth/verify" `
      -ContentType 'application/json' `
      -Body (@{ pin = 'packaged-smoke-pin' } | ConvertTo-Json -Compress) `
      -TimeoutSec 5
    if (!$auth.ok -or !$auth.token) { throw 'Packaged backend PIN verification failed' }
    $headers = @{ Authorization = "Bearer $($auth.token)" }

    $claudeModels = Invoke-RestMethod `
      -Uri "$baseUri/api/providers/claude-code/models" `
      -Headers $headers `
      -TimeoutSec 5
    if (!($claudeModels | Where-Object { $_.id -eq 'claude-opus-5' })) {
      throw 'Packaged backend did not list claude-opus-5'
    }
    $claudeOpus5Listed = $true

    $moves = Invoke-RestMethod `
      -Uri ("$baseUri/api/moves?cwd=" + [uri]::EscapeDataString($project)) `
      -Headers $headers `
      -TimeoutSec 5
    if (!($moves | Where-Object { $_.name -eq 'modus-brain' })) {
      throw 'Packaged backend did not discover the built-in modus-brain move'
    }

    $activationBody = @{
      moveName = 'modus-brain'
      inputs = @{ request = 'Verify packaged Modus documentation access.' }
      cwd = $project
    } | ConvertTo-Json -Depth 5 -Compress
    $activation = Invoke-RestMethod `
      -Method Post `
      -Uri "$baseUri/api/moves/activate" `
      -Headers $headers `
      -ContentType 'application/json' `
      -Body $activationBody `
      -TimeoutSec 15
    if ($activation.mode -ne 'inline' -or
        !$activation.apiToken -or
        !$activation.apiToken.StartsWith('mapi-brain-') -or
        $activation.prompt -notmatch 'Documentation index') {
      throw "Packaged modus-brain activation returned an invalid result: $($activation | ConvertTo-Json -Depth 5 -Compress)"
    }

    $docsResult = Invoke-RestMethod `
      -Method Post `
      -Uri "$baseUri/api/moves/modus-brain/op" `
      -Headers $headers `
      -ContentType 'application/json' `
      -Body (@{
        apiToken = $activation.apiToken
        op = 'docs_get'
        id = 'capability-surface'
      } | ConvertTo-Json -Compress) `
      -TimeoutSec 10
    if (!$docsResult.ok -or $docsResult.message -notmatch 'Capability Surface') {
      throw "Packaged modus-brain docs_get failed: $($docsResult | ConvertTo-Json -Depth 5 -Compress)"
    }
    $brainBridgeVerified = $true

    $backendTreeIds = [System.Collections.Generic.HashSet[uint32]]::new()
    [void]$backendTreeIds.Add([uint32]$state.backendPid)
    $pendingBackendIds = [System.Collections.Generic.Queue[uint32]]::new()
    $pendingBackendIds.Enqueue([uint32]$state.backendPid)
    while ($pendingBackendIds.Count -gt 0) {
      $ownedPid = $pendingBackendIds.Dequeue()
      foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ownedPid")) {
        if ($backendTreeIds.Add([uint32]$candidate.ProcessId)) {
          $pendingBackendIds.Enqueue([uint32]$candidate.ProcessId)
        }
      }
    }
    $backendVisibleWindows = @([ModusVisibleWindowProbe]::Find([uint32[]]$backendTreeIds))
    if ($backendVisibleWindows.Count -gt 0) {
      throw "Managed backend created a visible top-level window: $($backendVisibleWindows -join ', ')"
    }

    $stagedProfiles = Join-Path (Split-Path -Parent $Executable) 'modus\templates\profiles\agents'
    $expectedProfileNames = @(Get-ChildItem -LiteralPath $stagedProfiles -File | Select-Object -ExpandProperty Name | Sort-Object)
    $seededProfiles = Join-Path $modusTestHome 'profiles\agents'
    $actualProfileNames = @(Get-ChildItem -LiteralPath $seededProfiles -File | Select-Object -ExpandProperty Name | Sort-Object)
    if (($expectedProfileNames -join ',') -ne ($actualProfileNames -join ',')) {
      throw "Packaged backend profile seed mismatch: expected=$($expectedProfileNames -join ',') actual=$($actualProfileNames -join ',')"
    }
    $profileRoot = Join-Path $modusTestHome 'profiles'
    $unexpectedProfiles = @(
      Get-ChildItem -LiteralPath $profileRoot -Recurse -File |
        Where-Object { $_.DirectoryName -ne $seededProfiles -or $_.Name -notin $expectedProfileNames }
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
    if ($secondaryState -and (Get-Process -Id ([int]$secondaryState.backendPid) -ErrorAction SilentlyContinue)) {
      throw 'Explicit Quit left the autostart Vault backend running'
    }
    if ($tertiaryState -and (Get-Process -Id ([int]$tertiaryState.backendPid) -ErrorAction SilentlyContinue)) {
      throw 'Explicit Quit left the second autostart Vault backend running'
    }
  }

  if ($state.port) {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, [int]$state.port)
    $listener.Start()
    $listener.Stop()
  }
  if ($secondaryState.port) {
    $secondaryListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, [int]$secondaryState.port)
    $secondaryListener.Start()
    $secondaryListener.Stop()
  }
  if ($tertiaryState.port) {
    $tertiaryListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, [int]$tertiaryState.port)
    $tertiaryListener.Start()
    $tertiaryListener.Stop()
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
    SecondaryBackendPid = $secondaryState.backendPid
    TertiaryBackendPid = $tertiaryState.backendPid
    Port = $state.port
    SecondaryPort = $secondaryState.port
    TertiaryPort = $tertiaryState.port
    UiConnected = $state.uiConnected
    CloseHidden = $closeHidden
    TailscaleState = $state.tailscale.state
    TailscaleUrl = $state.tailscale.url
    Listener3778 = $after3778 -join ','
    BackendVisibleWindows = $backendVisibleWindows.Count
    BrainBridgeVerified = $brainBridgeVerified
    ClaudeOpus5Listed = $claudeOpus5Listed
  }
} finally {
  if ($desktop) {
    $desktop.Refresh()
    if (!$desktop.HasExited) {
      Stop-Process -Id $desktop.Id -Force
      [void]$desktop.WaitForExit(5000)
    }
  }
  $fullSmokeRoot = [System.IO.Path]::GetFullPath($smokeRoot)
  $fullTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if (!$fullSmokeRoot.StartsWith($fullTempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
      !(Split-Path -Leaf $fullSmokeRoot).StartsWith("modus-packaged-$Scenario-")) {
    throw "Refusing smoke cleanup outside the intended temporary root: $fullSmokeRoot"
  }
  if (Test-Path -LiteralPath $fullSmokeRoot) {
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
      try {
        Remove-Item -LiteralPath $fullSmokeRoot -Recurse -Force
        break
      } catch {
        if ($attempt -eq 39) { throw }
        Start-Sleep -Milliseconds 100
      }
    }
  }
}
