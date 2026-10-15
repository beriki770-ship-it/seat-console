// Pid reuse guard: Windows hands a dead process's pid to the next process that starts, so a pid read from host.json / state may now belong to something else (maybe the user's own
// node or claude). Before any kill by pid the command line is checked for this conversation's own marker; no match (or no answer) = treat it as dead and do not touch it.
import fs from 'node:fs';
import { execFile } from 'node:child_process';

const WIN = process.platform === 'win32';
// POSIX (Linux, macOS): the same two answers without WMI. Linux reads /proc (no process spawn); elsewhere `ps`. `ps` exits 1 with no output for a missing pid = null;
// any other failure (no ps binary, timeout) = undefined, like a failed WMI query.
const psField = (pid, field) => new Promise((ok) => execFile('ps', ['-ww', '-o', field + '=', '-p', String(pid)], { timeout: 15000, env: { ...process.env, LC_ALL: 'C' } },
  (err, out) => ok(String(out || '').trim() || (err && err.code === 1 ? null : err ? undefined : null))));
function posixCmdline(pid) {
  if (process.platform !== 'linux') return psField(pid, 'command');
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ') || null; }   // empty = a zombie: no command line, nothing of ours
  catch (e) { return e.code === 'ENOENT' || e.code === 'ESRCH' ? null : undefined; }
}
// `ps -o lstart` = "Thu Oct 15 19:40:01 2026" (local time, C locale), one-second resolution: a reused pid is born after our spawn record, so that is enough.
const posixCreated = async (pid) => { const t = await psField(pid, 'lstart'); return typeof t === 'string' ? (Number.isFinite(Date.parse(t)) ? Date.parse(t) : undefined) : t; };
// SIGKILL like taskkill /F. tree = claude's whole process group: host.mjs starts claude detached (its own group) on POSIX, so -pid reaches its tools too.
export const posixKill = (pid, tree) => { try { process.kill(tree ? -pid : pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } };

// Command line of one pid via WMI (async, never blocks the event loop); null = no such process, undefined = the QUERY failed (timeout under load, WMI error): the caller must not read that as "dead".
export const cmdlineOf = (pid) => new Promise((ok) => {
  if (!Number.isInteger(pid) || pid <= 0) return ok(null);
  if (!WIN) return ok(posixCmdline(pid));
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
    { windowsHide: true, timeout: 15000 }, (err, out) => ok(err ? undefined : String(out).trim() || null));
});

// Creation time (epoch ms) of one pid: null = no such process, undefined = the query failed. Used when the command line could not be read: a reused pid belongs to a process born AFTER ours.
export const createdOf = (pid) => new Promise((ok) => {
  if (!Number.isInteger(pid) || pid <= 0) return ok(null);
  if (!WIN) return ok(posixCreated(pid));
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

// Kill functions that only act on a pid that passed isOurs. `taskkill(args)` and the needles are supplied by the caller; on POSIX `signal(pid, tree)` does the kill instead.
export function guardedKillers({ taskkill, signal = posixKill, win = WIN, lookup = cmdlineOf, created = createdOf, log = console.log }) {
  // 'unknown' (WMI failed twice): kill only a pid that is alive AND was created no later than `since` (epoch ms recorded when the host/claude was spawned; a reused pid belongs to
  // a process born after ours). No `since`, no answer, or a newer process = skip and say so loudly. The args also carry an image-name filter (node.exe / claude.exe) + the pid.
  const guarded = (needle, args, tree) => async (pid, since) => {
    if (!pid) return;
    const own = await ownership(pid, needle, lookup);
    if (own === 'no') return;
    if (own === 'unknown') {
      const born = await created(pid).catch(() => undefined);
      if (!(since && Number.isFinite(born) && born <= since)) { log(`[kill] SKIPPED pid=${pid}: ownership unknown (WMI failed) and creation time ${born ?? 'unavailable'} is not provably <= spawn time ${since ?? 'not recorded'}; the process may still be running`); return; }
    }
    if (win) await taskkill(args(pid)); else signal(pid, tree);
  };
  return {
    killHost: (pid, base, since) => guarded(hostNeedle(base), (p) => ['/FI', 'IMAGENAME eq node.exe', '/FI', `PID eq ${p}`, '/F'], false)(pid, since),
    killClaude: (pid, sessionId, since) => guarded(sessionId, (p) => ['/FI', 'IMAGENAME eq claude.exe', '/FI', `PID eq ${p}`, '/T', '/F'], true)(pid, since),
    killClaudeTree: (pid, sessionId, since) => guarded(sessionId, (p) => ['/FI', 'IMAGENAME eq claude.exe', '/PID', String(p), '/T', '/F'], true)(pid, since),
  };
}
