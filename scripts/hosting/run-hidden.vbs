' run-hidden.vbs - start the hosting loop without any visible console window.
' Usage: wscript.exe //B //Nologo run-hidden.vbs
Dim sh, cmd
Set sh = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & _
      "G:\Agent-workspace\dsh-superagent\scripts\hosting\start-all.ps1"" -Port 3082 -Hidden"
' 0 = hidden window, False = do not wait
sh.Run cmd, 0, False
