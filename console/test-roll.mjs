// Run: node console/test-roll.mjs. Rolling correction: the pure parts (roll.mjs segmenter + load guard, public/rolling.js phrase -> span
// mapping and replace decision), then /ws/voice on an isolated test instance (own port, own data dir, fake claude, throwaway HOME): no token
// and a wrong token are refused before the upgrade, and a 17 s Hebrew clip with English words (fixtures/voice-roll-he.wav, 3 sentences)
// streamed at 1x speed as 16 kHz PCM comes back as 3 phrases, each printed with its latency behind the speaker. ROLL_SKIP_LIVE=1 = units only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { VOICE_PY } from './voice.mjs';
import { createSegmenter, rollGuard } from './roll.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { rollMatch, rollDecide, rollTail } = createRequire(import.meta.url)('./public/rolling.js');
const rows = [];
async function t(name, fn) { try { const d = await fn(); rows.push(['PASS', name, d || '']); } catch (e) { rows.push(['FAIL', name, String(e.message || e)]); } }
const tone = (ms, amp = 0.3) => { const n = ms * 16, a = new Int16Array(n); for (let i = 0; i < n; i++) a[i] = Math.round(Math.sin(i / 8) * amp * 32767); return a; };
const quiet = (ms) => new Int16Array(ms * 16);
const cat = (...xs) => { const a = new Int16Array(xs.reduce((s, x) => s + x.length, 0)); let o = 0; for (const x of xs) { a.set(x, o); o += x.length; } return a; };

