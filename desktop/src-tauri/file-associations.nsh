; Offer Modus in Open with without writing extension defaults or UserChoice.
; Tauri's APP_ASSOCIATE macro writes the extension default, so Windows disables
; its generated associations and owns this additive registration instead.

!macro MODUS_REGISTER_FILE_TYPE EXT PROGID
  WriteRegStr HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}" ""
!macroend

!macro MODUS_REGISTER_FILE_ASSOCIATIONS
  WriteRegStr HKCU "Software\Classes\Modus.Markdown" "" "Markdown document"
  WriteRegStr HKCU "Software\Classes\Modus.Markdown\DefaultIcon" "" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\Modus.Markdown\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Modus.Text" "" "Text document"
  WriteRegStr HKCU "Software\Classes\Modus.Text\DefaultIcon" "" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\Modus.Text\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  !insertmacro MODUS_REGISTER_FILE_TYPE "md" "Modus.Markdown"
  !insertmacro MODUS_REGISTER_FILE_TYPE "markdown" "Modus.Markdown"
  !insertmacro MODUS_REGISTER_FILE_TYPE "txt" "Modus.Text"
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".md" ""
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".markdown" ""
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".txt" ""
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro MODUS_UNREGISTER_FILE_ASSOCIATIONS
  StrCpy $R1 '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  ReadRegStr $R0 HKCU "Software\Classes\Modus.Markdown\shell\open\command" ""
  ${If} $R0 == $R1
    DeleteRegValue HKCU "Software\Classes\.md\OpenWithProgids" "Modus.Markdown"
    DeleteRegValue HKCU "Software\Classes\.markdown\OpenWithProgids" "Modus.Markdown"
    DeleteRegKey HKCU "Software\Classes\Modus.Markdown"
  ${EndIf}
  ReadRegStr $R0 HKCU "Software\Classes\Modus.Text\shell\open\command" ""
  ${If} $R0 == $R1
    DeleteRegValue HKCU "Software\Classes\.txt\OpenWithProgids" "Modus.Text"
    DeleteRegKey HKCU "Software\Classes\Modus.Text"
  ${EndIf}
  ReadRegStr $R0 HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" ""
  ${If} $R0 == $R1
    DeleteRegKey HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  ${EndIf}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
