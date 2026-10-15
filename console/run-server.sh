#!/bin/sh
# Supervisor for the Seat Console on Linux / macOS - the twin of run-server.ps1. Runs node server.mjs (output appended to server.log)
# and starts it again whenever it exits, whatever the exit code. At most MAX_PER_MINUTE starts per minute (a crash loop sleeps 30 s
# instead of spinning); a port another console already holds is waited on, not fought over. Every start/exit goes to supervisor.log.
# Run it from systemd (seat-console.service) or launchd (seat-console.plist), or by hand: `sh console/run-server.sh`.
# Extra arguments go to server.mjs (e.g. `--port 4852 --data /tmp/x` for a test instance); the port check follows --port.
# Stopped with SIGTERM/SIGINT it stops node too; the per-conversation hosts run in their own sessions and keep their conversations alive.
DIR=$(cd "$(dirname "$0")" && pwd)
NODE=${NODE:-$(command -v node || echo /usr/local/bin/node)}
MAX_PER_MINUTE=${MAX_PER_MINUTE:-6}
PORT=4850; prev=''
for a in "$@"; do [ "$prev" = --port ] && PORT=$a; prev=$a; done
# Server log and supervisor log live in the data dir of a test instance, in console/ for production (like the PowerShell scripts).
LOGDIR=$DIR; prev=''
for a in "$@"; do [ "$prev" = --data ] && LOGDIR=$a; prev=$a; done
mkdir -p "$LOGDIR"
SUP="$LOGDIR/supervisor.log"
sup() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$SUP"; }
# A listener on the port, checked with node itself (lsof / ss differ between Linux and macOS).
listening() { "$NODE" -e 'require("net").connect(+process.argv[1], "127.0.0.1").on("connect", () => process.exit(0)).on("error", () => process.exit(1))' "$PORT"; }

# Sleeps in the background + wait: a plain `sleep 30` holds off the TERM trap until it ends (launchd/systemd would then SIGKILL us and orphan node).
nap() { sleep "$1" & wait $!; }
child=''
trap 'sup "stopped by signal, stopping node pid=$child"; [ -n "$child" ] && kill "$child" 2>/dev/null; exit 0' TERM INT HUP
sup "supervisor up pid=$$ node=$NODE"
starts=''
while :; do
  now=$(date +%s); keep=''
  for t in $starts; do [ $((now - t)) -le 60 ] && keep="$keep $t"; done; starts=$keep
  if [ $(echo $starts | wc -w) -ge "$MAX_PER_MINUTE" ]; then sup "restart limit ($MAX_PER_MINUTE/min) hit, waiting 30 s"; nap 30; continue; fi
  # Another console already owns the port (a manual start, a node that outlived its supervisor): a new node would only find that out and exit, over and over. Wait instead.
  if listening; then sup "port $PORT is in use by another process, waiting 30 s"; nap 30; continue; fi
  starts="$starts $now"
  # >> = append mode: the server rotates server.log by copy-truncate, which only works for an append-mode handle.
  "$NODE" "$DIR/server.mjs" "$@" >> "$LOGDIR/server.log" 2>&1 &
  child=$!
  sup "started node pid=$child epoch=$now"
  wait "$child"; code=$?
  sup "node exited code=$code after $(( $(date +%s) - now ))s, restarting in 3 s"
  child=''
  nap 3
done
