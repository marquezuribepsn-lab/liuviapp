' Acceso directo antiguo: abre la aplicacion de Liu Vi (la ventana propia). Los accesos directos nuevos abren shell\LiuVi.exe directamente.
Option Explicit
Dim sh, fso, dir, exe
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
exe = dir & "\shell\LiuVi.exe"
If Not fso.FileExists(exe) Then
  MsgBox "No se encontro la aplicacion de Liu Vi (" & exe & "). Volve a ejecutar el instalador.", 16, "Liu Vi"
  WScript.Quit 1
End If
sh.CurrentDirectory = dir
sh.Run Chr(34) & exe & Chr(34), 1, False
