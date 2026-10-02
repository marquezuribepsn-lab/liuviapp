' Abre Liu Vi sin ventana negra: arranca el sistema en segundo plano y abre su ventana.
Option Explicit
Dim sh, fso, dir, datos, q, node, port, pidFile, pid
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
datos = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\LiuVi"
If Not fso.FolderExists(datos) Then fso.CreateFolder datos
node = dir & "\runtime\node.exe"
If Not fso.FileExists(node) Then
  MsgBox "No se encontro el motor de Liu Vi (" & node & "). Volve a instalar el programa.", 16, "Liu Vi"
  WScript.Quit 1
End If
q = Chr(34)
port = sh.ExpandEnvironmentStrings("%PORT%")
If Not IsNumeric(port) Then port = "3000"
pidFile = datos & "\liuvi.pid"

' ¿Liu Vi ya esta andando en segundo plano? (al cerrar la ventana el sistema sigue corriendo)
Function Vivo()
  Dim h
  Vivo = False
  On Error Resume Next
  Set h = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  h.setTimeouts 2000, 2000, 4000, 6000
  h.open "GET", "http://127.0.0.1:" & port & "/api/auth/me", False
  h.send
  If Err.Number = 0 Then
    If h.status = 200 Then
      If InStr(h.responseText, "setupNeeded") > 0 Then Vivo = True
    End If
  End If
  On Error GoTo 0
End Function

' Abre la ventana propia (Edge o Chrome en modo aplicacion); si no hay, el navegador de siempre.
Sub AbrirVentana()
  Dim roots, rels, r, e, exe, url
  url = "http://localhost:" & port
  roots = Array(sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%"), sh.ExpandEnvironmentStrings("%ProgramFiles%"), sh.ExpandEnvironmentStrings("%LOCALAPPDATA%"))
  rels = Array("\Microsoft\Edge\Application\msedge.exe", "\Google\Chrome\Application\chrome.exe")
  For Each e In rels
    For Each r In roots
      exe = r & e
      If InStr(r, "%") = 0 Then
        If fso.FileExists(exe) Then
          sh.Run q & exe & q & " --app=" & url & " --window-size=1366,820", 1, False
          Exit Sub
        End If
      End If
    Next
  Next
  sh.Run "cmd /c start " & q & q & " " & url, 0, False
End Sub

If Vivo() Then
  AbrirVentana
  WScript.Quit 0
End If

' No responde: si quedo un proceso viejo trabado, se lo cierra para empezar limpio.
If fso.FileExists(pidFile) Then
  On Error Resume Next
  pid = Trim(fso.OpenTextFile(pidFile, 1).ReadAll)
  If IsNumeric(pid) Then sh.Run "taskkill /F /PID " & CLng(pid) & " /FI " & q & "IMAGENAME eq node.exe" & q, 0, True
  fso.DeleteFile pidFile, True
  On Error GoTo 0
End If

With sh.Environment("Process")
  .Item("LIUVI_OPEN") = "1"
  .Item("LIUVI_APP_WINDOW") = "1"
  .Item("LIUVI_SILENT") = "1"
  .Item("LIUVI_UPDATE") = "1"
  .Item("LIUVI_AUTOEXIT") = "1"
  .Item("LIUVI_LOGFILE") = datos & "\liuvi.log"
End With
sh.CurrentDirectory = dir
sh.Run "cmd /c " & q & q & node & q & " --disable-warning=ExperimentalWarning server.js >> " & q & datos & "\liuvi.log" & q & " 2>&1" & q, 0, False
