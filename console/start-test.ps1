# Starts the isolated TEST instance of the Seat Console in the background: port 4851, data in console\test-data (own state/logs/token),
# no Tailscale, Telegram off. ALL testing by agents happens here, never on production 4850. Prints the URL; stop with stop-test.ps1.
$Port = 4851
$dir = Join-Path $PSScriptRoot 'test-data'
New-Item -ItemType Directory -Force $dir | Out-Null
function Test-Up { try { (Invoke-WebRequest "http://127.0.0.1:$Port/api/seats" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { $false } }
# Started from inside a Claude session this shell carries CLAUDE_* variables; seat.ps1 -InitOnly chokes on some of them and the seat would not save transcripts.
Get-ChildItem Env: | Where-Object { $_.Name -match '^CLAUDE' } | ForEach-Object { [Environment]::SetEnvironmentVariable($_.Name, $null, 'Process') }
if (-not (Test-Up)) {
    # A test-data\routines.json (a temporary routine for a live test) replaces the committed routines.json on this instance only.
    $routinesArg = if (Test-Path "$dir\routines.json") { " --routines `"$dir\routines.json`"" } else { '' }
    # Appended by cmd's >> (not -RedirectStandardOutput): the server rotates server.log by copy-truncate, which only works for an append-mode handle (else NUL bytes).
    $cmd = "/d /s /c `"`"$((Get-Command node).Source)`" `"$PSScriptRoot\server.mjs`" --port $Port --data `"$dir`"$routinesArg >> `"$dir\server.log`" 2>&1`""
    Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList $cmd -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
    for ($i = 0; $i -lt 25 -and -not (Test-Up); $i++) { Start-Sleep -Milliseconds 400 }
}
if (-not (Test-Up)) { Write-Error "test instance did not come up, see $dir\server.log"; exit 1 }
"test instance: http://127.0.0.1:$Port  (token: $dir\token.txt)"