// ---- segmenter
await t('segmenter: two phrases split at a 1 s pause, times right', () => {
  const s = createSegmenter(), out = [...s.push(cat(quiet(500), tone(2000), quiet(1000), tone(1500), quiet(300))), ...s.flush()];
  assert.equal(out.length, 2);
  assert.ok(Math.abs(out[0].startMs - 500) <= 240 && Math.abs(out[0].endMs - 2700) <= 120, JSON.stringify(out.map((p) => [p.startMs, p.endMs])));
  assert.ok(Math.abs(out[1].startMs - 3500) <= 240, String(out[1].startMs));
  return out.map((p) => `${p.startMs}-${p.endMs}`).join(', ');
});
await t('segmenter: a 0.3 s pause does not split', () => { const s = createSegmenter(); assert.equal([...s.push(cat(tone(1000), quiet(300), tone(1000), quiet(900)))].length, 1); });
await t('segmenter: 12 s without a pause is cut at ~8 s, nothing lost', () => {
  const s = createSegmenter(), out = [...s.push(tone(12000)), ...s.flush()];
  assert.equal(out.length, 2); assert.ok(out[0].endMs - out[0].startMs <= 8000); assert.equal(out[1].startMs, out[0].endMs);
});
await t('segmenter: a 90 ms click is dropped', () => { const s = createSegmenter(); assert.equal([...s.push(cat(quiet(300), tone(90), quiet(1200))), ...s.flush()].length, 0); });
await t('segmenter: odd chunk sizes = same result', () => {
  const pcm = cat(quiet(500), tone(2000), quiet(1000), tone(1500), quiet(800)), s = createSegmenter(), out = [];
  for (let i = 0; i < pcm.length; i += 777) out.push(...s.push(pcm.subarray(i, i + 777)));
  assert.equal(out.length, 2);
});
// ---- load guard
await t('guard: idle box ok; load 31 / phrase 8.5 s / 2nd stream / 4 GB worker pause; a cold first phrase is not judged', () => {
  assert.equal(rollGuard({ load1: 5, lastMs: 4000 }), null);
  assert.equal(rollGuard({ load1: 31 }), 'load');
  assert.equal(rollGuard({ load1: 5, lastMs: 8500 }), 'slow');
  assert.equal(rollGuard({ load1: 5, lastMs: null }), null);
  assert.equal(rollGuard({ others: true }), 'stream');
  assert.equal(rollGuard({ rss: 4 * 2 ** 30 }), 'ram');
});
// ---- phrase -> span mapping (page clock, ms)
const F = (s, e, st = 'open') => ({ s, e, st });
await t('match: each phrase takes the finals typed in its window (incl. the ~1 s final lag)', () => {
  const fin = [F(1500, 6800), F(7700, 11900), F(12700, 16900)];
  assert.deepEqual(rollMatch(fin, { startMs: 1200, endMs: 6240 }), { from: 0, to: 0 });
  assert.deepEqual(rollMatch(fin, { startMs: 7440, endMs: 11200 }), { from: 1, to: 1 });
  assert.deepEqual(rollMatch(fin, { startMs: 12400, endMs: 16240 }), { from: 2, to: 2 });
});
await t('match: two short finals in one phrase = one run', () => { assert.deepEqual(rollMatch([F(1000, 2600), F(2900, 5200), F(9000, 9800)], { startMs: 800, endMs: 4600 }), { from: 0, to: 1 }); });
await t('match: interim words of the phrase still showing = wait', () => { assert.deepEqual(rollMatch([F(1000, 2600)], { startMs: 800, endMs: 4600 }, 3000), { wait: true }); });
await t('match: interim words of a LATER phrase do not hold it', () => { assert.deepEqual(rollMatch([F(1000, 5000)], { startMs: 800, endMs: 4600 }, 6500), { from: 0, to: 0 }); });
await t('match: no final in the window = nomatch', () => { assert.equal(rollMatch([F(9000, 9800)], { startMs: 800, endMs: 4600 }).why, 'nomatch'); });
await t('match: a settled final at the edge is left out, one inside = taken', () => {
  assert.deepEqual(rollMatch([F(800, 4000, 'done'), F(4200, 7000)], { startMs: 3600, endMs: 6400 }), { from: 1, to: 1 });
  assert.equal(rollMatch([F(1000, 2000), F(2200, 3000, 'done'), F(3200, 4500)], { startMs: 800, endMs: 4000 }).why, 'taken');
});
// ---- replace decision
await t('decide: a wrong word -> replace; same words (case/punctuation) -> no', () => {
  assert.equal(rollDecide(' תפתח בבקשה את הסרבר לוג', 'תפתח בבקשה את ה-server log.').replace, true);
  assert.equal(rollDecide('Please open the log', 'please open the log.').why, 'same');
});
await t('decide: empty server text, or word counts too far apart -> no', () => {
  assert.equal(rollDecide('שלום לך', '').why, 'empty');
  assert.equal(rollDecide('אחת שתיים שלוש ארבע חמש שש שבע שמונה', 'אחת').why, 'mismatch');
  assert.equal(rollDecide('שלום', 'שלום לך מה שלומך היום חבר').why, 'mismatch');
});
await t('tail: Smart finish starts after the last settled final', () => {
  assert.equal(rollTail([F(0, 1, 'done'), F(2, 3), F(4, 5, 'done'), F(6, 7)]), 3);
  assert.equal(rollTail([F(0, 1), F(2, 3)]), 0);
  assert.equal(rollTail([F(0, 1, 'done')]), 1);
});

