# Seat Console smoke test: ONE command, exit 0 = every step passed, non-zero + a table of what failed. Run it before every production deploy.
# Starts its own TEST instance (port 4851, fresh console\test-data\smoke-<ts>, deleted at the end) and drives the real API with claude-haiku-4-5 on the ops seat.
# Production 4850 is never touched. Takes about 3-4 minutes.
$ErrorActionPreference = 'Stop'
# A shell started inside a Claude session carries CLAUDE_* variables; seat.ps1 -InitOnly chokes on some of them.
Get-ChildItem Env: | Where-Object { $_.Name -match '^CLAUDE' } | ForEach-Object { [Environment]::SetEnvironmentVariable($_.Name, $null, 'Process') }
# Port 4851 busy: a smoke run that started less than 10 minutes ago is left alone (two runs would kill each other's server); anything else on 4851 is a forgotten test instance and is stopped.
$owner = Get-NetTCPConnection -LocalPort 4851 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($owner) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($owner.OwningProcess)"
    if (($p.CommandLine -like '*test-data\smoke-*' -or $p.CommandLine -like '*test-data/smoke-*') -and $p.CreationDate -gt (Get-Date).AddMinutes(-10)) { Write-Host 'another smoke run is in progress on 4851: wait for it to finish'; exit 2 }
    & "$PSScriptRoot\stop-test.ps1" | Out-Null
}
node "$PSScriptRoot\smoke.mjs"
$code = $LASTEXITCODE
# Independent of the node script: nothing may still run from a smoke data dir or its %TEMP%\seat-smoke-* claude cwd. -like, not -match: in a regex '\s' of 'test-data\smoke-' is whitespace.
$left = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|claude)\.exe$' -and ($_.CommandLine -like '*test-data\smoke-*' -or $_.CommandLine -like '*test-data/smoke-*' -or $_.CommandLine -like '*seat-smoke-*') })
if ($left.Count) { $left | ForEach-Object { "LEFTOVER process $($_.Name) $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; $code = 1 }
Get-ChildItem "$PSScriptRoot\test-data" -Directory -Filter 'smoke-*' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddMinutes(-30) } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
# Leftovers of earlier aborted runs (data dir + the claude cwd under %TEMP%), only when old enough not to belong to a run in progress.
Get-ChildItem $env:TEMP -Directory -Filter 'seat-smoke-*' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddMinutes(-30) } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
exit $code
