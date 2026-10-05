Unicode True
; Instalador de Liu Vi (Windows). Se compila con build.sh; no hace falta tener nada instalado para usarlo.
!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef STAGE
  !error "Falta STAGE (carpeta con los archivos a instalar)"
!endif
!ifndef OUTFILE
  !define OUTFILE "Liu-Vi-Setup.exe"
!endif
!ifndef ASSETS
  !define ASSETS "assets"
!endif

!ifndef ELECTRON_VERSION
  !define ELECTRON_VERSION "0"
  !define ELECTRON_URL ""
  !define ELECTRON_SHA ""
  !define ELECTRON_MB "115"
  !define SHELL_PS1 "get-shell.ps1"
  !define RCEDIT "rcedit-x64.exe"
!endif

!define APP "Liu Vi"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\LiuVi"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

Name "${APP}"
OutFile "${OUTFILE}"
; Por usuario: no pide permisos de administrador. Los datos están aparte (%LOCALAPPDATA%\LiuVi), así que actualizar o desinstalar no los toca.
InstallDir "$LOCALAPPDATA\Programs\Liu Vi"
InstallDirRegKey HKCU "Software\LiuVi" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "Liu Vi v${VERSION}"
ShowInstDetails show
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=3082 "ProductName" "Liu Vi"
VIAddVersionKey /LANG=3082 "FileDescription" "Instalador de Liu Vi"
VIAddVersionKey /LANG=3082 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=3082 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=3082 "LegalCopyright" "Liu Vi"

!define MUI_ICON "${ASSETS}\liuvi.ico"
!define MUI_UNICON "${ASSETS}\liuvi.ico"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${ASSETS}\welcome.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${ASSETS}\welcome.bmp"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "${ASSETS}\header.bmp"
!define MUI_HEADERIMAGE_UNBITMAP "${ASSETS}\header.bmp"
!define MUI_ABORTWARNING

!define MUI_WELCOMEPAGE_TITLE "Bienvenido al instalador de Liu Vi"
!define MUI_WELCOMEPAGE_TEXT "Este asistente instala Liu Vi ${VERSION}, el sistema de ventas, stock y caja de tu local.$\r$\n$\r$\nTus datos (artículos, ventas, usuarios) se guardan aparte del programa: si ya tenías Liu Vi instalado, se conservan al actualizar.$\r$\n$\r$\nHacé clic en Siguiente para continuar."
!define MUI_COMPONENTSPAGE_TEXT_TOP "Elegí qué querés instalar."
!define MUI_FINISHPAGE_TITLE "Liu Vi quedó instalado"
!define MUI_FINISHPAGE_TEXT "Ya podés usar Liu Vi desde el acceso directo del escritorio o del menú Inicio.$\r$\n$\r$\nLa primera vez te va a pedir crear el usuario administrador."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Abrir Liu Vi ahora"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!define MUI_UNCONFIRMPAGE_TEXT_TOP "Se va a quitar Liu Vi de esta computadora. Tus datos no se borran salvo que lo pidas en el último paso."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "SpanishInternational"

Function LaunchApp
  SetOutPath "$INSTDIR"
  Exec '"$INSTDIR\shell\LiuVi.exe"'
FunctionEnd

; Le pone al .exe de la ventana el ícono y el nombre de Liu Vi (la barra de tareas y el administrador de tareas usan los del .exe).
Function BrandShell
  File "/oname=$PLUGINSDIR\rcedit.exe" "${RCEDIT}"
  nsExec::ExecToLog '"$PLUGINSDIR\rcedit.exe" "$INSTDIR\shell\LiuVi.exe" --set-icon "$INSTDIR\liuvi.ico" --set-version-string "ProductName" "Liu Vi" --set-version-string "FileDescription" "Liu Vi" --set-version-string "InternalName" "LiuVi" --set-version-string "OriginalFilename" "LiuVi.exe" --set-version-string "CompanyName" "Liu Vi" --set-version-string "LegalCopyright" "Liu Vi"'
  Pop $0
  DetailPrint "Ícono de Liu Vi: código $0"
FunctionEnd

