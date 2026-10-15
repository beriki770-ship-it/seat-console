#!/bin/sh
# seat.sh - the Linux / macOS twin of seat.ps1: run one seat (one Claude account) with its own CLAUDE_CONFIG_DIR.
#
# Each seat gets ~/.claude-seats/<seat> (own login) while skills, hooks, memory and transcripts stay shared
# with ~/.claude through SYMLINKS (seat.ps1 uses junctions) - one brain, one login per seat.
#
#   ./seat.sh dev --login                  first time: sign this seat in (browser)
#   ./seat.sh dev                          interactive session for the dev seat
#   ./seat.sh dev --task-file tasks/x.md   same, starting on the task in that file
#   ./seat.sh dev --init-only              prepare the seat dir and exit (used by console/server.mjs)
#   ./seat.sh --status                     which seats are logged in, as whom
#   --cwd <dir>                            working folder of the interactive session (default: projectsDir from seats.json, else ~)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SHARED="$HOME/.claude"
ROOT="$HOME/.claude-seats"
SEAT='' LOGIN=0 STATUS=0 INIT_ONLY=0 TASK_FILE='' CWD=''
while [ $# -gt 0 ]; do
  case "$1" in
    --login) LOGIN=1 ;;
    --status) STATUS=1 ;;
    --init-only) INIT_ONLY=1 ;;
    --task-file) TASK_FILE=$2; shift ;;
    --cwd) CWD=$2; shift ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) SEAT=$1 ;;
  esac
  shift
done
# claude on PATH, else the native installer's ~/.local/bin (a service's PATH is short).
CLAUDE=$(command -v claude || true)
[ -n "$CLAUDE" ] || CLAUDE="$HOME/.local/bin/claude"
# seats.json is read with node (always present: the console needs it); a BOM written by PowerShell is tolerated.
seats_js() { node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").replace(/^﻿/, "")).seats; const [k, f] = process.argv.slice(2);
  if (!k) console.log(Object.keys(s).join(" ")); else if (Object.hasOwn(s, k)) console.log(f ? s[k][f] : "yes");' "$HERE/seats.json" "$@"; }
[ -n "$CWD" ] || CWD=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").replace(/^﻿/, "")).projectsDir || "")' "$HERE/seats.json")
[ -n "$CWD" ] || CWD=$HOME

# Folders every seat shares with the main config. Credentials and .claude.json stay per seat.
SHARED_DIRS='agents commands hooks plugins projects skills'
init_seat() {
  dir="$ROOT/$1"
  mkdir -p "$dir"
  for d in $SHARED_DIRS; do
    mkdir -p "$SHARED/$d"   # a fresh ~/.claude may not have every folder yet; the link needs an existing target
    [ -e "$dir/$d" ] || [ -L "$dir/$d" ] || ln -s "$SHARED/$d" "$dir/$d"
  done
  # CLAUDE.md imports the real one, so editing ~/.claude/CLAUDE.md reaches every seat.
  printf '@%s/CLAUDE.md\n' "$SHARED" > "$dir/CLAUDE.md"
  # settings are copied fresh on every start: a link would break the first time a tool rewrites the file.
  for f in settings.json settings.local.json; do
    if [ -f "$SHARED/$f" ]; then cp -f "$SHARED/$f" "$dir/$f"; fi
  done
  # user-scope MCP servers + onboarding/trust flags from ~/.claude.json; the seat keeps its own login fields.
  # python3 is the normal name on Linux/macOS.
  py=$(command -v python3 || command -v python || true)
  if [ -f "$HOME/.claude.json" ] && [ -n "$py" ]; then "$py" -I "$HERE/merge_mcp.py" "$HOME/.claude.json" "$dir/.claude.json" || echo "merge_mcp.py failed for $1" >&2; fi
}

if [ "$STATUS" = 1 ]; then
  for name in $(seats_js); do
    # macOS keeps the login in the Keychain, not in .credentials.json: ask claude itself.
    out=$(CLAUDE_CONFIG_DIR="$ROOT/$name" "$CLAUDE" auth status 2>/dev/null || true)
    printf '%s\n' "$out" | node -e 'let t = ""; process.stdin.on("data", (d) => t += d).on("end", () => { let s = {}; try { s = JSON.parse(t); } catch {}
      console.log(process.argv[1].padEnd(7), s.loggedIn === false || !s.email ? "not logged in" : `${s.email} (${s.subscriptionType})`); });' "$name"
  done
  exit 0
fi

if [ -z "$SEAT" ] || [ "$(seats_js "$SEAT")" != yes ]; then echo "Seat must be one of: $(seats_js)" >&2; exit 2; fi
init_seat "$SEAT"
# Launched from inside a Claude session this shell inherits its CLAUDE_* vars (account uuid, child-session marker),
# which switch off transcript saving in the seat. Drop them all (any case, like seat.ps1's -match).
for v in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | grep -i '^claude' || true); do unset "$v"; done
export CLAUDE_CONFIG_DIR="$ROOT/$SEAT"
[ "$INIT_ONLY" = 1 ] && exit 0   # console/server.mjs: prepare the dir, then spawn claude itself

if [ "$LOGIN" = 1 ]; then
  echo "Sign in as $(seats_js "$SEAT" email) in the browser that opens."
  "$CLAUDE" auth login
  "$CLAUDE" auth status
  exit 0
fi

role="You are the '$SEAT' seat ($(seats_js "$SEAT" email)) in the user's multi-seat setup. Your area: $(seats_js "$SEAT" role). Work only in that area; if a request belongs to another area, say which seat should take it."
if [ -n "$TASK_FILE" ]; then task=$(cat "$TASK_FILE"); cd "$CWD"; exec "$CLAUDE" --append-system-prompt "$role" --name "seat:$SEAT" "$task"; fi   # read before the cd: the path may be relative
cd "$CWD"
exec "$CLAUDE" --append-system-prompt "$role" --name "seat:$SEAT"
