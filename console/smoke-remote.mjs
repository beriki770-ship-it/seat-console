// E2E for conversations STARTED on a remote (rhost.mjs), against a TEST ssh server with the fake claude (fixtures/fake-claude.mjs) installed there.
//   node console/smoke-remote.mjs --target root@127.0.0.1 --ssh-port 2299 --identity <key file> --node <remote node> [--port 4853] [--wsl]
// Writes remotes.json in the repo root (refuses if one exists: never run it in the production checkout), a test instance on --port with its own temp data dir,
// and on the remote: ~/fake (fake claude), ~/proj + ~/ep99-run.jsonl (a finished run to continue), ~/rhost-* (preview files), ~/.seat-console (the setup).
// All of it is removed at the end. --wsl: the remote is this PC's WSL Ubuntu, whose test sshd the script may stop and start (the "unreachable" step).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sshRun } from './rhost.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.join(HERE, '..'), REMOTES = path.join(ROOT, 'remotes.json');
const arg = (n) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : null; };
const PORT = +arg('port') || 4853, WSL = process.argv.includes('--wsl'), WIN = process.platform === 'win32';
if (PORT === 4850) throw new Error('never the production port');
if (fs.existsSync(REMOTES)) throw new Error('remotes.json exists here: run this in a worktree, never in the production checkout');
const R = { name: 'wsl', target: arg('target'), identity: arg('identity'), port: +arg('ssh-port') || null, control: true, node: arg('node') || 'node', claude: '~/fake/claude' };
const DOWN = { name: 'down', target: 'nobody@192.0.2.1', identity: R.identity, control: true, paths: ['~/x-*.jsonl'] };   // TEST-NET-1: never answers
const writeRemotes = (ctl) => fs.writeFileSync(REMOTES, JSON.stringify({ remotes: [{ ...R, control: ctl, seat: 'smoke', paths: ['~/ep99-run.jsonl'] }, DOWN] }));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-rhost-smoke-')), DATA = path.join(WORK, 'data');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/i.test(k)));
const GROUP = 'remote: wsl', RUN_SID = crypto.randomUUID();

