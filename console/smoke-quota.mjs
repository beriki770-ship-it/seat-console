// End-to-end check of the usage-limit resume (quotawait.mjs) with the FAKE claude: node console/smoke-quota.mjs [--port 4853]
// A turn ends on the limit ("quotastop": resets one minute ahead) -> the conversation shows quotaWait -> about 3 minutes later (reset + 2 min margin)
// the console sends RESUME_TEXT by itself and the conversation answers again. Then: a second stop is cancelled with /api/quotawait. ~4 min. Exit 0 = pass.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { spawn } from 'node:child_process';
const HERE = path.dirname(new URL(import.meta.url).pathname), i = process.argv.indexOf('--port'), PORT = i > 0 ? +process.argv[i + 1] : 4853;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-quota-smoke-')), DATA = path.join(WORK, 'data'), CWD = path.join(WORK, 'cwd');
fs.mkdirSync(CWD, { recursive: true }); fs.mkdirSync(path.join(WORK, 'home'), { recursive: true }); fs.mkdirSync(DATA, { recursive: true });
const SEAT = Object.keys(JSON.parse(fs.readFileSync(path.join(HERE, '..', 'seats.json'), 'utf8').replace(/^﻿/, '')).seats).pop();
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/i.test(k))), HOME: path.join(WORK, 'home') };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let TOKEN = null;
const api = (method, p, body) => new Promise((ok, no) => {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p, timeout: 15000, headers: { ...(TOKEN ? { 'X-Seat-Token': TOKEN } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, (res) => {
    let t = ''; res.on('data', (d) => (t += d)); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} ok({ status: res.statusCode, json: j }); });
  });
  req.on('error', no); if (data) req.write(data); req.end();
});
async function until(fn, ms, what) { const t0 = Date.now(); for (;;) { let v; try { v = await fn(); } catch {} if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await sleep(1000); } }
const fd = fs.openSync(path.join(DATA, 'server.log'), 'a');
const srv = spawn(process.execPath, [path.join(HERE, 'server.mjs'), '--port', String(PORT), '--data', DATA, '--claude', path.join(HERE, 'fixtures', 'fake-claude.mjs')], { stdio: ['ignore', fd, fd], env, cwd: HERE });
const summaryOf = async (id) => (await api('GET', '/api/conversation?id=' + id)).json;
let ok = false;
try {
  await until(async () => (await api('GET', '/health')).status === 200, 60000, 'health'); TOKEN = fs.readFileSync(path.join(DATA, 'token.txt'), 'utf8').trim();
  const r = await api('POST', '/api/send', { seat: SEAT, text: 'quotastop please', cwd: CWD }); const id = r.json.conversationId;
  const w = await until(async () => (await summaryOf(id))?.conv?.quotaWait, 30000, 'quotaWait set');
  console.log(`PASS stop marked: resume at ${new Date(w).toISOString()} (in ${Math.round((w - Date.now()) / 1000)} s)`);
  if (w - Date.now() < 60e3 || w - Date.now() > 200e3) throw new Error('resume time not reset+margin');
  const back = await until(async () => { const j = await summaryOf(id); const res = (j?.events || []).filter((e) => e.type === 'result'); const last = res.at(-1); return !j.conv.quotaWait && j.conv.status === 'idle' && res.length >= 2 && last.result.includes('The usage limit has reset') && last; }, 260000, 'resumed by itself');
  console.log(`PASS resumed by the console at ${new Date().toISOString()}: "${back.result.slice(0, 70)}..."`);
  await api('POST', '/api/send', { conversationId: id, text: 'quotastop again' });
  await until(async () => (await summaryOf(id))?.conv?.quotaWait, 30000, 'second quotaWait');
  const c = await api('POST', '/api/quotawait', { conversationId: id }); if (c.status !== 200) throw new Error('cancel ' + c.status);
  if ((await summaryOf(id)).conv.quotaWait) throw new Error('still waiting after cancel');
  console.log('PASS second stop cancelled with /api/quotawait');
  ok = true;
} catch (e) { console.log('FAIL ' + e.message); console.log(fs.readFileSync(path.join(DATA, 'server.log'), 'utf8').split('\n').filter((l) => /quota|error/i.test(l)).slice(-8).join('\n')); }
finally { srv.kill(); await sleep(1500); try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {} }
console.log(ok ? 'SMOKE-QUOTA PASS' : 'SMOKE-QUOTA FAIL'); process.exit(ok ? 0 : 1);
