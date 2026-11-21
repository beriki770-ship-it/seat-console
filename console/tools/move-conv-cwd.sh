#!/usr/bin/env bash
# Move a conversation's REAL working folder (not just its project listing) once it is quiet:
#   move-conv-cwd.sh <conversation-id> <new-dir>
# The CLI keys a session's history by its cwd (<config>/projects/<cwd with every non-alphanumeric as ->/<session>.jsonl), so the
# history is COPIED (never moved) to the new folder's project dir first, then the console sets the cwd (POST /api/conv-cwd, which
# re-checks that the conversation is quiet and that the copy matches in size). Idempotent: a done guard file makes later runs a no-op.
# Exit 0 also means "not yet, try later" (busy, or touched in the last 10 minutes); a transient systemd user timer re-runs it:
#   systemd-run --user --unit=move-conv-<id8> --on-active=10min --on-unit-active=10min <this script> <id> <new-dir>
# and the script stops that timer once the guard file exists (or after 48 h). Its output: journalctl --user -u move-conv-<id8>.service
set -euo pipefail
ID=${1:?conversation id}; NEW=${2:?new dir}
API=${SEAT_CONSOLE_URL:-http://127.0.0.1:4850}
HERE=$(cd "$(dirname "$0")/.." && pwd)                          # console/: token.txt for the POST
STATE=${XDG_STATE_HOME:-$HOME/.local/state}/seat-console; mkdir -p "$STATE"
GUARD="$STATE/move-conv-$ID.done" FIRST="$STATE/move-conv-$ID.first"
UNIT="move-conv-${ID:0:8}"
log() { echo "$(date -u +%FT%TZ) [move-conv-cwd ${ID:0:8}] $*"; }
stop_timer() { XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)} systemctl --user stop "$UNIT.timer" 2>/dev/null || true; }

if [[ -e $GUARD ]]; then log "done before ($(cat "$GUARD")): nothing to do"; stop_timer; exit 0; fi
# The timer gives up after 48 hours: a conversation that never goes quiet is left for a person to look at.
[[ -e $FIRST ]] || date +%s > "$FIRST"
if (( $(date +%s) - $(cat "$FIRST") > 48 * 3600 )); then log "gave up after 48 h without a quiet window"; rm -f "$FIRST"; stop_timer; exit 0; fi   # a later manual run starts a fresh 48 h
[[ -d $NEW ]] || { log "no such folder: $NEW"; exit 1; }
NEW=$(cd "$NEW" && pwd -P)

conv=$(curl -sf "$API/api/conversation?id=$ID") || { log "console not reachable or no such conversation: try later"; exit 0; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).conv;const v=c[process.argv[1]];console.log(v==null?"":typeof v==="object"?JSON.stringify(v):v)})' "$1" <<<"$conv"; }
STATUS=$(field status) BG=$(field background) PENDING=$(field pending) UPDATED=$(field updatedAt) SEAT=$(field seat) OLD=$(field cwd) SID=$(field sessionId)
SID=${SID:-$ID}
if [[ $OLD == "$NEW" ]]; then date -u +%FT%TZ > "$GUARD"; log "cwd is already $NEW"; stop_timer; exit 0; fi
# Quiet = not working, no background agents, no approval waiting, untouched for 10 minutes. Anything else: try again on the next tick.
if [[ $STATUS == working || $STATUS == waiting || -n $BG || ${PENDING:-0} != 0 ]]; then log "busy (status=$STATUS bg='${BG}' pending=$PENDING): try later"; exit 0; fi
[[ $UPDATED =~ ^[0-9]+$ ]] || { log "no updatedAt from the console: try later"; exit 0; }
AGE=$(( $(date +%s) - UPDATED / 1000 ))
if (( AGE < 600 )); then log "touched ${AGE}s ago: try later"; exit 0; fi

enc() { printf '%s' "$1" | sed 's/[^A-Za-z0-9]/-/g'; }
BASE="$HOME/.claude-seats/$SEAT/projects"
SRC="$BASE/$(enc "$OLD")" DST="$BASE/$(enc "$NEW")"
[[ -f $SRC/$SID.jsonl ]] || { log "no session file $SRC/$SID.jsonl"; exit 1; }
mkdir -p "$DST"
cp -a "$SRC/$SID.jsonl" "$DST/"
if [[ -d $SRC/$SID ]]; then cp -a "$SRC/$SID" "$DST/"; fi
a=$(stat -c %s "$SRC/$SID.jsonl") b=$(stat -c %s "$DST/$SID.jsonl")
[[ $a == "$b" ]] || { log "copied size differs ($a vs $b): try later"; exit 0; }
if [[ -d $SRC/$SID ]]; then
  da=$(du -sb "$SRC/$SID" | cut -f1) db=$(du -sb "$DST/$SID" | cut -f1)
  [[ $da == "$db" ]] || { log "copied folder size differs ($da vs $db): try later"; exit 0; }
fi
log "copied $SID.jsonl ($a bytes)$( [[ -d $SRC/$SID ]] && echo " + folder" ) to $DST"

body=$(node -e 'console.log(JSON.stringify({conversationId:process.argv[1],cwd:process.argv[2]}))' "$ID" "$NEW")
res=$(curl -s -w '\n%{http_code}' -X POST -H 'content-type: application/json' -H "x-seat-token: $(cat "$HERE/token.txt")" -d "$body" "$API/api/conv-cwd")
code=${res##*$'\n'}; res=${res%$'\n'*}
if [[ $code == 409 ]]; then log "console refused for now: $res"; exit 0; fi
[[ $code == 200 ]] || { log "console error $code: $res"; exit 1; }
date -u +%FT%TZ > "$GUARD"
log "cwd set: $res"
stop_timer