let TOKEN = null, srv = null;
function api(method, p, body, headers = {}) {
  return new Promise((ok, no) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p, timeout: 60000, headers: { ...(TOKEN ? { 'X-Seat-Token': TOKEN } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, (res) => {
      const ch = []; res.on('data', (d) => ch.push(d)); res.on('end', () => { const t = Buffer.concat(ch).toString('utf8'); let j = null; try { j = JSON.parse(t); } catch {} ok({ status: res.statusCode, json: j, text: t }); });
    });
    req.on('error', no); req.on('timeout', () => req.destroy(new Error('timeout'))); if (data) req.write(data); req.end();
  });
}
async function until(fn, ms, what) { const t0 = Date.now(); for (;;) { let v; try { v = await fn(); } catch {} if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await sleep(300); } }
const serverLog = () => { try { return fs.readFileSync(path.join(DATA, 'server.log'), 'utf8'); } catch { return ''; } };
function start() {
  fs.mkdirSync(DATA, { recursive: true });
  const fd = fs.openSync(path.join(DATA, 'server.log'), 'a');
  srv = spawn(process.execPath, [path.join(HERE, 'server.mjs'), '--port', String(PORT), '--data', DATA], { stdio: ['ignore', fd, fd], windowsHide: true, env, cwd: HERE }); fs.closeSync(fd);
}
async function startReady() { const t0 = Date.now(); start(); await until(async () => (await api('GET', '/health')).status === 200, 60000, '/health 200'); TOKEN = fs.readFileSync(path.join(DATA, 'token.txt'), 'utf8').trim(); return Date.now() - t0; }
async function kill() { if (!srv) return; const p = srv; srv = null; p.kill('SIGKILL'); await until(async () => (await api('GET', '/health').then(() => false, () => true)), 15000, 'server gone'); }
const conv = async (id) => (await api('GET', '/api/conversation?id=' + id)).json;
const lastResult = (j) => (j?.events || []).findLast((e) => e.type === 'result')?.result || '';
const idleWith = (id, needle, ms = 60000) => until(async () => { const j = await conv(id); return j?.conv?.status === 'idle' && lastResult(j).includes(needle) ? lastResult(j) : null; }, ms, `idle with "${needle}"`);
const pidOf = (text) => +(/\(pid (\d+)\)/.exec(text) || [])[1];
const send = async (b) => { const r = await api('POST', '/api/send', b); if (r.status !== 200) throw new Error(`send ${r.status} ${r.text}`); return r.json; };
const rsh = async (cmd, input) => { const x = await sshRun(R, cmd, { input }); if (x.code !== 0) throw new Error(`remote: ${cmd.slice(0, 60)} -> ${x.code} ${x.err}`); return x.out.toString(); };
const hostInfo = (id) => JSON.parse(fs.readFileSync(path.join(DATA, 'logs', 'remote-wsl', id + '.host.json'), 'utf8'));
const alive = async (pid) => (await rsh(`[ -d /proc/${+pid} ] && echo yes || echo no`)).trim() === 'yes';
const wsl = (script) => execFileSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'sh', '-c', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
// The local ssh processes that carry a link (`-W 127.0.0.1:<port>`) for the given remote port; Windows: CIM, elsewhere ps.
const linkSsh = (port) => {
  const out = WIN ? execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`], { encoding: 'utf8', windowsHide: true })
    : execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return out.split(/\r?\n/).filter((l) => l.includes(`-W 127.0.0.1:${port}`)).map((l) => +l.trim().split(/\s+/)[0]);
};
const killPid = (pid) => { try { process.kill(pid); } catch {} };

const rows = [];
async function step(name, fn) { const t0 = Date.now(); try { const d = await fn(); rows.push(['PASS', name, d]); } catch (e) { rows.push(['FAIL', name, String(e.message || e)]); throw e; } finally { rows.at(-1)[3] = ((Date.now() - t0) / 1000).toFixed(1); } }
let id = null, pid0 = null, sid = null, cid = null;
try {
  await step('remote prepared (fake claude, a finished run log) + `node console/rhost.mjs setup wsl` twice (idempotent)', async () => {
    await rsh('mkdir -p fake proj && cat > fake/fake-claude.mjs', fs.readFileSync(path.join(HERE, 'fixtures', 'fake-claude.mjs')));
    await rsh(`printf '#!/bin/sh\\nexec ${R.node} ~/fake/fake-claude.mjs "$@"\\n' > fake/claude && chmod +x fake/claude`);
    await rsh(`cd proj && echo '{"type":"user","message":{"role":"user","content":"render ep99"}}' | ~/fake/claude -p --session-id ${RUN_SID} > ~/ep99-run.jsonl`);
    writeRemotes(true);
    const outs = [0, 1].map(() => execFileSync(process.execPath, [path.join(HERE, 'rhost.mjs'), 'setup', 'wsl'], { encoding: 'utf8', windowsHide: true }));
    if (!outs.every((o) => /remote wsl ready/.test(o))) throw new Error(outs.join('\n'));
    return outs[1].trim().split('\n').join(' | ') + ' | remote files: ' + (await rsh('ls .seat-console')).trim().split('\n').join(' ');
  });
  await step('start not held up by an unreachable control remote; groups listed', async () => {
    const ms = await startReady();
    const seats = (await api('GET', '/api/seats')).json, g = seats.find((s) => s.name === GROUP), d = seats.find((s) => s.name === 'remote: down');
    if (!g?.control || !d?.control) throw new Error('control groups missing');
    const down = await until(async () => ((await api('GET', '/api/seats')).json.find((s) => s.name === 'remote: down').role.match(/unreachable since \d\d:\d\d/) || [])[0], 60000, 'down group marked');
    return `/health 200 after ${ms} ms; group "${GROUP}" control=${g.control}; "remote: down" role: ${down}`;
  });
  await step('new conversation on the unreachable remote fails with a clear error (no hang)', async () => {
    const t0 = Date.now(), r = await api('POST', '/api/send', { seat: 'remote: down', text: 'x' });
    if (r.status === 200 || !/unreachable/.test(r.json?.error || '')) throw new Error(r.text);
    return `${r.status} "${r.json.error.slice(0, 90)}" after ${Date.now() - t0} ms`;
  });
  await step('new remote conversation (ask mode) starts there and replies', async () => {
    id = (await send({ seat: GROUP, text: 'hello', mode: 'ask' })).conversationId;
    const res = await idleWith(id, 'echo: hello'); pid0 = pidOf(res); const info = hostInfo(id), j = await conv(id);
    if (info.remote !== 'wsl' || info.claudePid !== pid0 || !(await alive(info.pid))) throw new Error(JSON.stringify(info));
    if (j.conv.seat !== GROUP || j.conv.cwd !== '/root') throw new Error(`seat ${j.conv.seat} cwd ${j.conv.cwd}`);
    return `${res} | remote host pid ${info.pid} alive, claude pid ${pid0}; summary seat "${j.conv.seat}", cwd ${j.conv.cwd}`;
  });
  await step('second message keeps the session (same remote claude, same session id)', async () => {
    await send({ conversationId: id, text: 'again' }); const res = await idleWith(id, 'echo: again'), j = await conv(id);
    // the page's events are slim (no session_id): the mirror log on disk has the whole events
    sid = j.conv.sessionId; const sids = new Set(fs.readFileSync(path.join(DATA, 'logs', 'remote-wsl', id + '.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).session_id).filter(Boolean));
    if (pidOf(res) !== pid0 || sids.size !== 1 || !sids.has(id) || sid !== id) throw new Error(`pid ${pidOf(res)} sessions ${[...sids]}`);
    return `${res} | session ${sid}`;
  });
  await step('ask-mode permission round trip through the API (Telegram off on a test instance)', async () => {
    await send({ conversationId: id, text: 'perm check' });
    const j = await until(async () => { const x = await conv(id); return x.conv.status === 'waiting' && x.pending.length ? x : null; }, 30000, 'waiting');
    const r = await api('POST', '/api/permission', { conversationId: id, requestId: j.pending[0], allow: true }); if (r.status !== 200) throw new Error(r.text);
    const res = await idleWith(id, 'allowed: echo: perm check');
    return `waiting, pending ${j.pending[0]} -> allow -> ${res}`;
  });
  await step('files named in the chat are fetched from the remote (size cap, folder + realpath checks)', async () => {
    await rsh(`printf 'remote preview ok' > rhost-prev.txt && ln -sf /etc/hostname rhost-esc.txt && head -c ${25 * 1024 * 1024 + 1} /dev/zero > rhost-big.txt`);
    const get = (p, h = {}) => api('GET', `/api/file?conv=${id}&path=${encodeURIComponent(p)}`, null, { Referer: `http://127.0.0.1:${PORT}/`, ...h });
    const a = await get('rhost-prev.txt'), b = await get('rhost-prev.txt', { Range: 'bytes=0-5' }), c = await get('rhost-esc.txt'), d = await get('/etc/hostname'), e = await get('nope.txt'), f = await get('rhost-big.txt'), g = await api('GET', `/api/file?conv=${id}&path=rhost-prev.txt`);
    const got = [a.status, a.text, b.status, b.text, c.status, d.status, e.status, f.status, g.status];
    if (JSON.stringify(got) !== JSON.stringify([200, 'remote preview ok', 206, 'remote', 403, 403, 404, 413, 403])) throw new Error(JSON.stringify(got));
    return `200 "${a.text}" | Range 206 "${b.text}" | symlink out 403 | /etc/hostname 403 | missing 404 | 25 MB+1 413 | no Referer 403`;
  });
  await step('an attached file is copied to the remote and the message names the REMOTE path (same bytes)', async () => {
    const buf = crypto.randomBytes(300000), sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
    const up = await new Promise((ok, no) => { const q = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: `/api/upload?conv=${id}&name=${encodeURIComponent('summary report.pdf')}`, headers: { 'X-Seat-Token': TOKEN, 'Content-Length': buf.length } }, (res) => { let t = ''; res.on('data', (d) => (t += d)); res.on('end', () => ok(JSON.parse(t))); }); q.on('error', no); q.end(buf); });
    if (!up.file) throw new Error(JSON.stringify(up));
    await send({ conversationId: id, text: 'attach check', files: [up.id] });
    const res = await idleWith(id, 'Attached file: /root/.seat-console/uploads/' + id + '/'), p = /Attached file: (\S+) \(summary report\.pdf, /.exec(res)?.[1];
    const remoteSha = p && (await rsh(`sha256sum -- ${p}`)).split(' ')[0];
    if (remoteSha !== sha(buf)) throw new Error(`${p}: ${remoteSha} != ${sha(buf)}`);
    return `${p} sha256 ${remoteSha.slice(0, 16)} = local`;
  });
  await step('console hard-killed mid-turn: the remote host keeps running, the restart reattaches and the SAME claude finishes the turn', async () => {
    await send({ conversationId: id, text: 'slow after restart' }); await sleep(1000); await kill();
    if (!(await alive(pid0))) throw new Error('remote claude died with the console');
    const ms = await startReady(); const res = await idleWith(id, 'echo: slow after restart', 60000);
    if (pidOf(res) !== pid0) throw new Error('another claude answered: ' + res);
    return `${res} | restart to /health ${ms} ms | log: ${(serverLog().match(/\[host\] reattached conv=\S+/g) || []).pop()}`;
  });
  await step('ssh link killed under the conversation: reconnects, same claude', async () => {
    const pids = linkSsh(hostInfo(id).port); if (pids.length !== 1) throw new Error('link ssh processes: ' + pids);
    pids.forEach(killPid);
    await until(async () => /link to remote wsl dropped/.test(serverLog()) && (await conv(id)).conv.status === 'idle' && linkSsh(hostInfo(id).port).length === 1, 60000, 'reattached');
    await send({ conversationId: id, text: 'after drop' }); const res = await idleWith(id, 'echo: after drop');
    if (pidOf(res) !== pid0) throw new Error(res);
    return `killed ssh ${pids} -> "link to remote wsl dropped" -> new link ${linkSsh(hostInfo(id).port)} -> ${res}`;
  });
  if (WSL) await step('remote unreachable: the row says so; when sshd is back the console reconnects by itself', async () => {
    wsl('kill $(cat /tmp/rhost-sshd/sshd.pid)'); linkSsh(hostInfo(id).port).forEach(killPid);
    const shown = await until(async () => { const c = (await conv(id)).conv; return c.status === 'error' && /unreachable since/.test(c.background) ? `${c.status} · ${c.background}` : null; }, 60000, 'unreachable shown');
    wsl('/usr/sbin/sshd -f /tmp/rhost-sshd/sshd_config');
    await until(async () => (await conv(id)).conv.status === 'idle' && linkSsh(hostInfo(id).port).length === 1, 120000, 'reconnected');
    await send({ conversationId: id, text: 'back again' }); const res = await idleWith(id, 'echo: back again');
    if (pidOf(res) !== pid0) throw new Error(res);
    return `"${shown}" -> sshd started -> reconnected -> ${res}`;
  });
  await step('Stop ends the remote host and claude and removes their files there', async () => {
    const info = hostInfo(id); const r = await api('POST', '/api/stop', { conversationId: id }); if (r.status !== 200) throw new Error(r.text);
    await until(async () => !(await alive(info.pid)) && !(await alive(info.claudePid)), 20000, 'remote processes gone');
    const left = await until(async () => { const l = (await rsh(`ls .seat-console/run/ | grep -c ${id} || true`)).trim(); return l === '0' ? l : null; }, 20000, 'remote files gone');
    if (fs.existsSync(path.join(DATA, 'logs', 'remote-wsl', id + '.host.json'))) throw new Error('local host record left');
    return `host ${info.pid} + claude ${info.claudePid} gone on the remote, ${left} run files left there, local record removed, status ${(await conv(id)).conv.status}`;
  });
  await step('Continue on the finished run: a new conversation resumes its session (--resume) in its folder', async () => {
    const run = (await api('GET', '/api/seats')).json.find((s) => s.name === GROUP).conversations.find((c) => c.title === 'ep99-run' && c.remote);
    if (!run || run.status !== 'idle') throw new Error('run row: ' + JSON.stringify(run));
    const r = await api('POST', '/api/remote-continue', { id: run.id }); if (r.status !== 200) throw new Error(r.text);
    cid = r.json.conversationId; if (r.json.sessionId !== RUN_SID) throw new Error('session ' + r.json.sessionId);
    await send({ conversationId: cid, text: 'go on' }); const res = await idleWith(cid, 'echo: go on'), init = fs.readFileSync(path.join(DATA, 'logs', 'remote-wsl', cid + '.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'system' && e.subtype === 'init');
    const cmd = (await rsh(`tr '\\0' ' ' < /proc/${pidOf(res)}/cmdline`)).trim();
    if (!cmd.includes(`--resume ${RUN_SID}`) || init?.cwd !== '/root/proj' || init?.session_id !== RUN_SID) throw new Error(`${cmd} | ${JSON.stringify(init)}`);
    await api('POST', '/api/stop', { conversationId: cid });
    return `${res} | remote cmdline has "--resume ${RUN_SID.slice(0, 8)}…", init cwd ${init.cwd}, session ${init.session_id.slice(0, 8)}…`;
  });
  await step('read-only stays read-only: control taken away -> conversations parked, every write refused; given back -> restored', async () => {
    await kill(); writeRemotes(false); await startReady();
    const run = (await api('GET', '/api/seats')).json.find((s) => s.name === GROUP);
    const a = await api('POST', '/api/send', { conversationId: id, text: 'x' }), b = await api('POST', '/api/send', { seat: GROUP, text: 'x' }),
      c = await api('POST', '/api/remote-continue', { id: run.conversations.find((x) => x.title === 'ep99-run').id }), d = await api('POST', '/api/stop', { conversationId: cid }), e = await api('POST', '/api/permission', { conversationId: id, requestId: 'x', allow: true });
    const listed = run.conversations.filter((x) => !x.remote).length;
    const got = [a.json.error, b.json.error, c.status, d.json.error, e.json.error, run.control, listed];
    if (JSON.stringify(got) !== JSON.stringify(['unknown conversation', 'unknown seat', 400, 'unknown conversation', 'unknown conversation', false, 0])) throw new Error(JSON.stringify(got));
    await kill(); writeRemotes(true); await startReady();
    const back = (await api('GET', '/api/seats')).json.find((s) => s.name === GROUP).conversations.filter((x) => !x.remote).map((x) => x.id);
    if (!back.includes(id) || !back.includes(cid)) throw new Error('not restored: ' + back);
    return `read-only: send/new/continue/stop/permission -> "${a.json.error}" / "${b.json.error}" / ${c.status} "${c.json.error}" / "${d.json.error}" / "${e.json.error}", 0 started conversations listed | control again: ${back.length} back`;
  });
} catch {} finally {
  await kill().catch(() => {});
  const leftHosts = await sshRun(R, `pgrep -fc '[h]ost.mjs|[f]ake-claude' || true`).then((x) => x.out.toString().trim(), () => '?');
  await sshRun(R, `pkill -9 -f '[h]ost.mjs|[f]ake-claude'; rm -rf .seat-console fake proj ep99-run.jsonl rhost-prev.txt rhost-esc.txt rhost-big.txt`);   // after the count: a failed run leaves nothing either
  rows.push([leftHosts === '0' ? 'PASS' : 'FAIL', 'nothing left: remote host/claude processes', `pgrep host.mjs|fake-claude: ${leftHosts}; remote test files removed`, '']);
  const links = linkSsh('');
  rows.push([links.length ? 'FAIL' : 'PASS', 'nothing left: local link ssh processes', `${links.length} ssh -W processes`, '']);
  fs.rmSync(REMOTES, { force: true }); fs.rmSync(WORK, { recursive: true, force: true });
}
for (const [s, n, d, t] of rows) console.log(`${s}  ${n}${t ? ` (${t} s)` : ''}\n      ${d}`);
const failed = rows.filter((r) => r[0] !== 'PASS').length;
console.log(failed ? `${failed} FAILED` : `all ${rows.length} PASS`); process.exit(failed ? 1 : 0);
