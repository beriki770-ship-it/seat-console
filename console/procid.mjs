// Pid reuse guard: Windows hands a dead process's pid to the next process that starts, so a pid read from host.json / state may now belong to something else (maybe the user's own
// node or claude). Before any kill by pid the command line is checked for this conversation's own marker; no match (or no answer) = treat it as dead and do not touch it.
import { execFile } from 'node:child_process';

// Command line of one pid via WMI (async, never blocks the event loop); null = no such process, undefined = the QUERY failed (timeout under load, WMI error): the caller must not read that as "dead".
export const cmdlineOf = (pid) => new Promise((ok) => {
  if (!Number.isInteger(pid) || pid <= 0) return ok(null);
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
    { windowsHide: true, timeout: 15000 }, (err, out) => ok(err ? undefined : String(out).trim() || null));
});

// Creation time (epoch ms) of one pid: null = no such process, undefined = the query failed. Used when the command line could not be read: a reused pid belongs to a process born AFTER ours.
export const createdOf = (pid) => new Promise((ok) => {
  if (!Number.isInteger(pid) || pid <= 0) return ok(null);
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds() }`],
    { windowsHide: true, timeout: 15000 }, (err, out) => ok(err ? undefined : (String(out).trim() ? Number(String(out).trim()) : null)));
});

// Does `pid` carry `needle` (a string or a list of strings) in its command line? 'yes' | 'no' | 'unknown' (the WMI query failed twice). `lookup` is injectable for tests (a fake process table).
export async function ownership(pid, needle, lookup = cmdlineOf) {
  const needles = [].concat(needle).filter(Boolean);
  if (!needles.length) return 'no';
  let line = await lookup(pid).catch(() => undefined);
  if (line === undefined) line = await lookup(pid).catch(() => undefined); // one retry: cold PowerShell spawns time out when many start at once
  if (line === undefined) return 'unknown';
  return line && needles.some((n) => line.includes(n)) ? 'yes' : 'no';
}
export const isOurs = async (pid, needle, lookup = cmdlineOf) => (await ownership(pid, needle, lookup)) === 'yes';

// A host is started as `node host.mjs <base>.host-cfg.json`; claude carries the session id (--session-id / --resume).
export const hostNeedle = (base) => base.split(/[\\/]/).pop() + '.host-cfg.json';

// Kill functions that only act on a pid that passed isOurs. `taskkill(args)` and the needles are supplied by the caller.
export function guardedKillers({ taskkill, lookup = cmdlineOf, created = createdOf, log = console.log }) {
  // 'unknown' (WMI failed twice): kill only a pid that is alive AND was created no later than `since` (epoch ms recorded when the host/claude was spawned; a reused pid belongs to
  // a process born after ours). No `since`, no answer, or a newer process = skip and say so loudly. The args also carry an image-name filter (node.exe / claude.exe) + the pid.
  const guarded = (needle, args) => async (pid, since) => {
    if (!pid) return;
    const own = await ownership(pid, needle, lookup);
    if (own === 'no') return;
    if (own === 'unknown') {
      const born = await created(pid).catch(() => undefined);
      if (!(since && Number.isFinite(born) && born <= since)) { log(`[kill] SKIPPED pid=${pid}: ownership unknown (WMI failed) and creation time ${born ?? 'unavailable'} is not provably <= spawn time ${since ?? 'not recorded'}; the process may still be running`); return; }
    }
    await taskkill(args(pid));
  };
  return {
    killHost: (pid, base, since) => guarded(hostNeedle(base), (p) => ['/FI', 'IMAGENAME eq node.exe', '/FI', `PID eq ${p}`, '/F'])(pid, since),
    killClaude: (pid, sessionId, since) => guarded(sessionId, (p) => ['/FI', 'IMAGENAME eq claude.exe', '/FI', `PID eq ${p}`, '/T', '/F'])(pid, since),
    killClaudeTree: (pid, sessionId, since) => guarded(sessionId, (p) => ['/FI', 'IMAGENAME eq claude.exe', '/PID', String(p), '/T', '/F'])(pid, since),
  };
}
