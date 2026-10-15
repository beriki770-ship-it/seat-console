# seat.ps1 - run one seat (one Claude account) in its own terminal.
#
# Why this exists: the desktop app holds ONE account. Each Team seat gets its own
# CLAUDE_CONFIG_DIR (own login in .credentials.json) while skills, hooks, memory and
# transcripts stay shared with ~/.claude through junctions - one brain, one login per seat.
#
#   .\seat.ps1 dev -Login                  first time: sign this seat in (browser)
#   .\seat.ps1 dev                         interactive session for the dev seat
#   .\seat.ps1 dev -TaskFile tasks\x.md    same, starting on the task in that file
#   .\seat.ps1 dev -InitOnly              prepare the seat dir and exit (used by console\server.mjs)
#   .\seat.ps1 -Status                     which seats are logged in, as whom
param(
    [string]$Seat,
    [switch]$Login,
    [switch]$Status,
    [switch]$InitOnly,
    [string]$TaskFile,
    [string]$Cwd
)
$ErrorActionPreference = 'Stop'
$Shared = "$env:USERPROFILE\.claude"
$Root   = "$env:USERPROFILE\.claude-seats"
# npm's claude was installed from inside the desktop app (MSIX): its real files sit in the
# package LocalCache, and %APPDATA%\npm exists only inside the app's view. Try the real place first.
$Claude = @(
    (Get-ChildItem "$env:LOCALAPPDATA\Packages\Claude_*\LocalCache\Roaming\npm\claude.cmd" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName,
    "$env:APPDATA\npm\claude.cmd",
    "$env:USERPROFILE\.local\bin\claude.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
$Config = Get-Content "$PSScriptRoot\seats.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$Seats  = $Config.seats
if (-not $Cwd) { $Cwd = if ($Config.projectsDir) { $Config.projectsDir } else { $env:USERPROFILE } }

# Folders every seat shares with the main config. Credentials and .claude.json stay per seat.
$SharedDirs = 'agents','commands','hooks','plugins','projects','skills'

function Initialize-Seat($name) {
    $dir = Join-Path $Root $name
    New-Item -ItemType Directory -Force $dir | Out-Null
    foreach ($d in $SharedDirs) {
        $link = Join-Path $dir $d
        # a fresh ~/.claude may not have every folder yet; a junction needs an existing target
        New-Item -ItemType Directory -Force (Join-Path $Shared $d) | Out-Null
        if (-not (Test-Path $link)) { New-Item -ItemType Junction -Path $link -Target (Join-Path $Shared $d) | Out-Null }
    }
    # CLAUDE.md imports the real one, so editing ~/.claude/CLAUDE.md reaches every seat.
    Set-Content (Join-Path $dir 'CLAUDE.md') "@$($Shared -replace '\\','/')/CLAUDE.md" -Encoding UTF8
    # settings are copied fresh on every start: a hardlink would break the first time a tool rewrites the file.
    foreach ($f in 'settings.json','settings.local.json') {
        if (Test-Path "$Shared\$f") { Copy-Item "$Shared\$f" (Join-Path $dir $f) -Force }
    }
    # user-scope MCP servers live in ~/.claude.json; merge them in, keep the seat's own login fields.
    python -I "$PSScriptRoot\merge_mcp.py" "$env:USERPROFILE\.claude.json" (Join-Path $dir '.claude.json')
    return $dir
}

if ($Status) {
    foreach ($name in $Seats.PSObject.Properties.Name) {
        $dir = Join-Path $Root $name
        if (-not (Test-Path "$dir\.credentials.json")) { "{0,-7} not logged in" -f $name; continue }
        $env:CLAUDE_CONFIG_DIR = $dir
        $s = & $Claude auth status | ConvertFrom-Json
        "{0,-7} {1} ({2})" -f $name, $s.email, $s.subscriptionType
    }
    exit 0
}

if (-not $Seat -or -not $Seats.$Seat) { throw "Seat must be one of: $($Seats.PSObject.Properties.Name -join ', ')" }
$dir = Initialize-Seat $Seat
# Launched from inside a Claude session this shell inherits its CLAUDE_* vars (account uuid,
# child-session marker), which switch off transcript saving in the seat. Drop them all.
Get-ChildItem Env: | Where-Object { $_.Name -match '^CLAUDE' } | ForEach-Object { Remove-Item "Env:$($_.Name)" -ErrorAction SilentlyContinue }   # a name listed twice (case variants) is already gone at its second removal: that must not fail the seat (2026-10-14)
$env:CLAUDE_CONFIG_DIR = $dir
if ($InitOnly) { exit 0 }   # console/server.mjs: prepare the dir, then spawn claude itself

if ($Login) {
    "Sign in as $($Seats.$Seat.email) in the browser that opens."
    & $Claude auth login
    & $Claude auth status
    exit 0
}

$role = "You are the '$Seat' seat ($($Seats.$Seat.email)) in the user's multi-seat setup. Your area: $($Seats.$Seat.role). Work only in that area; if a request belongs to another area, say which seat should take it."
$cliArgs = @('--append-system-prompt', $role, '--name', "seat:$Seat")
if ($TaskFile) { $cliArgs += (Get-Content $TaskFile -Raw -Encoding UTF8) }
$host.UI.RawUI.WindowTitle = "seat: $Seat"
Set-Location $Cwd
& $Claude @cliArgs
