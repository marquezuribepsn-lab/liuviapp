' Abre Liu Vi sin ventana negra: arranca el sistema en segundo plano y abre su ventana.
Option Explicit
Dim sh, fso, dir, datos, q, node
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
With sh.Environment("Process")
  .Item("LIUVI_OPEN") = "1"
  .Item("LIUVI_APP_WINDOW") = "1"
  .Item("LIUVI_SILENT") = "1"
  .Item("LIUVI_UPDATE") = "1"
  .Item("LIUVI_LOGFILE") = datos & "\liuvi.log"
End With
sh.CurrentDirectory = dir
sh.Run "cmd /c " & q & q & node & q & " --disable-warning=ExperimentalWarning server.js >> " & q & datos & "\liuvi.log" & q & " 2>&1" & q, 0, False
