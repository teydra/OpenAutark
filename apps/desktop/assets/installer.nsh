; Windows installer additions (electron-builder includes <buildResources>/installer.nsh).
; B-044 "Keep agents running": uninstalling removes the per-user launcher task (src/main/launcher-windows.ts:
; windowsTaskName – sign-in, crash/hang restart and due-work start in one task) and the sign-in entry of
; earlier versions (login item = the app user model id) – not during an update, where the task stays (the
; new version registers it again at its first start when its definition or path changed).
; Restart the installed executable directly. A kept Start-menu shortcut can point at an old
; location or be temporarily unresolved while the updater replaces the old installation.
; B-078: the icons of shortcuts and pins come from Autark.exe, which the update replaced; Explorer shows them blank until
; it reads them again, so the icon cache is refreshed once (ie4uinit -show takes well under a second).
; B-078: an update started by an older app (up to 0.3.2: the library's quitAndInstall with --force-run) gets its relaunch
; here, straight from the installer, not only through StartApp's ExecShellAsUser, which goes through Explorer at the
; moment Explorer rebuilds its icons. The start that comes second finds the running app and only shows it (the
; single-instance lock). From 0.3.3 on the relaunch helper runs the installer without --force-run and starts the app itself.
; Only for an install for the current user: that installer runs without elevation, so Exec starts the app as the
; person. An install for all users runs elevated; a plain Exec would start the app elevated too, so there StartApp's
; ExecShellAsUser (non-elevated, the person's own start) stays the only relaunch.
; Broker: hash-addressed ProgramFiles service, no service start/stop in the user updater.
; A legacy service (image in the app folder) is moved into the protected store before any file is replaced (one prompt).
; Interactive install/app launch reconciles the broker; silent protected updates defer reconciliation.
!macro customInstall
  StrCpy $launchLink "$appExe"
  !ifdef isForceRun & isUpdated
    ${If} ${isUpdated}
    ${AndIf} ${isForceRun}
    ${AndIf} $installMode != "all"
      Exec '"$appExe" --updated'
    ${EndIf}
  !endif
  ; ie4uinit.exe exists only as a 64-bit program: a 32-bit installer reaches it through Sysnative.
  ${If} ${FileExists} "$WINDIR\Sysnative\ie4uinit.exe"
    nsExec::Exec '"$WINDIR\Sysnative\ie4uinit.exe" -show'
    Pop $0
  ${ElseIf} ${FileExists} "$SYSDIR\ie4uinit.exe"
    nsExec::Exec '"$SYSDIR\ie4uinit.exe" -show'
    Pop $0
  ${EndIf}
  ; Reconcile changed broker bits explicitly with UAC; silent setup defers this to interactive app start.
  ${IfNot} ${Silent}
    !insertmacro brokerPowerShell $0
    ExecShellWait "" "$0" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\resources\app.asar.unpacked\resources\broker\install.ps1" -AppExe "$appExe"' SW_HIDE
  ${EndIf}
!macroend

; B-078: the check for a running app, fast and without PowerShell (electron-builder's default starts PowerShell and
; Get-CimInstance several times, in the installer and again in the old uninstaller, and sleeps between passes). One
; tasklist for this user's Autark.exe per pass, half a second between passes. With nothing left it goes on at once (the
; relaunch helper starts the installer only after the app ended). What is left:
;   update (--updated): the app may still be quitting by itself (electron-updater's own quitAndInstall, as on the hop
;     from 0.3.2 and on every helper fallback, starts the installer first and quits afterwards), so six passes of
;     waiting (passes 0-5, about 5 s with tasklist's own time), then a plain taskkill (close request, passes 6-7), then
;     taskkill /F;
;   install or uninstall with a window: one OK/Cancel box first (Cancel stops the setup), then a plain taskkill
;     (passes 0-1), then /F; a silent run without --updated skips the box.
; Eight passes after the first kill, a Retry/Cancel box; a silent update answers Cancel and leaves the old version.
; Other companies and the engines' Autark-as-node processes share the image name and end too, as before.
; The 64-bit PowerShell: the installer is a 32-bit program, whose $SYSDIR is SysWOW64, and a 32-bit install.ps1 would
; name "Program Files (x86)" as the broker's store, which the check below does not accept.
!macro brokerPowerShell _VAR
  ${If} ${FileExists} "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
    StrCpy ${_VAR} "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${Else}
    StrCpy ${_VAR} "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
!macroend

; A legacy broker service moved into the protected store by this package's own install.ps1 and broker, unpacked into
; the installer's temp folder (install.ps1 asks Windows for elevation itself, keeps the service's user and key, and puts
; the old image back when a step fails); $R0 is its exit code. The uninstaller carries no copy (it answers 2).
!ifmacrondef brokerMoveLegacy
!macro brokerMoveLegacy
  !ifdef BUILD_UNINSTALLER
    StrCpy $R0 2
  !else
    InitPluginsDir
    File "/oname=$PLUGINSDIR\install.ps1" "${PROJECT_DIR}\resources\broker\install.ps1"
    File "/oname=$PLUGINSDIR\AutarkDesktopBroker.exe" "${PROJECT_DIR}\resources\broker\AutarkDesktopBroker.exe"
    !insertmacro brokerPowerShell $R0
    nsExec::Exec '"$R0" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\install.ps1" -AppExe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
    Pop $R0
  !endif
!macroend
!endif

!macro customCheckAppRunning
  Push $R0
  Push $R1
  Push $R2
  ; The NEW setup carries this check. A legacy/unknown service is moved BEFORE file replacement (below); an image in
  ; the app tree is never started again.
  ; B-084 (0.3.5 release): read the service's ImagePath from the registry (no script host, so a PC without the broker
  ; updates as fast as before; resources/broker/preflight.ps1 holds the same rule for install.ps1). A service whose
  ; image is not under "<Program Files>\AutarkDesktopBroker\" is a legacy one.
  !ifndef BROKER_SERVICE_KEY
    !define BROKER_SERVICE_KEY "SYSTEM\CurrentControlSet\Services\AutarkDesktopBroker"
  !endif
  StrCpy $R0 0
  ReadRegStr $R1 HKLM "${BROKER_SERVICE_KEY}" "ImagePath"
  ${If} $R1 != ""
    StrCpy $R2 '"$PROGRAMFILES64\AutarkDesktopBroker\'
    StrLen $R0 $R2
    StrCpy $R1 $R1 $R0
    StrCpy $R0 0
    ${If} $R1 != $R2
      StrCpy $R0 2
    ${EndIf}
  ${EndIf}
  ; 14.11.2026: a legacy service (0.3.4 asked for it at start) runs its worker as SYSTEM from the app folder, which
  ; holds that file and restarts the worker when it is ended: no installer could replace the files ("cannot be closed"),
  ; and the person could not end it in Task Manager. The installer moves it itself, once, with one Windows prompt: this
  ; package's own install.ps1 and broker (brokerMoveLegacy) put it into the protected store under Program Files.
  ${DoWhile} $R0 != 0
    !insertmacro brokerMoveLegacy
    ReadRegStr $R1 HKLM "${BROKER_SERVICE_KEY}" "ImagePath"
    StrCpy $R2 '"$PROGRAMFILES64\AutarkDesktopBroker\'
    StrLen $R0 $R2
    StrCpy $R1 $R1 $R0
    StrCpy $R0 0
    ${If} $R1 != $R2
      StrCpy $R0 2
      StrCpy $R1 cancel
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${PRODUCT_NAME}'s desktop helper still runs from the app folder, so its files cannot be replaced. Click Retry and allow the Windows prompt to move it." /SD IDCANCEL IDCANCEL +2
      StrCpy $R1 retry
      ${If} $R1 == cancel
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${EndIf}
  ${Loop}
  StrCpy $R1 0
  StrCpy $R2 0
  ${If} ${isUpdated}
    StrCpy $R2 6
  ${EndIf}
  ${Do}
    !ifdef INSTALL_MODE_PER_ALL_USERS
      nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    !else
      nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    !endif
    Pop $R0
    ${If} $R0 != 0
      ${Break}
    ${EndIf}
    ${If} $R1 == 0
    ${AndIfNot} ${isUpdated}
    ${AndIfNot} ${Silent}
      StrCpy $R0 cancel
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION `${PRODUCT_NAME} is running. Click OK to close it and go on.` /SD IDOK IDCANCEL +2
      StrCpy $R0 ok
      ${If} $R0 == cancel
        Quit
      ${EndIf}
    ${EndIf}
    IntOp $R0 $R2 + 8
    ${If} $R1 >= $R0
      ; Still running (another user's elevated start, say): a silent update stops here and leaves the old version in
      ; place, which the relaunch helper then starts again; with a window the person can close it and retry.
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION `${PRODUCT_NAME} is still running. Close it, then click Retry.` /SD IDCANCEL IDRETRY +2
      Quit
      StrCpy $R1 $R2
    ${EndIf}
    IntOp $R0 $R2 + 2
    ${If} $R1 < $R2
      ; an update's app is still quitting by itself: only wait
    ${ElseIf} $R1 < $R0
      !ifdef INSTALL_MODE_PER_ALL_USERS
        nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /IM "${APP_EXECUTABLE_FILENAME}"`
      !else
        nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
      !endif
      Pop $R0
    ${Else}
      !ifdef INSTALL_MODE_PER_ALL_USERS
        nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"`
      !else
        nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
      !endif
      Pop $R0
    ${EndIf}
    Sleep 500
    IntOp $R1 $R1 + 1
  ${Loop}
  ; 0.3.22: the slim native wake helper (resources\broker\AutarkWakeHelper.exe, in the app folder) is no Autark.exe: it would hold
  ; its own file (the broker's supervisor starts it again only once no installer runs) – it is only a waiting listener, so no
  ; close request, a plain kill; nothing to wait for when none runs (taskkill's exit code is ignored).
  !ifdef INSTALL_MODE_PER_ALL_USERS
    nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /IM "AutarkWakeHelper.exe"`
  !else
    nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /IM "AutarkWakeHelper.exe" /FI "USERNAME eq %USERNAME%"`
  !endif
  Pop $R0
  Sleep 300
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

; The product's rename: an install in a folder named after the old product goes to the new folder, in the same place.
; Same appId, so the same GUID: the old uninstaller still runs from the registry's InstallLocation and removes the old
; folder and its shortcuts (no exe under the new name there, so no shortcut is kept), and one uninstall entry and one
; shortcut result. With the old product name still in place this resolves to the same folder.
; Silent update: customInit is enough (it runs after initMultiUser and the /D parameter). An installer with pages sets
; $INSTDIR from the registry again when the install-mode page is left, and instFilesPre would then nest the new name
; inside the old folder, so a page without a window sets it once more after the directory page.
!macro identityFolder
  Push $R0
  Push $R1
  ${GetFileName} "$INSTDIR" $R0
  ${If} $R0 == "Proactive Agent Workforce"
    ${GetParent} "$INSTDIR" $R1
    StrCpy $INSTDIR "$R1\${APP_FILENAME}"
  ${EndIf}
  Pop $R1
  Pop $R0
!macroend

!macro customInit
  !insertmacro identityFolder
!macroend

!macro customPageAfterChangeDir
  Page custom identityFolderPage
  Function identityFolderPage
    !insertmacro identityFolder
    Abort
  FunctionEnd
!macroend

; B-072: every other company (a folder in "<product> Companies" beside the first one's data, always the user's own
; %APPDATA%, also for an install for all users) has its own task "<product> <id> Launcher (<user>)".
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; Remove the service before app files disappear. Silent uninstall cannot answer a required UAC prompt.
    nsExec::Exec '"$SYSDIR\sc.exe" query AutarkDesktopBroker'
    Pop $0
    ${If} $0 == 0
      ${If} ${Silent}
        SetErrorLevel 2
        Quit
      ${EndIf}
      !insertmacro brokerPowerShell $0
      nsExec::Exec '"$0" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\resources\app.asar.unpacked\resources\broker\install.ps1" -Uninstall'
      Pop $0
      ${If} $0 != 0
        MessageBox MB_OK|MB_ICONEXCLAMATION "Desktop broker removal failed or was cancelled. App files are retained."
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${ElseIf} $0 != 1060
      ; sc query returns 1060 when absent; unknown state is not evidence of absence.
      SetErrorLevel 2
      Quit
    ${EndIf}
    ExpandEnvStrings $0 "%USERNAME%"
    nsExec::Exec 'schtasks /Delete /TN "${PRODUCT_NAME} Launcher ($0)" /F'
    Pop $1
    ExpandEnvStrings $1 "%APPDATA%\${PRODUCT_NAME} Companies"
    FindFirst $2 $3 "$1\*"
    ${DoWhile} $3 != ""
      ${If} $3 != "."
      ${AndIf} $3 != ".."
      ${AndIf} ${FileExists} "$1\$3\*.*"
        nsExec::Exec 'schtasks /Delete /TN "${PRODUCT_NAME} $3 Launcher ($0)" /F'
        Pop $4
      ${EndIf}
      FindNext $2 $3
    ${Loop}
    FindClose $2
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.teydralab.workforce"
  ${endIf}
!macroend
