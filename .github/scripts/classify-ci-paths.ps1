[CmdletBinding()]
param(
    [string]$EventName = "",
    [string]$BeforeSha = "",
    [string]$Sha = "",
    [switch]$FromFiles,
    [string[]]$ChangedFiles = @()
)

$ErrorActionPreference = "Stop"

# Private-phase lean push gate: always run publication-boundary, harness tests,
# and typechecks. Extra jobs (production UI build, desktop Rust including
# cli-launcher) run when their inputs change. Shared workflow inputs fail
# toward running extras. Non-push events and unreadable diffs run extras.

$ZeroSha = "0000000000000000000000000000000000000000"

function Write-Classification {
    param(
        [bool]$UiBuild,
        [bool]$Rust,
        [string]$Reason
    )

    $reason = ($Reason -replace '[\r\n=]', " ").Trim()
    if ([string]::IsNullOrWhiteSpace($reason)) {
        $reason = "unspecified"
    }

    $uiValue = if ($UiBuild) { "true" } else { "false" }
    $rustValue = if ($Rust) { "true" } else { "false" }

    if ($env:GITHUB_OUTPUT) {
        @(
            "ui_build=$uiValue"
            "rust=$rustValue"
            "reason=$reason"
        ) | Add-Content -LiteralPath $env:GITHUB_OUTPUT -Encoding utf8
    }

    Write-Output (@{
        ui_build = $uiValue
        rust = $rustValue
        reason = $reason
    } | ConvertTo-Json -Compress)
}

function Test-FailOpenPath {
    param([string]$Path)
    return $Path -match '^\.github/'
}

function Test-UiBuildPath {
    param([string]$Path)
    return (
        $Path -match '^harness/ui/' -or
        $Path -match '^harness/sdk/' -or
        $Path -eq 'harness/turn-meta.ts' -or
        $Path -eq 'harness/provider-error.ts'
    )
}

function Test-RustPath {
    param([string]$Path)
    # The Rust job owns the Rust half of the third-party notices check, because
    # crate license text only exists in the cargo registry that job populates.
    # So the notices generator and the artifacts it drift-checks route here too:
    # without them a change to the generator skips its own verification.
    return (
        $Path -match '^desktop/' -or
        $Path -match '^harness/notices/' -or
        $Path -eq 'harness/scripts/generate-notices.ts' -or
        $Path -eq 'THIRD-PARTY-NOTICES.md' -or
        $Path -eq 'sbom.cdx.json'
    )
}

try {
    if ([string]::IsNullOrWhiteSpace($EventName) -and $env:CI_EVENT_NAME) {
        $EventName = $env:CI_EVENT_NAME
    }
    if ([string]::IsNullOrWhiteSpace($BeforeSha) -and $env:CI_BEFORE_SHA) {
        $BeforeSha = $env:CI_BEFORE_SHA
    }
    if ([string]::IsNullOrWhiteSpace($Sha) -and $env:CI_SHA) {
        $Sha = $env:CI_SHA
    }
    if ([string]::IsNullOrWhiteSpace($EventName)) {
        $EventName = "push"
    }

    if ($EventName -ne "push") {
        Write-Classification -UiBuild $true -Rust $true -Reason "event:$EventName"
        exit 0
    }

    $paths = @()
    if ($FromFiles) {
        $paths = @($ChangedFiles)
    }
    else {
        if ([string]::IsNullOrWhiteSpace($BeforeSha) -or $BeforeSha -eq $ZeroSha) {
            Write-Classification -UiBuild $true -Rust $true -Reason "new-history"
            exit 0
        }
        if ([string]::IsNullOrWhiteSpace($Sha)) {
            Write-Classification -UiBuild $true -Rust $true -Reason "diff-unavailable"
            exit 0
        }

        $raw = & git diff --name-only $BeforeSha $Sha -- 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Classification -UiBuild $true -Rust $true -Reason "diff-unavailable"
            exit 0
        }
        $paths = @(
            @($raw) |
                ForEach-Object { "$_".Trim() } |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        )
    }

    $normalized = @(
        $paths |
            ForEach-Object { $_.Replace("\", "/").TrimStart("/") } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )

    if ($normalized.Count -eq 0) {
        Write-Classification -UiBuild $true -Rust $true -Reason "empty-diff"
        exit 0
    }

    $failOpen = @($normalized | Where-Object { Test-FailOpenPath $_ })
    if ($failOpen.Count -gt 0) {
        Write-Classification -UiBuild $true -Rust $true -Reason "fail-open:$($failOpen[0])"
        exit 0
    }

    $uiBuild = $false
    $rust = $false
    foreach ($path in $normalized) {
        if (Test-UiBuildPath $path) { $uiBuild = $true }
        if (Test-RustPath $path) { $rust = $true }
    }

    $reason = if ($uiBuild -and $rust) {
        "ui+rust"
    }
    elseif ($uiBuild) {
        "ui"
    }
    elseif ($rust) {
        "rust"
    }
    else {
        "core-only"
    }

    Write-Classification -UiBuild $uiBuild -Rust $rust -Reason $reason
    exit 0
}
catch {
    Write-Classification -UiBuild $true -Rust $true -Reason "diff-unavailable"
    exit 0
}
