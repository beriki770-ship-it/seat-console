// Remote read-only conversations: Claude runs on another (Linux) machine write their stream-json to a file there; the console follows that file over ssh
// and shows it like a conversation. READ ONLY by construction: the only commands ever sent to a remote are `ls -1dt -- <globs>` (which files exist) and
// `tail -c +<n> -- <file>` (the bytes after what we already have). ONE ssh process at a time per remote (so never more than one per file), each killed after
// IDLE_MS without output; polls instead of a long-lived `tail -F`, so an ssh left behind by a killed server ends by itself as soon as its tail reaches the end.
// Config: remotes.json next to seats.json (gitignored; remotes.example.json shows the shape). Pure parts (loadRemotes, takeLines, parseLine) are tested by test-remote.mjs.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

export const POLL_MS = 5000;          // a file whose run has not finished yet (no `result` seen, not stale)
export const LIST_MS = 60000;         // how often `ls` looks for new files matching the globs; finished and stale files are read only then
export const STALE_MS = 30 * 60000;   // a file with no new line for this long counts as finished (a killed run never writes its `result`)
export const MAX_FILES = 20;          // per remote: the newest files by modification time (ls -t); older runs are no longer read
export const IDLE_MS = 30000;         // an ssh with no output for this long is killed (a 70 MB first read streams without pause)
export const MAX_BACKOFF_MS = 300000; // unreachable: 5 s, 10 s, 20 s ... up to 5 min between tries
// Everything that goes into the remote command line is checked against these: no spaces, quotes, `;`, `$` or backticks can reach the remote shell.
const SAFE_GLOB = /^[A-Za-z0-9_./~*?-]+$/, SAFE_PATH = /^\/[A-Za-z0-9_./-]+$/, SAFE_NAME = /^[a-z0-9-]{1,40}$/, SAFE_TARGET = /^[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9_.:-]+$/, SAFE_BIN = /^[A-Za-z0-9_./~-]+$/;
export { SAFE_PATH };
// Windows' own OpenSSH reads %USERPROFILE%\.ssh like Git's ssh does; the full path because the scheduled task's PATH is not a shell's.
export const SSH = fs.existsSync('C:\\Windows\\System32\\OpenSSH\\ssh.exe') ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : 'ssh';

// remotes.json -> [{ name, target, identity, seat, paths, port, control, node, claude }]. Missing file = no remotes; a bad entry is logged and left out, never fatal.
// control: true = the console may also START conversations there (rhost.mjs); without it the remote is read-only and only ls/tail ever run on it.
// A control remote needs no paths (nothing to follow). node / claude = the remote's binaries (default: found on the remote PATH; `~/` allowed). port = the ssh port.
export function loadRemotes(file, home, log = console.log) {
  let raw; try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { if (e.code !== 'ENOENT') log(`[remote] ${file} not read: ${e.message}`); return []; }
  const out = [];
  for (const r of Array.isArray(raw?.remotes) ? raw.remotes : []) {
    const paths = Array.isArray(r?.paths) ? r.paths : [], control = r?.control === true, port = r?.port ?? null;
    if (!SAFE_NAME.test(r?.name || '') || !SAFE_TARGET.test(r?.target || '') || typeof r?.identity !== 'string' || (!paths.length && !control) || !paths.every((p) => typeof p === 'string' && SAFE_GLOB.test(p)) || out.some((x) => x.name === r.name)
      || (port !== null && !(Number.isInteger(port) && port > 0 && port < 65536)) || [r?.node, r?.claude].some((b) => b !== undefined && !(typeof b === 'string' && SAFE_BIN.test(b)))) {
      log(`[remote] entry ${JSON.stringify(r?.name)} skipped: needs name [a-z0-9-], target user@host, identity, paths (letters, digits, _ . / ~ * ? - only; may be empty with control: true), port 1-65535, node/claude (letters, digits, _ . / ~ - only)`); continue;
    }
    out.push({ name: r.name, target: r.target, identity: r.identity.replace(/^~(?=[\\/])/, home), seat: typeof r.seat === 'string' ? r.seat : '', paths, port, control, node: r.node || 'node', claude: r.claude || 'claude' });
  }
  return out;
}

