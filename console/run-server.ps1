# Supervisor for the Seat Console: the scheduled task's action. Runs node.exe in its OWN hidden console (cmd.exe wrapper,
# output appended to server.log as UTF-8) and starts it again whenever it exits, whatever the exit code.
# Why its own console: the old action ran node inside this powershell's console; a console control event (Ctrl-C / close)
# ended the shared console and the task finished with 0xC000013A and never came back.
# At most $MaxPerMinute starts per minute (a crash loop sleeps 30 s instead of spinning); every start/exit goes to supervisor.log.
param([int]$MaxPerMinute = 6, [int]$Port = 4850)
$dir  = $PSScriptRoot
$node = if (Get-Command node -ErrorAction SilentlyContinue) { (Get-Command node).Source } else { 'C:\Program Files\nodejs\node.exe' }
$sup  = Join-Path $dir 'supervisor.log'
function Write-Sup([string]$msg) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -Append -Encoding utf8 -FilePath $sup }
$starts = New-Object System.Collections.Generic.List[datetime]
Write-Sup "supervisor up pid=$PID node=$node"
while ($true) {
    $starts.RemoveAll({ param($t) ((Get-Date) - $t).TotalSeconds -gt 60 }) | Out-Null
    if ($starts.Count -ge $MaxPerMinute) { Write-Sup "restart limit ($MaxPerMinute/min) hit, waiting 30 s"; Start-Sleep -Seconds 30; continue }
    # Another console already owns the port (a manual start, a node that outlived its supervisor): a new node would only find that out and exit, over and over. Wait instead.
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { Write-Sup "port $Port is in use by another process, waiting 30 s"; Start-Sleep -Seconds 30; continue }
    $starts.Add((Get-Date))
    $t0 = Get-Date
    # /s strips the outer quotes, so the paths inside may contain spaces; >> appends raw node output (UTF-8)
    $cmd = "/d /s /c `"`"$node`" `"$dir\server.mjs`" >> `"$dir\server.log`" 2>&1`""
    $p = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList $cmd -WorkingDirectory $dir -WindowStyle Hidden -PassThru
    Write-Sup "started cmd pid=$($p.Id)"
    $p.WaitForExit()
    Write-Sup ("node exited code={0} after {1:N0}s, restarting in 3 s" -f $p.ExitCode, ((Get-Date) - $t0).TotalSeconds)
    Start-Sleep -Seconds 3
}
