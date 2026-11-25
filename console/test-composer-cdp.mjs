// Run: node console/test-composer-cdp.mjs. Composer smoke test in headless Chrome on an isolated test instance (own free port, data dir,
// fake claude, throwaway HOME and Chrome profile): the page loads with 0 uncaught exceptions and the mic starts live dictation, at 390 (touch)
// and 1440. The 390 run uses an Android Chrome user agent: there live dictation must not open the parallel Smart finish / rolling capture
// (Android's recognizer gets silence while the page holds the microphone: live DIAG 2026-11-25, 0 live words in every Android session).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addTodo } from './todos.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = ['google-chrome', 'chromium', 'chromium-browser'].map((c) => process.env.PATH.split(path.delimiter).map((d) => path.join(d, c)).find((p) => fs.existsSync(p))).find(Boolean);
const rows = [];
if (!CHROME) { console.log('SKIP | test-composer-cdp | no Chrome on PATH (google-chrome / chromium)'); process.exit(0); }
async function t(name, fn) { try { const d = await fn(); rows.push(['PASS', name, d || '']); } catch (e) { rows.push(['FAIL', name, String(e.message || e).slice(0, 400)]); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// SpeechRecognition stand-in (as in test-smartfinish.mjs): __sr.scripts[n] = the n-th session's steps ({ at, text, final }).
const STUB = `(() => { const S = window.__sr = { scripts: [], made: [] };
  class FakeSR { constructor() { this.lang = ''; this.res = []; this.n = S.made.length; S.made.push(this); }
    start() { this.on = true; setTimeout(() => this.onstart?.(), 10); this.timers = (S.scripts[this.n] || []).map((st) => setTimeout(() => { if (!this.on) return; this.emit(st.text, st.final); }, st.at)); }
    emit(text, final) { if (this.res.length && !this.res[this.res.length - 1].isFinal) this.res.pop(); const r = [{ transcript: text }]; r.isFinal = !!final; this.res.push(r); this.onresult?.({ resultIndex: this.res.length - 1, results: this.res }); }
    stop() { this.on = false; this.timers.forEach(clearTimeout); setTimeout(() => this.onend?.(), 50); }
    abort() { if (!this.on) return; this.on = false; this.timers.forEach(clearTimeout); setTimeout(() => this.onend?.(), 10); } }
  window.SpeechRecognition = window.webkitSpeechRecognition = FakeSR;
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); S.gum = 0; navigator.mediaDevices.getUserMedia = (c) => { S.gum++; return gum(c); }; })();`;

const PORT = await new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-composer-test-')), DATA = path.join(WORK, 'data');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(path.join(WORK, 'home'), { recursive: true });
const SEATS_JSON = path.join(WORK, 'seats.json'); fs.writeFileSync(SEATS_JSON, JSON.stringify({ projectsDir: WORK, seats: { ops: { email: 'ops@example.com', role: 'test seat' } } }));   // own seats file: a fresh clone (CI) has no seats.json
// two open tasks on the board: the mic of the SECOND row must fill that row's box only (task dictation, app.js todoDictate)
addTodo(path.join(DATA, 'todos.jsonl'), null, 'First task'); addTodo(path.join(DATA, 'todos.jsonl'), null, 'Second task');
fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ language: 'en', guideOffered: 'done', voiceRolling: false }));   // not a first run; Smart finish on (the default), rolling off (test-rollcdp.mjs covers it)
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/i.test(k))), HOME: path.join(WORK, 'home') };
const fd = fs.openSync(path.join(DATA, 'server.log'), 'a');
const srv = spawn(process.execPath, [path.join(HERE, 'server.mjs'), '--port', String(PORT), '--data', DATA, '--seats', SEATS_JSON, '--claude', path.join(HERE, 'fixtures', 'fake-claude.mjs')], { stdio: ['ignore', fd, fd], env, cwd: HERE });
fs.closeSync(fd);

