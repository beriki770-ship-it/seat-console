// End to end on an ISOLATED instance (own data dir, throwaway HOME, fake claude, free port, Telegram off): a conversation reports 32% context,
// the console asks it for its HANDOFF (once it has settled), the fake writes docs/HANDOFF.md + "HANDOFF-READY:", and a linked successor continues.
//   node console/test-autohandoff-e2e.mjs        (Linux/macOS; exit 0 = pass; skipped on Windows)
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import http from 'node:http'; import assert from 'node:assert/strict';
import { spawn } from 'node:child_process'; import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
if (process.platform === 'win32') { console.log('SKIP | test-autohandoff-e2e | Linux/macOS only'); process.exit(0); }
const PORT = await new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-autohandoff-')), DATA = path.join(WORK, 'data'), CWD = path.join(WORK, 'proj');
fs.mkdirSync(path.join(CWD, '.git'), { recursive: true }); fs.mkdirSync(path.join(WORK, 'home'), { recursive: true }); fs.mkdirSync(DATA, { recursive: true });
const ROOT_SEATS = path.join(HERE, '..', 'seats.json'), OWN_SEATS = !fs.existsSync(ROOT_SEATS);   // seat init (seat.sh) reads the repo's seats.json: a fresh clone (CI) gets a throwaway one, removed at the end
if (OWN_SEATS) fs.writeFileSync(ROOT_SEATS, JSON.stringify({ projectsDir: WORK, seats: { demo: { email: 'demo@example.com', role: 'test seat' } } }));
const SEAT = Object.entries(JSON.parse(fs.readFileSync(ROOT_SEATS, 'utf8').replace(/^﻿/, '')).seats).filter(([, v]) => !v.agent).pop()[0];
fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ language: 'en', guideOffered: 'done', autoHandoff: true }));   // auto handoff is opt-in (off by default)
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/i.test(k))); env.HOME = path.join(WORK, 'home');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let TOKEN = null;
const api = (method, p, body) => new Promise((ok, no) => {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p, timeout: 15000, headers: { ...(TOKEN ? { 'X-Seat-Token': TOKEN } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, (res) => {
    let t = ''; res.setEncoding('utf8'); res.on('data', (d) => (t += d)); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} ok({ status: res.statusCode, json: j, text: t }); });
  });
  req.on('error', no); req.on('timeout', () => req.destroy(new Error('timeout'))); if (data) req.write(data); req.end();
});
async function until(fn, ms, what) { const t0 = Date.now(); for (;;) { let v; try { v = await fn(); } catch {} if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await sleep(250); } }
const log = () => { try { return fs.readFileSync(path.join(DATA, 'server.log'), 'utf8'); } catch { return ''; } };
const conv = async (id) => (await api('GET', '/api/conversation?id=' + id)).json;
const fd = fs.openSync(path.join(DATA, 'server.log'), 'a');
const srv = spawn(process.execPath, [path.join(HERE, 'server.mjs'), '--port', String(PORT), '--data', DATA, '--claude', path.join(HERE, 'fixtures', 'fake-claude.mjs')], { stdio: ['ignore', fd, fd], env, cwd: HERE });
fs.closeSync(fd);
let failed = false;
try {
  await until(async () => (await api('GET', '/health')).status === 200, 60000, '/health');
  TOKEN = fs.readFileSync(path.join(DATA, 'token.txt'), 'utf8').trim();
  assert.match(log(), /\[autohandoff\] on at 30% \(floor 120k, rollover\): 0 local conversation/);
  console.log('ok  starts with the rule on (30%, floor 120k, rollover)');

  // a second conversation with "don't auto-handoff" is never touched, even at 50%
  const off = (await api('POST', '/api/send', { seat: SEAT, text: 'ctx=500000 skip me', cwd: CWD, title: 'Opted out' })).json.conversationId;
  assert.equal((await api('POST', '/api/noautohandoff', { conversationId: off, off: true })).status, 200);

  const r = await api('POST', '/api/send', { seat: SEAT, text: 'ctx=320000 working on it', cwd: CWD, title: 'Demo work' });
  assert.equal(r.status, 200, r.text); const id = r.json.conversationId;
  await until(() => log().includes(`[autohandoff] conv=${id.slice(0, 8)} armed at 32%`), 15000, 'armed at 32%');
  console.log('ok  armed at the result of the turn that crossed 30%');
  await until(() => log().includes(`[autohandoff] conv=${id.slice(0, 8)} at 32%: handoff asked (try 1)`), 20000, 'asked once settled');
  const ev = (await conv(id)).events.find((e) => e.type === 'console_user' && e.text.startsWith('🧭 Console: context at 32% —'));
  assert.ok(ev, 'the console message is in the conversation'); assert.ok(ev.text.includes(path.join(CWD, 'docs', 'HANDOFF.md')), 'names the project HANDOFF (git root)');
  console.log('ok  "🧭 Console: context at 32% —" sent after the turn settled, names ' + path.join('<proj>', 'docs', 'HANDOFF.md'));
  const nid = (await until(() => /\[autohandoff\] conv=(\w{8}) -> (\w{8})/.exec(log())?.[2], 30000, 'successor'));
  const old = (await conv(id)).conv; assert.equal(old.archived, true, 'old one archived');
  assert.ok(fs.readFileSync(path.join(CWD, 'docs', 'HANDOFF.md'), 'utf8').includes('handoff at 320000 tokens'));
  const succ = (await until(async () => { const j = await conv(Object.values(JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8')).conversations).find((c) => c.id.startsWith(nid)).id); return j?.conv?.status === 'idle' && j; }, 20000, 'successor idle'));
  assert.equal(succ.conv.title, 'Demo work ↻2'); assert.equal(succ.conv.cwd, CWD);
  assert.ok(succ.events.find((e) => e.type === 'console_user' && e.text.startsWith(`Continue from ${path.join(CWD, 'docs', 'HANDOFF.md')}: read it first`)), 'first message');
  assert.ok(succ.events.find((e) => e.type === 'console_note' && e.key === 'log.ahContinues' && e.link.id === id), 'successor links back');
  assert.ok((await conv(id)).events.find((e) => e.type === 'console_note' && e.key === 'log.ahHandedOff' && e.link.id === succ.conv.id), 'old links forward');
  const st = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8')).conversations;
  assert.equal(st[id].autoHandoff.stage, 'done'); assert.equal(st[id].autoHandoff.to, succ.conv.id);
  console.log(`ok  linked successor "${succ.conv.title}" started with "Continue from …HANDOFF.md", old archived, notes link both ways`);
  await sleep(8000);
  assert.ok(!log().includes(`[autohandoff] conv=${off.slice(0, 8)}`), 'opted-out conversation untouched');
  assert.ok(!log().includes(`[autohandoff] conv=${succ.conv.id.slice(0, 8)}`), 'successor not armed (no loop)');
  assert.equal((log().match(/handoff asked/g) || []).length, 1, 'asked exactly once');
  console.log('ok  no loop (asked once, successor not armed), "don\'t auto-handoff" conversation untouched at 50%');
} catch (e) { failed = true; console.log('FAIL', e.message, '\n--- server.log tail ---\n' + log().split('\n').slice(-30).join('\n')); }
finally { srv.kill('SIGTERM'); await sleep(1500); if (srv.exitCode === null) srv.kill('SIGKILL'); fs.rmSync(WORK, { recursive: true, force: true }); if (OWN_SEATS) fs.rmSync(ROOT_SEATS, { force: true }); }
console.log(failed ? 'test-autohandoff-e2e FAIL' : 'test-autohandoff-e2e PASS'); process.exit(failed ? 1 : 0);
