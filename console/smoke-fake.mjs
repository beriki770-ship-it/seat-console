// Platform smoke test with a FAKE claude (fixtures/fake-claude.mjs): no login, no quota, runs the same on Windows, Linux and macOS.
//   node console/smoke-fake.mjs [--port 4852] [--supervisor]
// Starts a TEST instance (own data dir under the OS temp dir, Telegram off, never port 4850) and proves: a conversation starts and gets a reply;
// a turn in flight survives a hard kill of the node server (its host is reattached, the SAME claude answers); Stop ends host + claude; nothing is left.
// --supervisor (Linux/macOS): the server runs under run-server.sh, and the kill is left to the supervisor to recover from (the production setup).
// On POSIX the server gets a throwaway HOME, so seat.sh prepares seat dirs there, never in the real ~/.claude-seats. Exit 0 = every step passed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pidAlive, readJson } from './hostlink.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : null; };
const PORT = +arg('port') || 4852, SUPERVISED = process.argv.includes('--supervisor'), WIN = process.platform === 'win32';
if (PORT === 4850) throw new Error('never the production port');
if (SUPERVISED && WIN) throw new Error('--supervisor is the POSIX run-server.sh; on Windows the supervisor is run-server.ps1');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-xplat-smoke-')), DATA = path.join(WORK, 'data'), CWD = path.join(WORK, 'cwd');
fs.mkdirSync(CWD, { recursive: true }); fs.mkdirSync(path.join(WORK, 'home'), { recursive: true });
const SEAT = Object.keys(JSON.parse(fs.readFileSync(path.join(HERE, '..', 'seats.json'), 'utf8').replace(/^﻿/, '')).seats).pop();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/i.test(k)));
if (!WIN) env.HOME = path.join(WORK, 'home');
const ARGS = ['--port', String(PORT), '--data', DATA, '--claude', path.join(HERE, 'fixtures', 'fake-claude.mjs')];

let TOKEN = null, srv = null;
function api(method, p, body) {
  return new Promise((ok, no) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p, timeout: 15000, headers: { ...(TOKEN ? { 'X-Seat-Token': TOKEN } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, (res) => {
      let t = ''; res.setEncoding('utf8'); res.on('data', (d) => (t += d)); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} ok({ status: res.statusCode, json: j, text: t }); });
    });
    req.on('error', no); req.on('timeout', () => req.destroy(new Error('timeout'))); if (data) req.write(data); req.end();
  });
}
async function until(fn, ms, what) { const t0 = Date.now(); for (;;) { let v; try { v = await fn(); } catch {} if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await sleep(200); } }
const serverLog = () => { try { return fs.readFileSync(path.join(DATA, 'server.log'), 'utf8'); } catch { return ''; } };
const supLog = () => { try { return fs.readFileSync(path.join(DATA, 'supervisor.log'), 'utf8'); } catch { return ''; } };
const nodePids = () => [...supLog().matchAll(/started node pid=(\d+)/g)].map((m) => +m[1]);
function start() {
  fs.mkdirSync(DATA, { recursive: true });
  if (SUPERVISED) { srv = spawn('sh', [path.join(HERE, 'run-server.sh'), ...ARGS], { stdio: 'ignore', env, cwd: HERE }); return; }
  const fd = fs.openSync(path.join(DATA, 'server.log'), 'a');
  srv = spawn(process.execPath, [path.join(HERE, 'server.mjs'), ...ARGS], { stdio: ['ignore', fd, fd], windowsHide: true, env, cwd: HERE }); fs.closeSync(fd);
}
const ready = () => until(async () => (await api('GET', '/health')).status === 200, 60000, '/health 200');
const conv = async (id) => (await api('GET', '/api/conversation?id=' + id)).json;
const idleWith = (id, needle, ms = 30000) => until(async () => { const j = await conv(id); const last = (j?.events || []).findLast((e) => e.type === 'result'); return j?.conv?.status === 'idle' && last?.result?.includes(needle) ? last.result : null; }, ms, `idle with "${needle}"`);
const hostFile = (id) => path.join(DATA, 'logs', SEAT, id + '.host.json');

