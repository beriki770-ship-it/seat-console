# Send a task to a seat through the running console:
#   send.ps1 -Seat ops -TextFile task.txt [-Model claude-haiku-4-5] [-Effort low|medium|high|xhigh|max|ultracode] [-Mode auto|ask|bypass] [-Cwd <dir>] [-Conversation <id>] [-Wait] [-TimeoutSec 1800]
# Without -Conversation a NEW conversation starts. Prints "conversationId: <id>"; with -Wait it then blocks
# until the turn is done and prints the final result text (via get.ps1). Model takes a full id.
# The text goes in a UTF-8 file so Hebrew survives PowerShell 5.1's console encoding.
param([Parameter(Mandatory)][string]$Seat, [Parameter(Mandatory)][string]$TextFile, [string]$Model, [string]$Effort, [string]$Cwd, [string]$Mode, [string]$Conversation, [switch]$Wait, [int]$TimeoutSec = 1800)
$ErrorActionPreference = 'Stop'
$token = (Get-Content "$PSScriptRoot\token.txt" -Raw).Trim()
# auto: an automated sender (this script, recover.ps1): the server does not take it as the user's answer (needs-answer mark and pins stay)
$payload = @{ seat = $Seat; text = [IO.File]::ReadAllText((Resolve-Path $TextFile), [Text.Encoding]::UTF8); auto = $true }
if ($Model)  { $payload.model = $Model }
if ($Effort) { $payload.effort = $Effort }
if ($Cwd)    { $payload.cwd = $Cwd }
if ($Mode)   { $payload.mode = $Mode }
if ($Conversation) { $payload.conversationId = $Conversation }
$bytes = [Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Compress))
$r = Invoke-RestMethod -Uri 'http://127.0.0.1:4850/api/send' -Method Post -Body $bytes `
    -ContentType 'application/json; charset=utf-8' -Headers @{ 'X-Seat-Token' = $token }
Write-Output "conversationId: $($r.conversationId)"
if ($Wait) { & "$PSScriptRoot\get.ps1" -Conversation $r.conversationId -Wait -TimeoutSec $TimeoutSec }
