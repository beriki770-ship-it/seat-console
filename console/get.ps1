# Show a conversation's status and its last result: get.ps1 -Conversation <id> [-Wait] [-TimeoutSec 1800]
# -Wait polls until the conversation is idle / error / stopped, then prints the final result text (an open
# approval request keeps it waiting: answer it in the console or from Telegram).
param([Parameter(Mandatory)][string]$Conversation, [switch]$Wait, [int]$TimeoutSec = 1800)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8   # Hebrew results survive PowerShell 5.1's console
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ($true) {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:4850/api/conversation?id=$Conversation"
    $status = $r.conv.status
    if (-not $Wait -or $status -in 'idle', 'error', 'stopped', 'interrupted') { break }
    if ((Get-Date) -gt $deadline) { Write-Output "status: $status (timed out after $TimeoutSec s)"; exit 2 }
    Start-Sleep -Seconds 3
}
# Only a result that came after the last user message belongs to the current turn.
$lastUser = -1; $lastResult = $null
for ($i = 0; $i -lt $r.events.Count; $i++) {
    if ($r.events[$i].type -eq 'console_user') { $lastUser = $i; $lastResult = $null }
    elseif ($r.events[$i].type -eq 'result') { $lastResult = $r.events[$i] }
}
Write-Output "conversation: $Conversation"
Write-Output "seat: $($r.conv.seat)  title: $($r.conv.title)"
Write-Output "status: $status"
if ($lastResult) { Write-Output 'result:'; Write-Output $lastResult.result } else { Write-Output 'result: (none yet)' }
if ($status -eq 'error') { exit 1 }
