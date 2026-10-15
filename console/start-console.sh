#!/bin/sh
# Open the Seat Console on Linux / macOS - the twin of start-console.ps1. Idempotent: if the server answers, just open the browser;
# if the port is held by a hung/dead process, kill it and start fresh (detached, output appended to server.log).
# A server that is still starting (reattaching conversations) answers /health with 503: that is "starting", never "hung", and is never killed.
# Only a port that stays dead for 25 s, with no supervisor start in the last 60 s, counts as held by a dead process.
#   sh console/start-console.sh [--no-browser]
DIR=$(cd "$(dirname "$0")" && pwd)
NODE=${NODE:-$(command -v node || echo /usr/local/bin/node)}
PORT=4850
BROWSER=1; [ "${1:-}" = --no-browser ] && BROWSER=0
# HTTP status of a local path ('000' = no answer), via node so curl/wget are not required.
status() { "$NODE" -e 'const r = require("http").get({ host: "127.0.0.1", port: +process.argv[1], path: process.argv[2], timeout: 3000 }, (s) => { console.log(s.statusCode); s.resume(); });
  r.on("timeout", () => r.destroy()); r.on("error", () => console.log("000"));' "$PORT" "$1"; }
up() { [ "$(status /api/seats)" = 200 ]; }
starting() { [ "$(status /health)" = 503 ]; }
listening() { "$NODE" -e 'require("net").connect(+process.argv[1], "127.0.0.1").on("connect", () => process.exit(0)).on("error", () => process.exit(1))' "$PORT"; }
# run-server.sh writes "... started node pid=N epoch=<seconds>": a start less than 60 s ago means "wait, it is coming up".
recent_start() { e=$(grep 'started node' "$DIR/supervisor.log" 2>/dev/null | tail -1 | sed -n 's/.*epoch=\([0-9]*\).*/\1/p'); [ -n "$e" ] && [ $(( $(date +%s) - e )) -lt 60 ]; }
waiting() { listening || recent_start; }

t0=$(date +%s); el() { echo $(( $(date +%s) - t0 )); }
while ! up && { starting || { waiting && { [ "$(el)" -lt 25 ] || recent_start; }; }; } && [ "$(el)" -lt 180 ]; do sleep 3; done
if ! up && ! starting; then
  held=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || fuser "$PORT/tcp" 2>/dev/null || true)
  for p in $held; do kill -9 "$p" 2>/dev/null; done
  [ -n "$held" ] && sleep 1
  # setsid (Linux) puts the server in its own session so closing this terminal does not take it down; macOS has no setsid, nohup covers the hangup.
  if command -v setsid >/dev/null 2>&1; then setsid "$NODE" "$DIR/server.mjs" >> "$DIR/server.log" 2>&1 < /dev/null &
  else nohup "$NODE" "$DIR/server.mjs" >> "$DIR/server.log" 2>&1 < /dev/null & fi
  i=0; while [ $i -lt 25 ] && ! up; do sleep 0.4; i=$((i + 1)); done
fi
if [ "$BROWSER" = 1 ]; then
  url="http://127.0.0.1:$PORT"
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then open "$url"
  else echo "$url"; fi
fi
