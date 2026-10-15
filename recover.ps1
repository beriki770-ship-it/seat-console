# Crash recovery for the Seat Console: make sure it is up, list every conversation it marked `interrupted`, and send each
# one the approved "continue" text (tasks\recover-continue.txt) so the seat picks up from its own session.
#   recover.ps1 [-DryRun] [-Seat ops]
# -DryRun lists only; -Seat limits it to one seat. Exit codes: 0 ok, 2 console unreachable, 3 some conversation could not be resumed.
param([switch]$DryRun, [string]$Seat)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$api  = 'http://127.0.0.1:4850/api/seats'
function Get-Seats { try { Invoke-RestMethod $api -UseBasicParsing -TimeoutSec 4 } catch { $null } }

$seats = Get-Seats
if (-not $seats) {
    Write-Host 'Console is down, starting the "Seat Console" task...'
    try { Start-ScheduledTask -TaskName 'Seat Console' } catch { & "$root\console\start-console.ps1" -NoBrowser }
    for ($i = 0; $i -lt 60 -and -not $seats; $i++) { Start-Sleep -Seconds 1; $seats = Get-Seats }
}
if (-not $seats) { Write-Host 'Seat Console did not answer on port 4850 within 60 s.'; exit 2 }

$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$rows = @(foreach ($s in $seats) { if ($Seat -and $s.name -ne $Seat) { continue }
    foreach ($c in $s.conversations) { if ($c.status -eq 'interrupted' -and -not $c.archived) {
        $mins = [int][Math]::Max(0, ($now - $c.updatedAt) / 60000)
        [pscustomobject]@{ Seat = $s.name; Title = $c.title; Age = $(if ($mins -lt 60) { "$mins min" } else { '{0:N1} h' -f ($mins / 60) }); Id = $c.id; Result = $(if ($DryRun) { 'not resumed (dry run)' } else { '' }) } } } })

if (-not $rows) { Write-Host "No interrupted conversations$(if ($Seat) { " on $Seat" })."; exit 0 }
$failed = 0
if (-not $DryRun) {
    foreach ($r in $rows) {
        try { & "$root\console\send.ps1" -Seat $r.Seat -TextFile "$root\tasks\recover-continue.txt" -Conversation $r.Id | Out-Null; $r.Result = 'resumed' }
        catch { $failed++; $r.Result = 'FAILED: ' + ($_.Exception.Message -replace '\s+', ' ') }
    }
}
$rows | Format-Table Seat, Title, Age, Result -AutoSize -Wrap | Out-String | Write-Host
if ($failed) { exit 3 }
