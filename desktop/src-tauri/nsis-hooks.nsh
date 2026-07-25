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
