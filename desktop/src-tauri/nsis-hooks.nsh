; Tauri restores the previous NSIS installation directory from the registry.
; Tester packages were once installed from an extracted %TEMP% layout, which
; left future reinstalls pinned to that disposable directory. Preserve normal
; custom locations, but migrate any temp-root install to the current-user
; default before copying files and rewriting shortcuts/registry values.
;
; Two things make the naive form of this check silently do nothing:
;
;   * $TEMP comes from GetTempPath and can be an 8.3 short path
;     (C:\Users\USERNA~1\AppData\Local\Temp) while the restored $INSTDIR is the
;     long form, so a single prefix compare never matches. %LOCALAPPDATA% is
;     always long form, so test both spellings of the same directory.
;   * Tauri's Install section runs SetOutPath BEFORE inserting this hook, so
;     rewriting $INSTDIR alone would send File commands to the old directory
;     while CreateDirectory used the new one. Re-point the output path here.
;
; The installer also owns the public `modus` console command. Keep its install
; directory as one exact user-PATH entry: prepend it so a stale source-checkout
; Bun link cannot shadow the installed product, and remove only that exact
; entry on uninstall. Do not manipulate PATH with NSIS strings: Tauri's NSIS
; build has NSIS_MAX_STRLEN=1024 and would truncate longer user PATH values.
; The native launcher uses dynamically-sized Win32 registry buffers instead.

!macro NSIS_HOOK_PREINSTALL
  ${StrCase} $R0 "$INSTDIR" "L"

  ${StrCase} $R1 "$TEMP\" "L"
  ${StrLoc} $R2 $R0 $R1 ">"

  ${StrCase} $R1 "$LOCALAPPDATA\Temp\" "L"
  ${StrLoc} $R3 $R0 $R1 ">"

  ${If} $R2 == 0
  ${OrIf} $R3 == 0
    StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
    SetOutPath $INSTDIR
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ExecWait '"$INSTDIR\modus.exe" --modus-installer-add-user-path' $R0
  ${If} $R0 != 0
    MessageBox MB_ICONSTOP "Modus could not safely add its console command to your user PATH. The installation will stop without rewriting PATH."
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ExecWait '"$INSTDIR\modus.exe" --modus-installer-remove-user-path' $R0
  ${If} $R0 != 0
    MessageBox MB_ICONSTOP "Modus could not safely remove its console command from your user PATH. No files were removed; retry the uninstall."
    Abort
  ${EndIf}
!macroend
