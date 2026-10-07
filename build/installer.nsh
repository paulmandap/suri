; Suri's uninstall step (ADR-031). electron-builder includes this file by
; itself (build/installer.nsh). Before the uninstaller deletes the app, and
; after it has closed a running Suri, it runs `suri.exe --uninstall` and waits:
; a small window where the user decides about Claude Code's hooks (shown as a
; diff, removed only on a click) and about Suri's data. Skipped for an update
; (the new version still needs both) and for a silent uninstall (/S), where
; nobody is there to ask.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/S" $R1
    ${if} ${Errors}
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall'
    ${endIf}
  ${endIf}
!macroend
