// Controlled remote conversations: a conversation whose claude runs on a remote Linux machine (remotes.json entry with "control": true).
// The remote runs the SAME host.mjs as this PC (installed once by `node console/rhost.mjs setup <name>`), detached, so it survives the ssh that started it
// and the console. The console reaches it through `ssh -W 127.0.0.1:<port>` (stdio forwarding): no local port is opened or raced for, nothing listens on this PC,
// and the link dies with its one ssh process. sshd allows it by default (AllowTcpForwarding yes).
// Every remote command is a fixed text; the only variable parts are checked here first (uuid, pid, needle, SAFE_PATH) or come from remotes.json, which
// loadRemotes already checked. Anything free-form (the claude arguments, the prompt text, the token) travels as JSON over ssh STDIN, never on a command line.
// Remote layout: ~/.seat-console/{host,hostlink,procid}.mjs + run/<conversation id>.host-{cfg.json,json,out,exit.json,log} (mode 700/600).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { SSH, SAFE_PATH, sshArgs, loadRemotes, takeLines } from './remote.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = '.seat-console', RUN = DIR + '/run';   // relative: a remote command starts in the login dir ($HOME)
const ID = /^[0-9a-f-]{36}$/, PID = /^\d+$/, NEEDLE = /^[A-Za-z0-9._-]+$/;
export const FILE_CAP = 25 * 1024 * 1024;   // a file shown from a remote conversation (preview) is fetched whole, so it is capped
const check = (re, v, what) => { if (!re.test(String(v))) throw new Error(`refused: unsafe ${what} for a remote command`); return String(v); };