; Descarga la ventana de Liu Vi (Electron, ~${ELECTRON_MB} MB). Sin ella no se instala: nunca se abre en un navegador.
Function InstallShell
  InitPluginsDir
  ${If} ${FileExists} "$INSTDIR\shell\LiuVi.exe"
  ${AndIf} ${FileExists} "$INSTDIR\shell\electron-${ELECTRON_VERSION}.txt"
    Call BrandShell ; ya está instalada esta versión
    Return
  ${EndIf}
  File "/oname=$PLUGINSDIR\get-shell.ps1" "${SHELL_PS1}"
  DetailPrint "Descargando la ventana de Liu Vi (unos ${ELECTRON_MB} MB; hace falta internet). Puede tardar unos minutos..."
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\get-shell.ps1" -Url "${ELECTRON_URL}" -Sha "${ELECTRON_SHA}" -Dest "$INSTDIR\shell"'
  Pop $0
  ${If} $0 == "0"
  ${AndIf} ${FileExists} "$INSTDIR\shell\electron.exe"
    Rename "$INSTDIR\shell\electron.exe" "$INSTDIR\shell\LiuVi.exe"
    Delete "$INSTDIR\shell\resources\default_app.asar"
    FileOpen $1 "$INSTDIR\shell\electron-${ELECTRON_VERSION}.txt" w
    FileWrite $1 "${ELECTRON_VERSION}"
    FileClose $1
    Call BrandShell
    DetailPrint "La ventana de Liu Vi quedó instalada."
  ${Else}
    RMDir /r "$INSTDIR\shell"
    DetailPrint "No se pudo descargar la ventana de Liu Vi (código $0)."
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "No se pudo descargar la ventana de Liu Vi.$\r$\n$\r$\nHace falta internet solo durante la instalación (unos ${ELECTRON_MB} MB). Revisá la conexión y volvé a ejecutar este instalador: tus datos no se tocaron."
    ${EndIf}
    Abort "No se pudo descargar la ventana de Liu Vi. Revisá la conexión a internet y volvé a ejecutar el instalador."
  ${EndIf}
FunctionEnd

; Si Liu Vi está abierto (por ejemplo al actualizar) hay que cerrarlo antes de reemplazar sus archivos.
Function StopRunning
  ${If} ${FileExists} "$INSTDIR\detener.vbs"
    ExecWait '"$SYSDIR\wscript.exe" //B "$INSTDIR\detener.vbs" silencio'
    Sleep 1500
  ${EndIf}
FunctionEnd

Section "Liu Vi (programa)" SecMain
  SectionIn RO
  Call StopRunning
  SetOutPath "$INSTDIR"
  ; Una ventana de otra versión se reemplaza entera (se vuelve a descargar).
  ${IfNot} ${FileExists} "$INSTDIR\shell\electron-${ELECTRON_VERSION}.txt"
    RMDir /r "$INSTDIR\shell"
  ${EndIf}
  File /r "${STAGE}\*.*"
  File "${ASSETS}\liuvi.ico"
  Call InstallShell
  WriteUninstaller "$INSTDIR\desinstalar.exe"

  CreateDirectory "$SMPROGRAMS\Liu Vi"
  CreateShortcut "$SMPROGRAMS\Liu Vi\Liu Vi.lnk" "$INSTDIR\shell\LiuVi.exe" "" "$INSTDIR\liuvi.ico"
  CreateShortcut "$SMPROGRAMS\Liu Vi\Cerrar Liu Vi.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\detener.vbs"' "$INSTDIR\liuvi.ico"
  CreateShortcut "$SMPROGRAMS\Liu Vi\Desinstalar Liu Vi.lnk" "$INSTDIR\desinstalar.exe"

  WriteRegStr HKCU "Software\LiuVi" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "Liu Vi"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Liu Vi"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\liuvi.ico"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\desinstalar.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "Acceso directo en el escritorio" SecDesktop
  SetOutPath "$INSTDIR"
  CreateShortcut "$DESKTOP\Liu Vi.lnk" "$INSTDIR\shell\LiuVi.exe" "" "$INSTDIR\liuvi.ico"
SectionEnd

Section /o "Abrir Liu Vi automáticamente al encender Windows" SecStartup
  SetOutPath "$INSTDIR"
  CreateShortcut "$SMSTARTUP\Liu Vi.lnk" "$INSTDIR\shell\LiuVi.exe" "" "$INSTDIR\liuvi.ico"
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} "El programa y todo lo que necesita para funcionar (no hace falta instalar nada más)."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "Un icono de Liu Vi en el escritorio."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecStartup} "Liu Vi se abre solo cada vez que prendés la computadora."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  ExecWait '"$SYSDIR\wscript.exe" //B "$INSTDIR\detener.vbs" silencio'
  Sleep 1500
  Delete "$DESKTOP\Liu Vi.lnk"
  Delete "$SMSTARTUP\Liu Vi.lnk"
  RMDir /r "$SMPROGRAMS\Liu Vi"
  ; Solo se borra lo que instaló este programa (nunca la carpeta entera: podría ser una carpeta con otros archivos).
  RMDir /r "$INSTDIR\shell"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\public"
  RMDir /r "$INSTDIR\scripts"
  RMDir /r "$INSTDIR\ejemplos"
  Delete "$INSTDIR\*.js"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\*.md"
  Delete "$INSTDIR\*.vbs"
  Delete "$INSTDIR\*.ico"
  Delete "$INSTDIR\desinstalar.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\LiuVi"
  ; Los datos solo se borran si lo pedís expresamente (y nunca en una desinstalación silenciosa).
  ${IfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "¿Querés borrar también TUS DATOS (artículos, ventas, usuarios y las copias guardadas en esta computadora)?$\r$\n$\r$\nSi vas a volver a instalar Liu Vi, elegí NO: así lo encontrás todo como lo dejaste.$\r$\nEsto no se puede deshacer." IDNO keepdata
    RMDir /r "$LOCALAPPDATA\LiuVi"
    keepdata:
  ${EndIf}
SectionEnd
