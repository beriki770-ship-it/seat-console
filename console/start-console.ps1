# Open the Seat Console. Idempotent: if the server answers, just open the browser;
# if the port is held by a hung/dead process, kill it and start fresh.
param([switch]$NoBrowser)
$Port = 4850
function Test-Up { try { (Invoke-WebRequest "http://127.0.0.1:$Port/api/seats" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { $false } }
# A server that is still starting (reattaching conversations) answers 503 for a while: that is not a hung server. Only a port that stays dead for 25 s, with no
# supervisor start in the last 60 s, is treated as held by a dead process.
function Recent-Start { try { $l = Get-Content "$PSScriptRoot\supervisor.log" -Tail 20 | Where-Object { $_ -match 'started cmd' } | Select-Object -Last 1; $t = [datetime]::ParseExact($l.Substring(0, 19), 'yyyy-MM-dd HH:mm:ss', $null); ((Get-Date) - $t).TotalSeconds -lt 60 } catch { $false } }
# /health answers 503 {ready:false} while the server is still reattaching conversations: that is "starting", never "hung", and must never be killed.
function Starting { try { Invoke-WebRequest "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 3 | Out-Null; $false } catch { $r = $_.Exception.Response; [bool]($r -and [int]$r.StatusCode -eq 503) } }
$t0 = Get-Date
function Waiting { [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) -or (Recent-Start) }  # nothing listening and no recent start: nothing to wait for
while (-not (Test-Up) -and ((Starting) -or ((Waiting) -and (((Get-Date) - $t0).TotalSeconds -lt 25 -or (Recent-Start)))) -and ((Get-Date) - $t0).TotalSeconds -lt 180) { Start-Sleep -Seconds 3 }
if (-not (Test-Up) -and -not (Starting)) {
    $held = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($h in $held) { Stop-Process -Id $h.OwningProcess -Force -ErrorAction SilentlyContinue }
    if ($held) { Start-Sleep -Seconds 1 }
    # Output is APPENDED by cmd's >> (as the supervisor does): the server rotates server.log by copy-truncate, and a handle that is not append-mode (-RedirectStandardOutput)
    # would keep writing at its old offset after the truncate and fill the file with NUL bytes.
    $cmd = "/d /s /c `"`"$((Get-Command node).Source)`" `"$PSScriptRoot\server.mjs`" >> `"$PSScriptRoot\server.log`" 2>&1`""
    Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList $cmd -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
    for ($i = 0; $i -lt 25 -and -not (Test-Up); $i++) { Start-Sleep -Milliseconds 400 }
}
if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$Port" }