// ---- /ws/voice on an isolated test instance
if (process.env.ROLL_SKIP_LIVE !== '1' && !fs.existsSync(VOICE_PY)) console.log(`skip live part: no Whisper python at ${VOICE_PY} (set VOICE_PY)`);
else if (process.env.ROLL_SKIP_LIVE !== '1') {
  const PORT = 4859, REAL_HOME = os.homedir();
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-roll-test-')), DATA = path.join(WORK, 'data');
  fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(path.join(WORK, 'home'), { recursive: true });
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/i.test(k))), HOME: path.join(WORK, 'home'),
    VOICE_PY, HF_HOME: process.env.HF_HOME || path.join(REAL_HOME, '.cache', 'huggingface') };
  const fd = fs.openSync(path.join(DATA, 'server.log'), 'a');
  const srv = spawn(process.execPath, [path.join(HERE, 'server.mjs'), '--port', String(PORT), '--data', DATA, '--claude', path.join(HERE, 'fixtures', 'fake-claude.mjs')], { stdio: ['ignore', fd, fd], env, cwd: HERE });
  fs.closeSync(fd);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const upgradeStatus = (protocol) => new Promise((ok) => {   // the raw handshake: the status line the server answers with
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/ws/voice', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...(protocol ? { 'Sec-WebSocket-Protocol': protocol } : {}) } });
    req.on('upgrade', (res, sock) => { sock.destroy(); ok(res.statusCode); }); req.on('response', (res) => { res.resume(); ok(res.statusCode); }); req.on('error', (e) => ok('err ' + e.message)); req.end();
  });
  let TOKEN = '';
  try {
    for (let i = 0; ; i++) { try { TOKEN = fs.readFileSync(path.join(DATA, 'token.txt'), 'utf8').trim(); if (TOKEN && (await new Promise((ok) => http.get(`http://127.0.0.1:${PORT}/health`, (r) => { r.resume(); ok(r.statusCode === 200); }).on('error', () => ok(false))))) break; } catch {} if (i > 200) throw new Error('server did not start'); await sleep(300); }
    await t('ws: no token = 403', async () => assert.equal(await upgradeStatus(''), 403));
    await t('ws: wrong token = 403', async () => assert.equal(await upgradeStatus('seat, ' + 'x'.repeat(TOKEN.length)), 403));
    await t('ws: the page token = 101', async () => assert.equal(await upgradeStatus('seat, ' + TOKEN), 101));
    await t('ws: 17 s Hebrew+English clip at 1x -> 3 phrases with text', async () => {
      const wav = fs.readFileSync(path.join(HERE, 'fixtures', 'voice-roll-he.wav')), pcm = new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.length - ((wav.length - 44) % 2)));
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/voice`, ['seat', TOKEN]); ws.binaryType = 'arraybuffer';
      const got = [], load = os.loadavg()[0].toFixed(1); let t0 = 0, done = false, paused = null;
      await new Promise((ok, no) => {
        const to = setTimeout(() => no(new Error('no done in 120 s; phrases ' + got.length)), 120000);
        ws.onerror = () => no(new Error('ws error'));
        ws.onopen = () => ws.send(JSON.stringify({ type: 'start', lang: 'he' }));
        ws.onmessage = async (e) => {
          const x = JSON.parse(e.data);
          if (x.type === 'paused') { paused = x.why; clearTimeout(to); ok(); }
          if (x.type === 'phrase') got.push({ ...x, behind: Date.now() - (t0 + x.endMs) });
          if (x.type === 'done') { done = true; clearTimeout(to); ok(); }
          if (x.type !== 'ready') return;
          t0 = Date.now();
          for (let i = 0; i < pcm.length; i += 1600) {   // 100 ms chunks on the real clock, like the page's AudioWorklet
            ws.send(pcm.slice(i, i + 1600).buffer);
            const due = t0 + (i + 1600) / 16; await sleep(Math.max(0, due - Date.now()));
          }
          ws.send(JSON.stringify({ type: 'end' }));
        };
      });
      ws.close();
      assert.equal(paused, null, 'paused: ' + paused); assert.ok(done);
      console.log(`\nLatency at load ${load} (1-min avg at start; now ${os.loadavg()[0].toFixed(1)}):\n| phrase | audio s | server ms | behind speaker ms | text |\n|---|---|---|---|---|`);
      for (const p of got) console.log(`| ${p.phraseId} | ${((p.endMs - p.startMs) / 1000).toFixed(1)} | ${p.ms} | ${p.behind} | ${p.text} |`);
      assert.equal(got.length, 3, got.map((p) => p.text).join(' / '));
      assert.ok(got.every((p) => /[֐-׿]/.test(p.text)), 'Hebrew in every phrase');
      return got.map((p) => p.ms + ' ms').join(', ');
    });
  } finally { srv.kill(); await sleep(300); fs.rmSync(WORK, { recursive: true, force: true }); }
}
for (const [s, n, d] of rows) console.log(`${s === 'PASS' ? 'ok  ' : 'FAIL'} ${n}${d ? ' - ' + d : ''}`);
const failed = rows.filter((r) => r[0] !== 'PASS').length;
console.log(`test-roll: ${rows.length - failed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
