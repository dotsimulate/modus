param(
  [string]$MakeNsis = (Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe')
)

$ErrorActionPreference = 'Stop'
if (!(Test-Path -LiteralPath $MakeNsis -PathType Leaf)) {
  throw 'NSIS is required; pass -MakeNsis with the compiler location.'
}
$root = Join-Path ([System.IO.Path]::GetTempPath()) ('modus-file-associations-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$registryNamespace = 'Software\ModusFileAssociationsSmoke\' + [guid]::NewGuid().ToString('N')
$registryRoot = 'HKCU:\' + $registryNamespace
$classes = $registryRoot + '\Classes'
$source = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '..\src-tauri\file-associations.nsh')
$source = $source.Replace('Software\Classes', $registryNamespace + '\Classes')
# This harness exercises registry writes only in its private namespace. It must
# never notify Explorer about an association change in the real Classes tree.
$source = $source -replace "(?m)^\s*System::Call.*SHChangeNotify.*$", ''
$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText((Join-Path $root 'associations.nsh'), $source, $utf8)
$executable = Join-Path $root 'registry-test.exe'
$script = @'
Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "Modus file association test"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!define PRODUCTNAME "Modus"
!define MAINBINARYNAME "modus-desktop"
!include "associations.nsh"
Section
  StrCpy $INSTDIR "C:\Program Files\Test Modus"
  ${GetOptions} $CMDLINE "/UNREGISTER" $R1
  ${IfNot} ${Errors}
    !insertmacro MODUS_UNREGISTER_FILE_ASSOCIATIONS
  ${Else}
    !insertmacro MODUS_REGISTER_FILE_ASSOCIATIONS
  ${EndIf}
SectionEnd
'@
$script = 'OutFile "' + $executable + '"' + "`r`n" + $script
[System.IO.File]::WriteAllText((Join-Path $root 'registry-test.nsi'), $script, $utf8)

function Assert-Equal($Actual, $Expected, [string]$Label) {
  if ($Actual -cne $Expected) { throw "$Label differed: expected [$Expected], got [$Actual]" }
}
function Run-TestBinary([switch]$Unregister) {
  $arguments = if ($Unregister) { @('/S', '/UNREGISTER') } else { @('/S') }
  $process = Start-Process -FilePath $executable -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Registry test exited $($process.ExitCode)" }
}
function Assert-Defaults {
  foreach ($extension in @('md', 'markdown', 'txt')) {
    Assert-Equal (Get-Item -LiteralPath "$classes\.$extension").GetValue('') 'Other.Editor' "$extension default"
    Assert-Equal (Get-Item -LiteralPath "$classes\.$extension\UserChoice").GetValue('ProgId') 'Other.Editor' "$extension UserChoice"
  }
}

try {
  Push-Location $root
  try { & $MakeNsis '-V2' 'registry-test.nsi' } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw 'NSIS compilation failed' }
  foreach ($extension in @('md', 'markdown', 'txt')) {
    New-Item -Path "$classes\.$extension\UserChoice" -Force | Out-Null
    Set-Item -LiteralPath "$classes\.$extension" -Value 'Other.Editor'
    New-ItemProperty -LiteralPath "$classes\.$extension\UserChoice" -Name 'ProgId' -Value 'Other.Editor' | Out-Null
  }
  Run-TestBinary
  Assert-Defaults
  $command = '"C:\Program Files\Test Modus\modus-desktop.exe" "%1"'
  Assert-Equal (Get-Item -LiteralPath "$classes\Modus.Markdown\shell\open\command").GetValue('') $command 'quoted open command'
  Assert-Equal (Get-Item -LiteralPath "$classes\.md\OpenWithProgids").GetValue('Modus.Markdown') '' 'Markdown Open with entry'
  Assert-Equal (Get-Item -LiteralPath "$classes\.markdown\OpenWithProgids").GetValue('Modus.Markdown') '' 'long Markdown extension'
  Assert-Equal (Get-Item -LiteralPath "$classes\.txt\OpenWithProgids").GetValue('Modus.Text') '' 'text Open with entry'
  Run-TestBinary
  Assert-Defaults
  Run-TestBinary -Unregister
  Assert-Defaults
  if (Test-Path -LiteralPath "$classes\Modus.Markdown") { throw 'Uninstall left the owned ProgID' }
  if (Test-Path -LiteralPath "$classes\Applications\modus-desktop.exe") { throw 'Uninstall left the owned application' }
  Run-TestBinary
  Set-Item -LiteralPath "$classes\Modus.Markdown\shell\open\command" -Value 'different installation'
  Run-TestBinary -Unregister
  Assert-Equal (Get-Item -LiteralPath "$classes\Modus.Markdown\shell\open\command").GetValue('') 'different installation' 'foreign installation preservation'
  Write-Output 'PASS: registration, reinstallation, quoted file forwarding, default/UserChoice preservation, owned cleanup, and foreign installation preservation.'
} finally {
  if (!$registryRoot.StartsWith('HKCU:\Software\ModusFileAssociationsSmoke\')) { throw 'Refusing registry cleanup outside the test namespace' }
  if (Test-Path -LiteralPath $registryRoot) { Remove-Item -LiteralPath $registryRoot -Recurse -Force }
  Write-Output "Artifacts: $root"
}