const rows = []; let id = null, host = null;
async function step(name, fn) { const t0 = Date.now(); try { const d = await fn(); rows.push(['PASS', name, d]); } catch (e) { rows.push(['FAIL', name, String(e.message || e)]); throw e; } finally { rows.at(-1)[3] = ((Date.now() - t0) / 1000).toFixed(1); } }
try {
  await step('server starts (test instance, fake claude)', async () => { start(); await ready(); TOKEN = fs.readFileSync(path.join(DATA, 'token.txt'), 'utf8').trim(); return `port ${PORT}, platform ${process.platform}${SUPERVISED ? ', under run-server.sh' : ''}`; });
  await step('conversation starts and gets a reply', async () => {
    const r = await api('POST', '/api/send', { seat: SEAT, text: 'hello', cwd: CWD }); if (r.status !== 200) throw new Error(`send ${r.status} ${r.text}`);
    id = r.json.conversationId; const res = await idleWith(id, 'echo: hello'); host = readJson(hostFile(id)); return `${res} | host pid ${host.pid}, claude pid ${host.claudePid}`;
  });
  await step('turn in flight survives a hard kill of the server (host reattached)', async () => {
    const r = await api('POST', '/api/send', { conversationId: id, text: 'slow one' }); if (r.status !== 200) throw new Error(`send ${r.status} ${r.text}`);
    await until(async () => (await conv(id))?.conv?.status === 'working', 5000, 'working');
    const victim = SUPERVISED ? nodePids().at(-1) : srv.pid;
    process.kill(victim, 'SIGKILL'); await sleep(500);
    if (!pidAlive(host.pid) || !pidAlive(host.claudePid)) throw new Error('host or claude died with the server');
    if (SUPERVISED) await until(async () => nodePids().length >= 2, 30000, 'supervisor restarted node'); else start();
    await ready();
    const res = await idleWith(id, 'echo: slow one');
    const now = readJson(hostFile(id)); if (now?.pid !== host.pid) throw new Error(`host changed ${host.pid} -> ${now?.pid}`);
    if (!res.includes(`pid ${host.claudePid}`)) throw new Error('a different claude answered: ' + res);
    const line = serverLog().split('\n').find((l) => l.includes(`[host] reattached conv=${id.slice(0, 8)}`)); if (!line) throw new Error('no "[host] reattached" line in server.log');
    return `killed node ${victim}; ${SUPERVISED ? 'supervisor restarted node ' + nodePids().at(-1) : 'restarted'}; ${line.trim()}; reply "${res}"`;
  });
  await step('the same claude answers after the reattach', async () => {
    const r = await api('POST', '/api/send', { conversationId: id, text: 'after restart' }); if (r.status !== 200) throw new Error(`send ${r.status}`);
    const res = await idleWith(id, 'echo: after restart'); if (!res.includes(`pid ${host.claudePid}`)) throw new Error('different claude: ' + res); return res;
  });
  await step('Stop ends host and claude cleanly', async () => {
    const r = await api('POST', '/api/stop', { conversationId: id }); if (r.status !== 200) throw new Error(`stop ${r.status} ${r.text}`);
    const zombie = (p) => { try { return /\) Z /.test(fs.readFileSync(`/proc/${p}/stat`, 'utf8')); } catch { return false; } };
    await until(async () => [host.pid, host.claudePid].every((p) => !pidAlive(p) || zombie(p)), 10000, 'host + claude gone');
    if (fs.existsSync(hostFile(id))) throw new Error('host.json still there');
    return `status ${(await conv(id)).conv.status}; host ${host.pid} and claude ${host.claudePid} gone, host files removed`;
  });
} catch {} finally {
  if (SUPERVISED) { srv.kill('SIGTERM'); await sleep(1500); } else if (srv && srv.exitCode === null) { srv.kill('SIGKILL'); await sleep(500); }
  const left = [...(SUPERVISED ? [srv.pid, ...nodePids()] : [srv?.pid]), host?.pid, host?.claudePid].filter((p) => p && pidAlive(p) && !(fs.existsSync(`/proc/${p}/stat`) && /\) Z /.test(fs.readFileSync(`/proc/${p}/stat`, 'utf8'))));
  rows.push([left.length ? 'FAIL' : 'PASS', 'no leftover processes', left.length ? 'still running: ' + left.join(' ') : 'server, supervisor, host, claude all gone', '0']);
  for (const p of left) try { process.kill(p, 'SIGKILL'); } catch {}
  if (rows.some((r) => r[0] === 'FAIL')) console.log('--- server.log tail ---\n' + serverLog().split('\n').slice(-25).join('\n'));
  fs.rmSync(WORK, { recursive: true, force: true });
}
for (const [s, n, d, t] of rows) console.log(`${s}  ${String(t).padStart(5)}s  ${n}\n              ${d}`);
const failed = rows.filter((r) => r[0] === 'FAIL').length;
console.log(`\nSMOKE-FAKE ${failed ? 'FAIL' : 'PASS'}: ${rows.length - failed}/${rows.length} (${process.platform})`);
process.exit(failed ? 1 : 0);
