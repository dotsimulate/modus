[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$rawTracked = (& git ls-files --cached --others --exclude-standard -z) -join ""
if ($LASTEXITCODE -ne 0) {
    throw "git ls-files failed"
}

$tracked = @(
    $rawTracked.Split([char]0, [System.StringSplitOptions]::RemoveEmptyEntries) |
        Where-Object {
            -not [string]::IsNullOrWhiteSpace($_) -and
            (Test-Path -LiteralPath $_ -PathType Leaf)
        }
)
$violations = [System.Collections.Generic.List[string]]::new()

foreach ($path in $tracked) {
    $normalized = $path.Replace("\", "/")
    $leaf = [System.IO.Path]::GetFileName($normalized)

    if ($normalized -eq 'TODO.md' -or
        $normalized -match '^(TODO|harness/TODO|archive)/') {
        $violations.Add("private TODO/handoff material: $normalized")
    }

    if ($normalized -match '(^|/)\.claude/settings(?:\.local)?\.json$') {
        $violations.Add("personal Claude permission settings: $normalized")
    }

    if ($normalized -match '^harness/\.claude/') {
        $violations.Add("legacy harness-local Claude scaffolding: $normalized")
    }

    if ($leaf -match '(?i)\.(?:db|sqlite|sqlite3)(?:-wal|-shm)?$|\.log$|^\.env(?:\..+)?$|\.env$') {
        $violations.Add("runtime, database, log, or environment file: $normalized")
    }

    if ($leaf -match '(?i)^(?:id_(?:rsa|dsa|ecdsa|ed25519)|\.npmrc)$|\.(?:pem|key|pfx|p12|crt|cer|jks|keystore|asc|gpg)$') {
        $violations.Add("credential, key, or certificate-shaped file: $normalized")
    }

    if ($normalized -match '(^|/)(node_modules|target|dist|dist-ssr|coverage)/' -or
        $normalized -match '^desktop/src-tauri/(binaries|resources)/') {
        $violations.Add("generated dependency/build output: $normalized")
    }

    if ($normalized -match '^harness/profiles/' -and
        $normalized -ne 'harness/profiles/README.md') {
        $violations.Add("personal profile/runtime state: $normalized")
    }

    if ($normalized -match '^\.modus/' -and
        $normalized -notmatch '^\.modus/moves/(chess|wordle|nano-banana|council)/') {
        $violations.Add("unexpected project-local .modus state: $normalized")
    }

    if ($normalized -match '^\.modus/moves/(?:chess|wordle|nano-banana|council)/state(?:/|$)') {
        $violations.Add("project-local move runtime state: $normalized")
    }
}

foreach ($requiredLock in @("bun.lock", "harness/bun.lock", "harness/ui/bun.lock", "desktop/bun.lock", "desktop/src-tauri/Cargo.lock", "desktop/cli-launcher/Cargo.lock")) {
    if (-not (Test-Path -LiteralPath $requiredLock -PathType Leaf)) {
        $violations.Add("missing dependency lock: $requiredLock")
    }
}

if ($violations.Count -gt 0) {
    $violations | Sort-Object -Unique | ForEach-Object { Write-Error $_ }
    throw "Publication boundary check failed with $($violations.Count) finding(s)."
}

Write-Output "Publication boundary check passed for $($tracked.Count) tracked or publish-candidate paths."