// One ssh command. Resolves { code, out (Buffer), err }, never rejects. code 255 / null = ssh itself failed (host down, auth, timeout): see `down`.
export function sshRun(r, cmd, { input = '', timeout = 30000, max = FILE_CAP + 65536 } = {}) {
  return new Promise((ok) => {
    const p = spawn(SSH, sshArgs(r, cmd), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let n = 0, err = '', done = false, capped = false;
    const t = setTimeout(() => { err ||= `no answer within ${timeout / 1000} s`; p.kill(); }, timeout);
    const end = (code) => { if (done) return; done = true; clearTimeout(t); ok({ code: capped ? 'cap' : code, out: Buffer.concat(chunks), err: err.trim().split('\n').pop() || '' }); };
    p.stdout.on('data', (b) => { n += b.length; if (n > max) { capped = true; err = 'output over the size cap'; p.kill(); } else chunks.push(b); });
    p.stderr.on('data', (b) => { if (err.length < 2000) err += b; });
    p.on('error', (e) => { err = e.message; end(null); });
    p.on('close', end);
    p.stdin.on('error', () => {}); p.stdin.end(input);
  });
}
export const down = (x) => x.code === null || x.code === 255;   // 'cap' (output over the size cap) is not a network failure
const fail = (r, x, what) => Object.assign(new Error(down(x) ? `remote ${r.name} unreachable: ${x.err || 'ssh failed'}` : `remote ${r.name}: ${what} failed (exit ${x.code}) ${x.err}`.trim()), { down: down(x) });

// The remote login dir, asked once per remote: the default folder of a new conversation, and `~/` in the claude path (spawn has no shell to expand it).
const homes = new Map();
export async function remoteHome(r) {
  if (homes.has(r.name)) return homes.get(r.name);
  const x = await sshRun(r, 'printf %s "$HOME"', { timeout: 20000 }), h = x.out.toString().trim();
  if (x.code !== 0 || !h.startsWith('/')) throw fail(r, x, 'reading $HOME');
  homes.set(r.name, h); return h;
}

// Start a host on the remote. The config (token, prompt text, arguments) goes over stdin into run/<id>.host-cfg.json; setsid detaches the host from this ssh;
// the shell then waits up to 10 s for its info file (same contract as hostlink.spawnHost) and prints it. The cfg file, which holds the token, is removed then.
export async function spawnRemoteHost(r, { id, args, cwd, token }) {
  check(ID, id, 'conversation id');
  const home = await remoteHome(r), f = (s) => `${id}.${s}`;
  const cfg = JSON.stringify({ exe: r.claude.replace(/^~(?=\/)/, home), args, cwd, token, out: f('host-out'), info: f('host.json'), exit: f('host-exit.json') });
  const cmd = `umask 077 && mkdir -p ${RUN} && cd ${RUN} && rm -f ${f('host.json')} ${f('host-exit.json')} ${f('host-out')} && cat > ${f('host-cfg.json')} && `
    + `{ setsid ${r.node} ../host.mjs ${f('host-cfg.json')} >> ${f('host.log')} 2>&1 < /dev/null & } && i=0 && while [ $i -lt 200 ]; do `
    + `if [ -s ${f('host.json')} ]; then rm -f ${f('host-cfg.json')}; cat ${f('host.json')}; exit 0; fi; `
    + `if [ -s ${f('host-exit.json')} ]; then rm -f ${f('host-cfg.json')}; cat ${f('host-exit.json')}; exit 3; fi; sleep 0.05; i=$((i+1)); done; `
    + `rm -f ${f('host-cfg.json')}; tail -c 300 ${f('host.log')}; exit 4`;
  const x = await sshRun(r, cmd, { input: cfg, timeout: 45000 }), text = x.out.toString().trim();
  let o = null; try { o = JSON.parse(text.split('\n').pop()); } catch {}   // last line: a login banner on stdout must not hide the record
  if (x.code === 0 && [o?.pid, o?.port, o?.claudePid].every(Number.isInteger)) return o;
  if (x.code === 3) throw new Error(`remote ${r.name}: claude failed to start: ${o?.err || text}`);
  // Outcome unknown (no record within 10 s, ssh lost, timeout): a host may still come up there with nobody tracking it. Best effort: kill it and drop its cfg.
  // [o]: neither the rm glob nor the pkill pattern may spell the name out, or pkill matches this very shell's command line and kills it. claude dies with its stdin (the host).
  await sshRun(r, `rm -f ${RUN}/${id}.host-cfg.js[o]n; pkill -9 -f -- '${id}.host-cfg.js[o]n'; echo cleaned`, { timeout: 20000 });
  if (x.code === 4) throw new Error(`remote ${r.name}: host did not start (was \`node console/rhost.mjs setup ${r.name}\` run?) ${text.slice(-300)}`);
  throw fail(r, x, 'host start');
}

// Does `pid` still run on the remote with `needle` in its command line? true / false / null (ssh failed: unknown). The needle (the host's own cfg name,
// claude's session id) is the pid-reuse guard, like procid.mjs locally. /proc: the remote is Linux.
export async function remoteAlive(r, pid, needle) {
  const x = await sshRun(r, `tr '\\0' ' ' < /proc/${check(PID, pid, 'pid')}/cmdline 2>/dev/null | grep -qF -- ${check(NEEDLE, needle, 'needle')} && echo yes || echo no`, { timeout: 20000 });
  const o = x.out.toString().trim().split('\n').pop();   // last line: a login banner must not turn the answer into "unknown"
  return down(x) ? null : o === 'yes' ? true : o === 'no' ? false : null;
}
// SIGKILL `pid` on the remote, only when its command line carries one of the needles. tree: its whole process group (host.mjs starts claude as a group leader).
// Resolves false when ssh failed (nothing was killed), never rejects.
export async function remoteKill(r, pid, needles, tree) {
  const ns = [].concat(needles).filter(Boolean);
  if (!pid || !ns.length) return true;
  if (!PID.test(String(pid)) || !ns.every((n) => NEEDLE.test(n))) return false;   // never on a command line; reported like a kill that did not happen
  const p = String(pid), e = ns.map((n) => '-e ' + n).join(' ');
  const x = await sshRun(r, `if tr '\\0' ' ' < /proc/${p}/cmdline 2>/dev/null | grep -qF ${e}; then kill -9 ${tree ? `-- -${p} 2>/dev/null || kill -9 ${p}` : p}; fi; true`, { timeout: 20000 });
  return !down(x);
}
// Remove one conversation's host files on the remote (its host is gone). Never rejects.
export const remoteClean = (r, id) => sshRun(r, `cd ${RUN} 2>/dev/null && rm -f ${['host-cfg.json', 'host.json', 'host-out', 'host-exit.json', 'host.log'].map((s) => `${check(ID, id, 'id')}.${s}`).join(' ')}; true`, { timeout: 20000 });
// What a host that is gone wrote after byte `from` (the console was away when it finished): the same { line, end } list hostlink.readOutFrom gives for a local one.
export async function remoteOutFrom(r, id, from) {
  const x = await sshRun(r, `tail -c +${Math.max(0, Math.floor(+from) || 0) + 1} -- ${RUN}/${check(ID, id, 'id')}.host-out 2>/dev/null; true`, { timeout: 120000, max: 256 * 1024 * 1024 });
  if (x.code !== 0) throw fail(r, x, 'reading host output');
  return takeLines(x.out, from).lines;
}

// A file named in a remote conversation, for the preview. Only a regular file under the conversation's folder AFTER the remote realpath (a symlink cannot lead
// out), at most FILE_CAP bytes. -> { real, buf } | null (missing) | 'forbidden' | 'too large'. Paths outside SAFE_PATH (spaces, non-Latin names) are refused.
// The local name rules (isDeniedPath, .claude, preview types) are applied by the caller to both the asked and the real path.
export async function remoteFile(r, cwd, p) {
  const want = path.posix.resolve(cwd, p), base = cwd.replace(/\/+$/, '');
  if (!SAFE_PATH.test(want) || !SAFE_PATH.test(cwd) || !base) return 'forbidden';   // !base: a conversation in / would open the whole machine
  const x = await sshRun(r, `p=$(realpath -e -- ${want} 2>/dev/null) || exit 2; [ -f "$p" ] || exit 2; case "$p" in ${base}/*) ;; *) exit 9;; esac; case "$p" in *[!A-Za-z0-9_./-]*) exit 9;; esac; `
    + `[ "$(stat -c %s -- "$p")" -le ${FILE_CAP} ] || exit 8; printf '%s\\n' "$p"; cat -- "$p"`, { timeout: 120000 });
  if (x.code === 2) return null;
  if (x.code === 9) return 'forbidden';
  if (x.code === 8) return 'too large';
  if (x.code !== 0) throw fail(r, x, 'reading a file');
  const nl = x.out.indexOf(10);
  return { real: x.out.toString('utf8', 0, nl), buf: x.out.subarray(nl + 1) };
}

// A file attached to a remote conversation: its bytes go over ssh stdin into ~/.seat-console/uploads/<id>/<ts>-<n><.ext> (ASCII name: the
// local one may hold Hebrew, which SAFE_PATH refuses), via a .tmp + rename so claude never sees half a file. -> the remote absolute path.
export async function putUpload(r, id, stored, buf) {
  check(ID, id, 'conversation id');
  const name = check(NEEDLE, stored.replace(/^(\d+-\d+)-.*?((?:\.[A-Za-z0-9]{1,10})?)$/, '$1$2'), 'file name'), dir = `${DIR}/uploads/${id}`;
  const x = await sshRun(r, `umask 077 && mkdir -p ${dir} && { cat > ${dir}/${name}.tmp && mv -f ${dir}/${name}.tmp ${dir}/${name} || { rm -f ${dir}/${name}.tmp; exit 1; }; }`, { input: buf, timeout: 300000 });
  if (x.code !== 0) throw fail(r, x, 'copying an attached file');
  return `${await remoteHome(r)}/${dir}/${name}`;
}
// A deleted conversation's attached files on the remote. Never rejects.
export const remoteRmUploads = (r, id) => sshRun(r, `rm -rf -- ${DIR}/uploads/${check(ID, id, 'id')}; true`, { timeout: 20000 });

// The stream connectHost (hostlink.mjs) talks over instead of a TCP socket: this ssh's stdin/stdout ARE the host's loopback port on the remote.
export function sshSocket(r, port) {
  const args = [...sshArgs(r, '').slice(0, -2), '-W', `127.0.0.1:${check(PID, port, 'port')}`, r.target];   // sshArgs minus its target + command
  const p = spawn(SSH, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const d = Duplex.from({ readable: p.stdout, writable: p.stdin });
  p.on('error', (e) => d.destroy(e)); p.on('close', () => d.destroy());
  d.on('close', () => { if (p.exitCode === null) p.kill(); });
  return d;
}

// One-time setup (idempotent): copy host.mjs and the two modules it imports to ~/.seat-console/ on the remote, then show the remote node and claude versions.
// Writes nothing else there. Each file goes over stdin into <name>.tmp and is then renamed, so a half-copied host.mjs never exists. Refused for a read-only remote.
export async function setup(r, log = console.log) {
  if (!r.control) throw new Error(`remote ${r.name} is read-only: setup needs "control": true in remotes.json`);
  for (const f of ['host.mjs', 'hostlink.mjs', 'procid.mjs']) {
    const x = await sshRun(r, `umask 077 && mkdir -p ${RUN} && cat > ${DIR}/${f}.tmp && mv -f ${DIR}/${f}.tmp ${DIR}/${f}`, { input: fs.readFileSync(path.join(HERE, f)) });
    if (x.code !== 0) throw fail(r, x, 'copying ' + f);
    log(`copied ${f} -> ~/${DIR}/${f}`);
  }
  const v = await sshRun(r, `${r.node} --version && ${r.claude} --version < /dev/null`, { timeout: 60000 });
  log(`remote ${r.node} / ${r.claude}: ${v.out.toString().trim().replace(/\n/g, ' / ') || '(no output)'}`);
  if (v.code !== 0) throw fail(r, v, 'checking node + claude');
}

// CLI: node console/rhost.mjs setup <remote name>
if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const [cmd, name] = process.argv.slice(2), r = loadRemotes(path.join(HERE, '..', 'remotes.json'), os.homedir()).find((x) => x.name === name);
  if (cmd !== 'setup' || !r) { console.log('usage: node console/rhost.mjs setup <name of a remotes.json entry with "control": true>'); process.exit(2); }
  setup(r).then(() => console.log(`remote ${name} ready`), (e) => { console.log(String(e.message || e)); process.exit(1); });
}
