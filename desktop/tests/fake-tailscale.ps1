param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$FakeArgs
)

$ErrorActionPreference = 'Stop'
$statePath = $env:MODUS_FAKE_TAILSCALE_STATE
$logPath = $env:MODUS_FAKE_TAILSCALE_LOG
$dnsName = if ($env:MODUS_FAKE_TAILSCALE_DNS) { $env:MODUS_FAKE_TAILSCALE_DNS.TrimEnd('.') } else { 'modus-desktop-smoke.example.ts.net' }
if (!$statePath) { throw 'MODUS_FAKE_TAILSCALE_STATE is required' }
if ($logPath) { Add-Content -LiteralPath $logPath -Value ($FakeArgs -join ' ') }

function Write-FakeServeConfig([Nullable[int]]$Port) {
  $tcp = [ordered]@{
    '8443' = [ordered]@{ HTTPS = $true }
  }
  if ($null -ne $Port) {
    $tcp['443'] = [ordered]@{ HTTPS = $true }
  }
  $web = [ordered]@{
    "${dnsName}:8443" = [ordered]@{
      Handlers = [ordered]@{
        '/' = [ordered]@{ Proxy = 'https+insecure://localhost:8443' }
      }
    }
  }
  if ($null -ne $Port) {
    $web["${dnsName}:443"] = [ordered]@{
      Handlers = [ordered]@{
        '/' = [ordered]@{ Proxy = "http://127.0.0.1:$Port" }
      }
    }
  }
  [ordered]@{
    TCP = $tcp
    Web = $web
  } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $statePath -Encoding UTF8
}

if ($FakeArgs.Count -ge 2 -and $FakeArgs[0] -eq 'status' -and $FakeArgs[1] -eq '--json') {
  [ordered]@{ Self = [ordered]@{ DNSName = "$dnsName." } } | ConvertTo-Json -Compress
  exit 0
}

if ($FakeArgs.Count -ge 3 -and $FakeArgs[0] -eq 'serve' -and $FakeArgs[1] -eq 'status' -and $FakeArgs[2] -eq '--json') {
  if (!(Test-Path -LiteralPath $statePath)) {
    $initialPort = if ($env:MODUS_FAKE_TAILSCALE_INITIAL_PORT) { [Nullable[int]][int]$env:MODUS_FAKE_TAILSCALE_INITIAL_PORT } else { [Nullable[int]]$null }
    Write-FakeServeConfig $initialPort
  }
  Get-Content -Raw -LiteralPath $statePath
  exit 0
}

if ($FakeArgs.Count -ge 4 -and $FakeArgs[0] -eq 'serve' -and $FakeArgs[1] -eq '--bg' -and $FakeArgs[2] -eq '--yes') {
  Write-FakeServeConfig ([int]$FakeArgs[3])
  exit 0
}

if ($FakeArgs.Count -ge 3 -and $FakeArgs[0] -eq 'serve' -and $FakeArgs[1] -eq '--https=443' -and $FakeArgs[2] -eq 'off') {
  Write-FakeServeConfig $null
  exit 0
}

Write-Error "Unsupported fake Tailscale command: $($FakeArgs -join ' ')"
exit 2
