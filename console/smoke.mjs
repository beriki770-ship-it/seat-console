// Seat Console smoke test (run it through smoke.ps1). Starts the TEST instance (port 4851, fresh data dir console/test-data/smoke-<ts>) and drives its real HTTP API with
// claude-haiku-4-5 on the ops seat. Prints one table row per step; exit 0 = every step passed. The data dir is deleted at the end, also after a failure.
// Never touches production 4850: it only ever kills the node it started itself, and the host/claude processes that carry this run's dir or conversation ids.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { wallAsUtc } from './cron.mjs';
import { cbData } from './routines.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), PORT = 4851, MODEL = 'claude-haiku-4-5';
const DIR = path.join(HERE, 'test-data', 'smoke-' + new Date().toISOString().replace(/\D/g, '').slice(0, 14));
// The claude cwd lives under %TEMP%, not in the repo: a file the test claude writes inside the seats repo makes the global handoff-guard Stop hook
// order it to update the REAL docs/HANDOFF.md (measured 2026-10-13: two smoke runs appended fake entries and step c failed on the detour). The hook skips Temp.
const WORK = path.join(os.tmpdir(), 'seat-' + path.basename(DIR));
const CWD = path.join(WORK, 'cwd'), OUTSIDE = path.join(WORK, 'outside'), ROUTINES = path.join(DIR, 'routines.json');
const START = Date.now(), DEADLINE = 340000;   // the whole run must stay under 6 minutes
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOMEM = ' Use no tools and save no memory.';
const ONLY = ' This is an automated smoke test: do exactly this and nothing else (no memory, no handoff or docs, no extra files or tools).';
let TOKEN = null, srv = null; const ids = [];   // ids = every conversation this run created (used to find leftover claude processes)

