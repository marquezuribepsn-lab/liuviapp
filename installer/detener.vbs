' Cierra Liu Vi (el sistema que corre en segundo plano). Con el parametro "silencio" no muestra mensajes.
Option Explicit
Dim sh, fso, pidFile, pid, quiet, msg
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
quiet = (WScript.Arguments.Count > 0)
pidFile = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\LiuVi\liuvi.pid"
msg = "Liu Vi no estaba abierto."
If fso.FileExists(pidFile) Then
  pid = Trim(fso.OpenTextFile(pidFile, 1).ReadAll)
  If IsNumeric(pid) Then
    ' Solo se cierra si ese proceso es de verdad node.exe (el numero pudo reutilizarse).
    sh.Run "taskkill /F /PID " & CLng(pid) & " /FI " & Chr(34) & "IMAGENAME eq node.exe" & Chr(34), 0, True
    msg = "Liu Vi se cerro. Tus datos estan guardados."
  End If
  On Error Resume Next
  fso.DeleteFile pidFile, True
End If
If Not quiet Then MsgBox msg, 64, "Liu Vi"
