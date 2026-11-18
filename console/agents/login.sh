#!/bin/sh
# Sign one agent seat in to ITS OWN account (several Codex / Antigravity accounts side by side, like the Claude seats).
#   console/agents/login.sh <seat>        e.g. codex2, antigravity2
# The seat must exist in seats.json with "agent": "codex" | "agy" and "home": "<its own folder>" (no "home" = the CLI's default login).
# Codex: device-code login (prints a URL + code, works over SSH). Antigravity: its sign-in screen (URL, then paste the code back).
set -eu
SEAT="${1:?usage: login.sh <seat>}"
SEATS_JSON="$(dirname "$0")/../../seats.json"
read_field() { node -e "const s=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8').replace(/^﻿/,'')).seats[process.argv[2]];if(!s){console.error('unknown seat '+process.argv[2]);process.exit(1)}console.log((s[process.argv[3]]||'').replace(/^~(?=\/|$)/,process.env.HOME))" "$SEATS_JSON" "$SEAT" "$1"; }
AGENT="$(read_field agent)"; HOMEDIR="$(read_field home)"
[ -n "$HOMEDIR" ] && mkdir -p "$HOMEDIR"
case "$AGENT" in
  codex) if [ -n "$HOMEDIR" ]; then CODEX_HOME="$HOMEDIR" codex login --device-auth; else codex login --device-auth; fi ;;
  agy)   if [ -n "$HOMEDIR" ]; then HOME="$HOMEDIR" "${AGY_BIN:-$HOME/.local/bin/agy}"; else "${AGY_BIN:-$HOME/.local/bin/agy}"; fi ;;
  *) echo "seat $SEAT is not a Codex/Antigravity seat (agent=$AGENT)"; exit 1 ;;
esac