async function openChrome() {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-composer-chrome-'));
  const ch = spawn(CHROME, ['--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${prof}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', 'about:blank'], { stdio: 'ignore' });
  let dport = 0; for (let i = 0; i < 80 && !dport; i++) { try { dport = +fs.readFileSync(path.join(prof, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch {} if (!dport) await sleep(250); }
  let tgt; for (let i = 0; i < 80 && !tgt; i++) { try { tgt = (await (await fetch(`http://127.0.0.1:${dport}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!tgt) await sleep(250); }
  const ws = new WebSocket(tgt.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = {}, errors = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) pend[d.id](d); if (d.method === 'Runtime.exceptionThrown') errors.push((d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text || '').slice(0, 300)); };
  const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (e) => { const r = await cmd('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed'); return r.result.result.value; };
  await cmd('Runtime.enable'); await cmd('Page.enable');
  await cmd('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  const close = async () => { ch.kill(); await sleep(400); fs.rmSync(prof, { recursive: true, force: true }); };
  return { cmd, ev, errors, close };
}
const until = async (ev, expr, ms, what) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr).catch(() => false)) return; await sleep(200); } throw new Error('timed out waiting for ' + what); };

try {
  if (!CHROME) throw new Error('no Chrome');
  for (let i = 0; ; i++) { if (await new Promise((ok) => http.get(`http://127.0.0.1:${PORT}/health`, (r) => { r.resume(); ok(r.statusCode === 200); }).on('error', () => ok(false)))) break; if (i > 200) throw new Error('server did not start'); await sleep(300); }
  for (const [w, h, mobile] of [[390, 844, true], [1440, 900, false]]) {
    const C = await openChrome();
    try {
      await C.cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
      if (mobile) { await C.cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }); await C.cmd('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36' }); }
      await C.cmd('Page.navigate', { url: `http://localhost:${PORT}/` });   // localhost = a secure context: the page may open the microphone
      let ready = true; try { await until(C.ev, `typeof setData !== 'undefined' && !!setData && !document.getElementById('mic').hidden`, 20000, 'the composer'); } catch { ready = false; }
      await sleep(500);
      await t(`${w}: page loads with 0 uncaught exceptions`, () => { assert.deepEqual(C.errors, []); assert.ok(ready, 'composer not ready'); });
      await t(`${w}: mic visible and tappable`, async () => { const r = await C.ev(`(() => { const b = document.getElementById('mic').getBoundingClientRect(); return { w: b.width, h: b.height, x: b.left, r: b.right }; })()`); assert.ok(r.w > 0 && r.h > 0 && r.x >= 0 && r.r <= w + 0.5, JSON.stringify(r)); });
      // phone: the message box has its own full-width line above the buttons and, filled with a long text, stays within half the screen (scrolls inside)
      if (mobile) await t(`${w}: box above the buttons, full width, at most half the screen`, async () => {
        const r = await C.ev(`(() => { const x = document.getElementById('text'); x.textContent = Array(60).fill('a long dictated line').join('\\n'); const b = x.getBoundingClientRect(), m = document.getElementById('mic').getBoundingClientRect(), a = document.getElementById('addbtn').getBoundingClientRect();
          const o = { bw: b.width, bh: b.height, bottom: b.bottom, micTop: m.top, addTop: a.top, vh: innerHeight, scroll: x.scrollHeight > x.clientHeight }; x.textContent = ''; return o; })()`);
        assert.ok(r.bottom <= r.micTop + 0.5 && r.bottom <= r.addTop + 0.5, 'box not above the buttons ' + JSON.stringify(r));
        assert.ok(r.bw >= w - 40, 'box not full width ' + JSON.stringify(r));
        assert.ok(r.bh <= r.vh / 2 + 1 && r.scroll, 'box taller than half the screen or not scrolling ' + JSON.stringify(r));
        return `box ${Math.round(r.bw)}x${Math.round(r.bh)} of ${r.vh}`;
      });
      await C.ev(`document.getElementById('text').focus(); __sr.scripts[0] = [{ at: 300, text: 'hello there', final: true }]; true`);
      await C.ev(`document.getElementById('mic').click(); true`);
      await t(`${w}: mic starts dictation (stub typed into the box)`, async () => { await until(C.ev, `__sr.made.length > 0 && /hello there/.test(document.getElementById('text').textContent)`, 8000, 'dictated words'); });
      await t(`${w}: parallel microphone capture ${mobile ? 'not opened (Android)' : 'opened (Smart finish)'}`, async () => { if (!mobile) await until(C.ev, `__sr.gum > 0`, 5000, 'getUserMedia'); assert.equal(await C.ev(`__sr.gum`), mobile ? 0 : 1); });
      await C.ev(`document.getElementById('mic').click(); true`); await sleep(1500);
      await t(`${w}: no exception while dictating`, () => assert.deepEqual(C.errors, []));
      // My tasks: the mic beside a task's comment box types into THAT box (not the composer, not the other row), with no parallel capture
      await C.ev(`location.hash = 'todos'; true`);
      await until(C.ev, `document.querySelectorAll('#todos [data-todo] [data-tmic]').length === 2`, 8000, 'task rows with a mic');
      await C.ev(`window.__gum0 = __sr.gum; window.__comp = document.getElementById('text').textContent; __sr.scripts[__sr.made.length] = [{ at: 200, text: 'approve it', final: false }, { at: 400, text: 'approve it please', final: true }]; true`);
      await t(`${w}: task mic visible and tappable`, async () => { const r = await C.ev(`(() => { const b = document.querySelectorAll('#todos [data-tmic]')[1].getBoundingClientRect(); return { w: b.width, h: b.height, r: b.right }; })()`); assert.ok(r.w >= 32 && r.h >= 30 && r.r <= w, JSON.stringify(r)); });
      await C.ev(`document.querySelectorAll('#todos [data-todo] [data-tmic]')[1].click(); true`);
      await t(`${w}: task mic fills that row's comment box only`, async () => {
        await until(C.ev, `document.querySelectorAll('#todos [data-todo] .td-note input')[1].value === 'approve it please'`, 8000, 'the second row box');
        assert.equal(await C.ev(`document.querySelectorAll('#todos [data-todo] .td-note input')[0].value`), '');
        assert.equal(await C.ev(`document.getElementById('text').textContent === window.__comp`), true, 'composer untouched');
        assert.equal(await C.ev(`document.querySelectorAll('#todos [data-tmic]')[1].getAttribute('aria-pressed')`), 'true');
        assert.equal(await C.ev(`__sr.gum - window.__gum0`), 0, 'no parallel microphone capture');
      });
      await C.ev(`document.querySelectorAll('#todos [data-tmic]')[1].click(); true`); await sleep(400);
      await t(`${w}: task mic stops, text stays, no exception`, async () => { assert.equal(await C.ev(`document.querySelectorAll('#todos [data-tmic]')[1].getAttribute('aria-pressed')`), 'false'); assert.equal(await C.ev(`document.querySelectorAll('#todos [data-todo] .td-note input')[1].value`), 'approve it please'); assert.deepEqual(C.errors, []); });
    } finally { await C.close(); }
  }
} catch (e) { rows.push(['FAIL', 'setup', String(e.message || e).slice(0, 300)]); }
finally { srv.kill(); await sleep(300); fs.rmSync(WORK, { recursive: true, force: true }); }

for (const [s, n, d] of rows) console.log(`${s.padEnd(4)}  ${n}${d ? '  — ' + d : ''}`);
const fail = rows.filter((r) => r[0] !== 'PASS').length;
console.log(`\n${rows.length - fail}/${rows.length} passed`);
process.exit(fail ? 1 : 0);
