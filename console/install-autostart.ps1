# Register the "Seat Console" scheduled task under the current user (no admin needed): action = run-server.ps1, a
# supervisor that restarts node whenever it exits; triggers = at logon + a 5-minute repeat (IgnoreNew while it runs, so it
# only matters if the supervisor itself ever died); the task's own restart-on-failure stays on as a second net.
# Also creates the Start Menu + Desktop shortcuts and the Start Menu "Seat Console - Recover" shortcut.
$ErrorActionPreference = 'Stop'
$dir  = $PSScriptRoot
$action   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$dir\run-server.ps1`"" -WorkingDirectory $dir
$trigger  = @((New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME), (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)))
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
try {
    Register-ScheduledTask -TaskName 'Seat Console' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Get-ScheduledTask 'Seat Console' | Select-Object TaskName, State | Format-Table | Out-String | Write-Host
} catch {
    Write-Host "Task registration needs elevation. Run this once in an ADMIN PowerShell:`n  powershell -ExecutionPolicy Bypass -File `"$dir\install-autostart.ps1`""
}
$ws = New-Object -ComObject WScript.Shell
foreach ($lnk in @("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Seat Console.lnk", "$env:USERPROFILE\Desktop\Seat Console.lnk")) {
    $s = $ws.CreateShortcut($lnk)
    $s.TargetPath = 'powershell.exe'
    $s.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$dir\start-console.ps1`""
    $s.WorkingDirectory = $dir
    $s.Save()
}
# Visible window (-NoExit) so the result table of recover.ps1 can be read.
$s = $ws.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Seat Console - Recover.lnk")
$s.TargetPath = 'powershell.exe'
$s.Arguments = "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$(Split-Path $dir)\recover.ps1`""
$s.WorkingDirectory = Split-Path $dir
$s.Save()
