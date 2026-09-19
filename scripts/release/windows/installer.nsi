Unicode True

!ifndef STAGE_DIR
  !error "STAGE_DIR is required"
!endif
!ifndef OUT_FILE
  !error "OUT_FILE is required"
!endif
!ifndef APP_VERSION
  !define APP_VERSION "0.0.0"
!endif

Name "Concat"
Caption "Concat ${APP_VERSION} Setup"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Concat"
InstallDirRegKey HKCU "Software\Concat" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Concat" SEC_CONCAT
  SetOutPath "$INSTDIR"
  File /r "${STAGE_DIR}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\Concat"
  CreateShortcut "$SMPROGRAMS\Concat\Concat.lnk" "$INSTDIR\concat.exe"
  CreateShortcut "$DESKTOP\Concat.lnk" "$INSTDIR\concat.exe"

  WriteRegStr HKCU "Software\Concat" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Concat" "DisplayName" "Concat"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Concat" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Concat" "Publisher" "Concat"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Concat" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Concat" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Concat" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\Concat.lnk"
  Delete "$SMPROGRAMS\Concat\Concat.lnk"
  RMDir "$SMPROGRAMS\Concat"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Concat"
  DeleteRegKey HKCU "Software\Concat"
  RMDir /r "$INSTDIR"
SectionEnd