// ---- http against the test instance ----
function api(method, p, body, { token = TOKEN, headers = {} } = {}) {
  return new Promise((ok, no) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = { ...(token ? { 'X-Seat-Token': token } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers };
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h, timeout: 60000 }, (res) => {
      const ch = []; res.on('data', (x) => ch.push(x));
      res.on('end', () => { const buf = Buffer.concat(ch), text = buf.toString('utf8'); let json = null; try { json = JSON.parse(text); } catch {} ok({ status: res.statusCode, text, json, bytes: buf.length }); });
    });
    req.on('error', no); req.on('timeout', () => req.destroy(new Error('request timeout')));
    if (data) req.write(data); req.end();
  });
}
async function until(fn, ms, what, every = 300) {
  const t0 = Date.now();
  for (;;) {
    let v = null; try { v = await fn(); } catch (e) { if (e.fatal) throw e; }   // a transient request error just retries; a `fatal` one (error status) ends the wait
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout: ' + what);
    if (Date.now() - START > DEADLINE) throw new Error('global 6 min deadline hit while waiting for: ' + what);
    await sleep(every);
  }
}
const conv = async (id) => { const r = await api('GET', '/api/conversation?id=' + id); if (r.status !== 200) throw new Error('conversation ' + r.status); return r.json; };
const logOf = (id) => { try { return fs.readFileSync(path.join(DIR, 'logs', 'ops', id + '.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const lastResult = (id) => logOf(id).findLast((e) => e.type === 'result')?.result || '';
// idle = turn over. error / interrupted end the wait at once with the console's own explanation.
const fatal = (msg) => Object.assign(new Error(msg), { fatal: true });
async function waitIdle(id, ms = 90000) {
  return until(async () => {
    const j = await conv(id), s = j.conv.status;
    if (s === 'error' || s === 'interrupted') throw fatal(`status ${s}: ` + (logOf(id).findLast((e) => e.type === 'console_error')?.text || 'no console_error'));
    return s === 'idle' ? j : null;
  }, ms, `conversation ${id.slice(0, 8)} idle`);
}
async function post(p, body) { const r = await api('POST', p, body); if (r.status !== 200) throw new Error(`${p} -> ${r.status} ${r.text.slice(0, 200)}`); return r.json; }
const send = (b) => post('/api/send', { model: MODEL, cwd: CWD, ...b });

// ---- the test instance process ----
function startServer(extra = []) {
  const fd = fs.openSync(path.join(DIR, 'server.log'), 'a');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/i.test(k)));   // seat.ps1 -InitOnly chokes on CLAUDE_* from a Claude session
  srv = spawn(process.execPath, [path.join(HERE, 'server.mjs'), '--port', String(PORT), '--data', DIR, '--routines', ROUTINES, ...extra], { stdio: ['ignore', fd, fd], windowsHide: true, env, cwd: HERE });
  fs.closeSync(fd); srv.exited = false; srv.on('exit', () => { srv.exited = true; });
}
async function killServer() { if (srv && !srv.exited) { srv.kill(); await until(async () => srv.exited, 10000, 'test node exit', 100); } }
const waitReady = () => until(async () => (await api('GET', '/health')).status === 200, 60000, '/health 200', 100);
const serverLog = () => { try { return fs.readFileSync(path.join(DIR, 'server.log'), 'utf8'); } catch { return ''; } };
// node.exe / claude.exe whose command line carries this run's data dir name or one of its conversation ids
function leftovers() {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|claude)\\.exe$' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"], { encoding: 'utf8', maxBuffer: 2e7 }).trim();
  const list = out ? [].concat(JSON.parse(out)) : [], tag = path.basename(DIR).toLowerCase();
  return list.filter((p) => { const c = String(p.CommandLine || '').toLowerCase(); return c.includes(tag) || ids.some((i) => c.includes(i)); });
}

// ---- steps ----
const rows = [], res = {};
async function step(key, name, fn, needs = []) {
  const t0 = Date.now(); let status = 'PASS', detail = '';
  const missing = needs.filter((k) => res[k] !== 'PASS');
  try { if (missing.length) throw new Error('skipped: needs ' + missing.join(', ')); detail = (await fn()) || ''; }
  catch (e) { status = 'FAIL'; detail = String(e.message || e).split('\n')[0]; }
  res[key] = status; rows.push({ key, name, status, s: ((Date.now() - t0) / 1000).toFixed(1), detail });
  console.log(`${status === 'PASS' ? 'pass' : 'FAIL'}  ${key.padEnd(3)} ${name}  (${((Date.now() - t0) / 1000).toFixed(1)} s)${status === 'FAIL' ? '  ' + detail : ''}`);
}
const S = {};   // facts shared between steps

fs.mkdirSync(DIR, { recursive: true }); fs.mkdirSync(CWD, { recursive: true }); fs.mkdirSync(OUTSIDE, { recursive: true });
{ // the temporary routine: due ~50-110 s after the start, so its ask arrives while the other steps run
  const t = Math.ceil((Date.now() + 50000) / 60000) * 60000, w = new Date(wallAsUtc(t, process.env.SEAT_CONSOLE_TZ || 'Europe/Vienna'));
  fs.writeFileSync(ROUTINES, JSON.stringify([{ id: 'smoke-routine', prompt: 'Reply with exactly the word ROUTINE-OK.' + NOMEM, cron: `${w.getUTCMinutes()} ${w.getUTCHours()} * * *`, seat: 'ops', cwd: CWD, enabled: true, mode: 'auto', model: MODEL }]));
}
console.log(`smoke: data dir ${DIR}`);
try {
  startServer(['--slow-start', '1500']);

  await step('g', '/health 503 then 200 on startup', async () => {
    const seen = [], t0 = Date.now(); let body503 = null;
    for (;;) {
      const r = await api('GET', '/health').catch(() => null);
      if (r) { if (!seen.length || seen.at(-1) !== r.status) seen.push(r.status); if (r.status === 503) body503 ??= r.text; if (r.status === 200) break; }
      if (Date.now() - t0 > 60000) throw new Error('never became ready: ' + seen);
      await sleep(15);
    }
    TOKEN = fs.readFileSync(path.join(DIR, 'token.txt'), 'utf8').trim();
    if (!seen.includes(503) || seen.at(-1) !== 200) throw new Error('sequence was ' + seen.join('>'));
    if (!/"ready":false/.test(body503)) throw new Error('503 body: ' + body503);
    return `${seen.join(' > ')} after ${Date.now() - t0} ms`;
  });

  await step('h', 'foreign Origin 403, missing/wrong token 403', async () => {
    const a = await api('GET', '/api/seats', undefined, { headers: { Origin: 'https://evil.example' } });
    const b = await api('POST', '/api/send', { seat: 'ops', text: 'x' }, { token: null });
    const c = await api('POST', '/api/send', { seat: 'ops', text: 'x' }, { token: 'wrong' });
    const d = await api('POST', '/api/send', { seat: 'ops', text: 'x' }, { headers: { Origin: 'https://evil.example' } });
    if ([a.status, b.status, c.status, d.status].some((s) => s !== 403)) throw new Error(`statuses ${a.status}/${b.status}/${c.status}/${d.status}, want 403 x4`);
    return 'evil Origin GET 403, POST without token 403, wrong token 403, evil Origin POST 403';
  }, ['g']);

  await step('a', 'new conversation: reply arrives, status idle', async () => {
    const r = await send({ seat: 'ops', mode: 'auto', text: 'Reply with exactly the word PONG1.' + NOMEM }); S.a = r.conversationId; S.sid = r.sessionId; ids.push(S.a);
    await waitIdle(S.a); if (!/PONG1/.test(lastResult(S.a))) throw new Error('reply was: ' + lastResult(S.a).slice(0, 80));
    return `conv ${S.a.slice(0, 8)} -> "${lastResult(S.a).trim().slice(0, 20)}"`;
  }, ['g']);

  await step('b', 'second message keeps the session id', async () => {
    const r = await send({ seat: 'ops', conversationId: S.a, text: 'Reply with exactly the word PONG2.' + NOMEM });
    await waitIdle(S.a); const j = await conv(S.a);
    if (r.sessionId !== S.sid || j.conv.sessionId !== S.sid) throw new Error(`session id changed ${S.sid.slice(0, 8)} -> ${j.conv.sessionId.slice(0, 8)}`);
    if (!/PONG2/.test(lastResult(S.a))) throw new Error('reply was: ' + lastResult(S.a).slice(0, 80));
    return `session ${S.sid.slice(0, 8)} unchanged, ${logOf(S.a).filter((e) => e.type === 'result').length} results`;
  }, ['a']);

  await step('i', '/api/conversation under 200 KB', async () => {
    const r = await api('GET', '/api/conversation?id=' + S.a), kb = r.bytes / 1024;
    if (kb >= 200) throw new Error(kb.toFixed(1) + ' KB'); return kb.toFixed(1) + ' KB';
  }, ['b']);

  await step('c', 'ask mode: Write outside cwd -> waiting -> approve -> done', async () => {
    const target = path.join(OUTSIDE, 'approve-me.txt');
    const r = await send({ seat: 'ops', mode: 'ask', text: `Use the Write tool to create the file ${target} with the content hello. Then reply with exactly the word DONE-C.${ONLY}` }); S.c = r.conversationId; ids.push(S.c);
    let approvals = 0, first = null;
    await until(async () => {
      const j = await conv(S.c), s = j.conv.status;
      if (s === 'error' || s === 'interrupted') throw fatal('status ' + s);
      if (s === 'waiting' && j.pending.length) { first ??= { n: j.pending.length, tool: logOf(S.c).findLast((e) => e.type === 'console_perm')?.tool }; for (const rid of j.pending) { await post('/api/permission', { conversationId: S.c, requestId: rid, allow: true }); approvals++; } }
      return s === 'idle';
    }, 120000, 'ask-mode turn to finish', 400);
    if (!first) throw new Error('never reached waiting with a pending request');
    if (!fs.existsSync(target)) throw new Error('approved, but the file was not written');
    return `waiting (${first.tool}) -> ${approvals} approval(s) -> file written`;
  }, ['g']);

  await step('f', 'routine due now: ONE ask, tap starts it', async () => {
    const view = () => api('GET', '/api/routines').then((r) => r.json.find((x) => x.id === 'smoke-routine'));
    const asked = await until(async () => { const v = await view(); return v?.decision === 'pending' ? v : null; }, 150000, 'the routine ask', 1000);
    const asks = serverLog().split('\n').filter((l) => l.includes('[routine] ask smoke-routine')).length;
    if (asks !== 1) throw new Error(`${asks} asks logged, want 1`);
    S.slot = asked.lastAskedFor;
    const tap = await post('/api/routine', { action: 'tap', data: cbData('r', 'smoke-routine', asked.lastAskedFor) });
    if (tap.toast !== 'started') throw new Error('tap answered: ' + JSON.stringify(tap));
    const v = await view(); if (!v.conversationId) throw new Error('no conversation after the tap'); S.r = v.conversationId; ids.push(S.r);
    await waitIdle(S.r); if (!/ROUTINE-OK/.test(lastResult(S.r))) throw new Error('reply was: ' + lastResult(S.r).slice(0, 80));
    const again = await post('/api/routine', { action: 'tap', data: cbData('r', 'smoke-routine', asked.lastAskedFor) });
    if (again.toast !== 'already started') throw new Error('second tap: ' + again.toast);
    return '1 ask logged, tap started conv ' + S.r.slice(0, 8) + ', ROUTINE-OK, second tap "already started"';
  }, ['g']);

  await step('d', 'kill test node mid-turn, restart: reattach, finish, no duplicates, no re-ask', async () => {
    const r = await send({ seat: 'ops', mode: 'bypass', text: `Run exactly 5 Bash tool calls, one after another, each as its OWN separate call, in this order: ${[1, 2, 3, 4, 5].map((n) => `"sleep 6 && echo S${n}"`).join(', ')}. Then reply with exactly the word FINISHED-D.${ONLY}` }); S.d = r.conversationId; ids.push(S.d);
    await until(async () => (await conv(S.d)).conv.status === 'working' && fs.existsSync(path.join(DIR, 'logs', 'ops', S.d + '.jsonl')) && fs.readFileSync(path.join(DIR, 'logs', 'ops', S.d + '.jsonl'), 'utf8').includes('"tool_use"'), 90000, 'a tool call to start', 400);
    const before = logOf(S.d).length;
    await killServer(); startServer(); await waitReady();
    const reattached = serverLog().includes(`[host] reattached conv=${S.d.slice(0, 8)}`);
    if (!reattached) throw new Error('no "[host] reattached" log line for the conversation');
    await waitIdle(S.d, 150000);
    const ev = logOf(S.d), results = ev.filter((e) => e.type === 'result');
    if (!/FINISHED-D/.test(lastResult(S.d))) throw new Error('reply was: ' + lastResult(S.d).slice(0, 80));
    if (results.length !== 1) throw new Error(results.length + ' result events, want 1');
    if (ev.filter((e) => e.type === 'console_spawn').length !== 1) throw new Error('claude was spawned again');
    const uu = ev.map((e) => e.uuid).filter(Boolean); if (new Set(uu).size !== uu.length) throw new Error('duplicate event uuids: ' + (uu.length - new Set(uu).size));
    const ho = ev.filter((e) => e.hoff); for (let i = 1; i < ho.length; i++) if (ho[i].hgen === ho[i - 1].hgen && ho[i].hoff <= ho[i - 1].hoff) throw new Error('host offsets not strictly increasing at event ' + i);
    const v = (await api('GET', '/api/routines')).json.find((x) => x.id === 'smoke-routine');
    const asks = serverLog().split('\n').filter((l) => l.includes('[routine] ask smoke-routine')).length;
    if (asks !== 1 || v.lastAskedFor !== S.slot) throw new Error(`routine asked again after the restart (${asks} asks)`);
    return `${before} events at the kill, ${ev.length} at the end, 1 result, 1 spawn, ${uu.length} uuids unique, routine not re-asked`;
  }, ['f']);

  await step('e', 'stop then send within 300 ms: same session id', async () => {
    const sid = (await conv(S.a)).conv.sessionId, t0 = Date.now();
    const stop = api('POST', '/api/stop', { conversationId: S.a }, {}); await sleep(100);
    const gap = Date.now() - t0, sent = send({ seat: 'ops', conversationId: S.a, text: 'Reply with exactly the word PONG3.' + NOMEM });
    const [s, r] = await Promise.all([stop, sent]); if (s.status !== 200) throw new Error('stop -> ' + s.status);
    if (gap >= 300) throw new Error('gap ' + gap + ' ms');
    await waitIdle(S.a); const j = await conv(S.a);
    if (j.conv.sessionId !== sid || r.sessionId !== sid) throw new Error('session id changed');
    if (!/PONG3/.test(lastResult(S.a))) throw new Error('reply was: ' + lastResult(S.a).slice(0, 80));
    return `send ${gap} ms after stop, resumed session ${sid.slice(0, 8)}, PONG3`;
  }, ['b']);

  await step('j', 'retention: archive -> gz, read back after restart, next message restores', async () => {
    const total = (await conv(S.a)).total, jsonl = path.join(DIR, 'logs', 'ops', S.a + '.jsonl'), gz = path.join(DIR, 'logs', 'archive', 'ops', S.a + '.jsonl.gz');
    await post('/api/archive', { conversationId: S.a, archived: true }); await post('/api/stop', { conversationId: S.a });
    const rep = await post('/api/retention', {});
    if (!rep.compressed.some((f) => f.id === S.a) || fs.existsSync(jsonl) || !fs.existsSync(gz)) throw new Error('not archived: ' + JSON.stringify(rep.skipped.slice(0, 1)));
    await killServer(); startServer(); await waitReady();   // a fresh process has nothing in memory: the read must come from the gz
    const j = await conv(S.a); if (j.total !== total || j.events.length === 0) throw new Error(`read from archive gave ${j.total} events, was ${total}`);
    await send({ seat: 'ops', conversationId: S.a, text: 'Reply with exactly the word PONG4.' + NOMEM }); await waitIdle(S.a);
    if (!fs.existsSync(jsonl) || fs.existsSync(gz)) throw new Error('jsonl was not restored / gz still there');
    if (logOf(S.a).length <= total) throw new Error('restored log did not keep the old events plus the new ones');
    if (!/PONG4/.test(lastResult(S.a)) || (await conv(S.a)).conv.sessionId !== S.sid) throw new Error('reply / session id wrong after restore');
    return `${total} events: jsonl -> gz, read from gz after restart, restored on the next message, same session`;
  }, ['e']);

  await step('k', 'morning digest builds', async () => {
    const r = await api('GET', '/api/digest'); if (r.status !== 200) throw new Error('status ' + r.status);
    const t = r.json.text, need = ['☀️ <b>Good morning</b>', '⚙️ <b>ops</b>', '✅ Nothing is stuck', 'smoke-routine'];
    const miss = need.filter((x) => !t.includes(x)); if (miss.length) throw new Error('missing in digest: ' + miss.join(' | '));
    if (t.length > 4096) throw new Error('over 4096 chars');
    return `${t.length} chars, ops usage line + routine listed, nothing stuck`;
  }, ['f']);
} catch (e) { console.log('smoke aborted: ' + (e?.stack || e)); rows.push({ key: '-', name: 'run', status: 'FAIL', s: '0', detail: String(e.message || e) }); }

// ---- cleanup: stop every conversation through the API (also tests that path), kill the test node, assert nothing of ours is left, delete the data dir ----
await step('z', 'no leftover node/claude processes, data dir deleted', async () => {
  try { const list = (await api('GET', '/api/seats')).json; for (const s of list) for (const c of s.conversations) { ids.includes(c.id) || ids.push(c.id); await api('POST', '/api/stop', { conversationId: c.id }).catch(() => {}); } } catch {}
  await killServer().catch(() => {}); await sleep(1500);
  const left = leftovers();
  for (const p of left) try { execFileSync('taskkill', ['/PID', String(p.ProcessId), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  for (let i = 0; i < 10 && !process.env.SMOKE_KEEP; i++) { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} if (!fs.existsSync(DIR)) break; await sleep(500); }
  if (!process.env.SMOKE_KEEP) try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
  if (left.length) throw new Error(`${left.length} left behind after Stop + kill (killed now): ` + left.map((p) => `${p.Name}#${p.ProcessId}`).join(' '));
  if (fs.existsSync(DIR) && !process.env.SMOKE_KEEP) throw new Error('data dir could not be deleted');
  return 'none left, dir removed';
});

const total = ((Date.now() - START) / 1000).toFixed(0), failed = rows.filter((r) => r.status !== 'PASS');
console.log('\n step  result  secs  what');
for (const r of rows) console.log(` ${r.key.padEnd(4)}  ${r.status.padEnd(6)}  ${r.s.padStart(5)}  ${r.name}${r.status === 'FAIL' ? '\n                       -> ' + r.detail : '  [' + r.detail.slice(0, 110) + ']'}`);
console.log(`\nSMOKE ${failed.length ? 'FAIL' : 'PASS'}: ${rows.length - failed.length}/${rows.length} steps in ${total} s`);
process.exit(failed.length ? 1 : 0);