// One stream-json line -> its event object, or null for anything else (bad JSON, but also `null`, `42`, `"x"`, `[]`: valid JSON the event code cannot read).
export function parseLine(line) {
  let v; try { v = JSON.parse(line); } catch { return null; }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

// The complete lines in `buf` (the bytes that start at byte `base` of the remote file). `end` = byte offset just after a line; `off` = where the next read
// starts: an unfinished last line (the run is writing it right now) is not counted and is read again, whole, by the next poll.
export function takeLines(buf, base) {
  const lines = []; let start = 0;
  for (let nl; (nl = buf.indexOf(10, start)) >= 0; start = nl + 1) lines.push({ line: buf.toString('utf8', start, nl), end: base + nl + 1 });
  return { lines, rest: buf.subarray(start), off: base + start };
}

export const sshArgs = (r, cmd) => ['-T', '-i', r.identity, ...(r.port ? ['-p', String(r.port)] : []), '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', r.target, cmd];

// Follow every file of one remote. h.offsetOf(file) -> Promise<byte offset already stored>, h.onLines(file, lines, live) (live = false while a file is
// read from byte 0: its old results must not send "done" messages), h.done(file) -> its run finished or went stale, h.onStatus(error text | null).
export function followRemote(r, h, { spawnFn = spawn } = {}) {
  let stopped = false, child = null, wake = null;
  const offs = new Map();   // file -> next byte to read
  // One ssh run. Resolves { code, err } (code null = killed or failed to start); never rejects.
  const run = (cmd, onData) => new Promise((ok) => {
    let done = false, err = '', timer;
    const end = (code) => { if (done) return; done = true; clearTimeout(timer); child = null; ok({ code, err: err.trim().split('\n').pop() || '' }); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { err ||= `no output for ${IDLE_MS / 1000} s`; p.kill(); }, IDLE_MS); };
    const p = child = spawnFn(SSH, sshArgs(r, cmd), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (b) => { arm(); onData(b); });
    p.stderr.on('data', (b) => { if (err.length < 2000) err += b; });
    p.on('error', (e) => { err = e.message; end(null); });
    p.on('close', (code) => end(code));
    arm();
  });
  const down = (x) => x.code === null || x.code === 255;   // 255 = ssh itself failed (host down, auth, timeout); anything else came from the remote command
  async function list() {
    let out = '';
    const x = await run(`ls -1dt -- ${r.paths.join(' ')}`, (b) => { out += b; });   // -t: newest first, so the cap keeps the current runs
    if (down(x)) throw new Error(x.err || 'ssh failed');
    return out.split('\n').map((l) => l.trim()).filter((l) => SAFE_PATH.test(l)).slice(0, MAX_FILES);   // ls exits 2 when one glob matches nothing: the others still count
  }
  async function poll(file) {
    if (!offs.has(file)) offs.set(file, await h.offsetOf(file));
    const from = offs.get(file); let pending = Buffer.alloc(0), at = from;
    const x = await run(`tail -c +${from + 1} -- ${file}`, (b) => {
      const t = takeLines(pending.length ? Buffer.concat([pending, b]) : b, at); pending = t.rest; at = t.off;
      // A throw here would escape the stdout handler and take the whole server down: log it, the offset still moves on past these lines.
      if (t.lines.length) try { h.onLines(file, t.lines, from > 0); } catch (e) { console.log(`[remote] ${r.name} ${file}: lines not handled: ${e?.stack || e}`); }
    });
    offs.set(file, at);   // lines handed over are counted even when ssh died half-way: the next poll continues after them, nothing twice
    if (down(x)) throw new Error(x.err || 'ssh failed');
  }
  (async () => {
    let files = [], listAt = 0, back = 0;
    while (!stopped) {
      let wait;
      try {
        const listed = Date.now() - listAt >= LIST_MS;
        if (listed) { files = await list(); listAt = Date.now(); }
        for (const f of files) { if (stopped) break; if (listed || !h.done(f)) await poll(f); }   // finished / stale files: once a minute, on the listing tick
        h.onStatus(null); back = 0; wait = files.some((f) => !h.done(f)) ? POLL_MS : LIST_MS;
      } catch (e) { h.onStatus(e.message); back = Math.min(back ? back * 2 : POLL_MS, MAX_BACKOFF_MS); wait = back; listAt = 0; }
      if (!stopped) await new Promise((ok) => { wake = ok; setTimeout(ok, wait).unref(); });
    }
  })().catch((e) => h.onStatus('follower stopped: ' + e.message));
  return { stop: () => { stopped = true; try { child?.kill(); } catch {} wake?.(); } };
}
