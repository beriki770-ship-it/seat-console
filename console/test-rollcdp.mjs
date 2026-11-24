// Run: node console/test-rollcdp.mjs. Rolling correction in the real page (app.js "Rolling correction" block + roll.mjs), headless Chrome on an
// isolated test instance (own port, data dir, fake claude, throwaway HOME). A fake microphone plays fixtures/voice-roll-he.wav (3 Hebrew
// sentences with English words, 1.2 s pauses); SpeechRecognition is stubbed to type a slightly wrong Hebrew transcript of each sentence at the
// time a browser would. Checks: each sentence is corrected in place a few seconds behind (times printed), text before it is never touched, a
// sentence the owner edited is left alone, Stop with everything settled skips Smart finish, "Undo last correction" restores the last one,
// the DIAG line has counts and no text. With the Gemini engine (a stub agy: no Google call) Gemini still reads the whole clip after rolling
// settled it: its Latin spelling of the English words replaces the dictated part (BEFORE kept); Gemini failing keeps the rolled text and
// Whisper is not run again. Screenshots: /tmp/rolling-1440.png and /tmp/rolling-390.png (SHOT_DIR overrides /tmp).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VOICE_PY } from './voice.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), SHOTS = process.env.SHOT_DIR || '/tmp', WAV = path.join(HERE, 'fixtures', 'voice-roll-he.wav');
const CHROME = ['google-chrome', 'chromium', 'chromium-browser'].map((c) => process.env.PATH.split(':').map((d) => path.join(d, c)).find((p) => fs.existsSync(p))).find(Boolean);
const rows = [];
async function t(name, fn) { try { const d = await fn(); rows.push(['PASS', name, d || '']); } catch (e) { rows.push(['FAIL', name, String(e.message || e).slice(0, 400)]); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// SpeechRecognition stand-in (as in test-smartfinish.mjs): __sr.scripts[n] = the n-th session's steps ({ at, text, final }).
const STUB = `(() => { localStorage.setItem('diagUntil', String(Date.now() + 3600000)); const S = window.__sr = { scripts: [], made: [] };
  class FakeSR { constructor() { this.lang = ''; this.res = []; this.n = S.made.length; S.made.push(this); }
    start() { this.on = true; setTimeout(() => this.onstart?.(), 10); this.timers = (S.scripts[this.n] || []).map((st) => setTimeout(() => { if (!this.on) return; if (st.end) { this.on = false; this.onend?.(); } else this.emit(st.text, st.final); }, st.at)); }
    emit(text, final) { if (this.res.length && !this.res[this.res.length - 1].isFinal) this.res.pop(); const r = [{ transcript: text }]; r.isFinal = !!final; this.res.push(r); this.onresult?.({ resultIndex: this.res.length - 1, results: this.res }); }
    stop() { this.on = false; this.timers.forEach(clearTimeout); const last = this.res[this.res.length - 1]; setTimeout(() => { if (last && !last.isFinal) { last.isFinal = true; this.onresult?.({ resultIndex: this.res.length - 1, results: this.res }); } this.onend?.(); }, 50); }
    abort() { if (!this.on) return; this.on = false; this.timers.forEach(clearTimeout); setTimeout(() => this.onend?.(), 10); } }
  window.SpeechRecognition = window.webkitSpeechRecognition = FakeSR; })();`;
// the clip: speech 1.2-6.2 s, 7.4-11.2 s, 12.4-16.2 s. The stub's finals come ~0.8 s after each sentence ends, slightly wrong.
const S1 = 'תפתח בבקשה את הסרבר לוג ותבדוק למה הדפלוי נכשל', S2 = 'אחרי זה תשלך לי סיכום קצר בטלגרם', S3 = 'ואל תשכח לעדכן את הרידמי בפרויקט';
const SCRIPT = [{ at: 1700, text: 'תפתח בבקשה' }, { at: 7000, text: S1, final: true }, { at: 7900, text: 'אחרי זה' }, { at: 12000, text: S2, final: true }, { at: 12900, text: 'ואל תשכח' }, { at: 17000, text: S3, final: true }];

// Gemini's answer for the whole clip (the stub agy prints it): the English words in Latin letters, as Gemini writes them
const GEM = 'תפתח בבקשה את ה-server log ותבדוק למה ה-deploy נכשל. אחרי זה תשלח לי סיכום קצר ב-Telegram. ואל תשכח לעדכן את ה-README בפרויקט.';
// stub agy: answers like the Antigravity CLI's stream-json (init, result); the file 'mode' next to it says ok or fail (503 no capacity)
const AGY = `#!${process.execPath}
const fs = require('fs'), ok = fs.readFileSync(__dirname + '/mode', 'utf8').trim() === 'ok';
console.log(JSON.stringify({ event: 'init', conversation_id: 'stub-1' }));
console.log(JSON.stringify({ event: 'result', result: ok ? { status: 'SUCCESS', response: JSON.stringify({ text: ${JSON.stringify(GEM)}, langs: ['he', 'en'] }) } : { status: 'ERROR', error: '503 no capacity' } }));`;
const PORT = 4857; let srv = null, WORK = null, DATA = null;
async function startServer() {
  WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-rollcdp-')); DATA = path.join(WORK, 'data');
  fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(path.join(WORK, 'home'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ language: 'en', guideOffered: 'done', voiceSmartEngine: 'whisper' }));   // Smart finish stays on: it must be skipped when rolling settled everything
  fs.mkdirSync(path.join(WORK, 'agy')); fs.writeFileSync(path.join(WORK, 'agy', 'agy'), AGY, { mode: 0o755 }); fs.writeFileSync(path.join(WORK, 'agy', 'mode'), 'ok');
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/i.test(k))), HOME: path.join(WORK, 'home'), SMART_AGY_BIN: path.join(WORK, 'agy', 'agy'),
    VOICE_PY, HF_HOME: process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface') };
  const fd = fs.openSync(path.join(DATA, 'server.log'), 'a');
  srv = spawn(process.execPath, [path.join(HERE, 'server.mjs'), '--port', String(PORT), '--data', DATA, '--claude', path.join(HERE, 'fixtures', 'fake-claude.mjs')], { stdio: ['ignore', fd, fd], env, cwd: HERE });
  fs.closeSync(fd);
  for (let i = 0; ; i++) { if (await new Promise((ok) => http.get(`http://127.0.0.1:${PORT}/health`, (r) => { r.resume(); ok(r.statusCode === 200); }).on('error', () => ok(false)))) return; if (i > 200) throw new Error('server did not start'); await sleep(300); }
}
async function openChrome(w, h, mobile) {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-rollcdp-chrome-'));
  // port 0 = a free one, read back from the profile: a fixed port can be another Chrome on this box (the owner's own browser once)
  const ch = spawn(CHROME, ['--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${prof}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`, '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let dport = 0; for (let i = 0; i < 80 && !dport; i++) { try { dport = +fs.readFileSync(path.join(prof, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch {} if (!dport) await sleep(250); }
  let tgt; for (let i = 0; i < 80 && !tgt; i++) { try { tgt = (await (await fetch(`http://127.0.0.1:${dport}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!tgt) await sleep(250); }
  const ws = new WebSocket(tgt.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = {}, errors = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) pend[d.id](d); if (d.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(d.params.exceptionDetails).slice(0, 300)); };
  const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (e) => { const r = await cmd('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed'); return r.result.result.value; };
  await cmd('Runtime.enable'); await cmd('Page.enable'); await cmd('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  if (mobile) await cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cmd('Page.navigate', { url: `http://localhost:${PORT}/` });   // localhost = a secure context: the microphone may open
  for (let i = 0; i < 100 && !(await ev(`typeof setData !== 'undefined' && !!setData && !document.getElementById('mic').hidden`).catch(() => false)); i++) await sleep(200);
  await ev(`localStorage.removeItem('voiceLiveLang'); micUi(); document.getElementById('text').focus(); document.execCommand('insertText', false, 'BEFORE'); true`);
  const shot = async (f) => fs.writeFileSync(path.join(SHOTS, f), Buffer.from((await cmd('Page.captureScreenshot')).result.data, 'base64'));
  return { cmd, ev, errors, shot, close: async () => { ch.kill(); await sleep(400); fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } };
}
const text = `(() => { const c = document.getElementById('text').cloneNode(true); c.querySelectorAll('.vi').forEach((n) => n.remove()); return c.textContent; })()`;
const until = async (ev, expr, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await sleep(200); } return false; };

if (!CHROME || !fs.existsSync(VOICE_PY)) rows.push(['SKIP', CHROME ? `no Whisper python at ${VOICE_PY} (set VOICE_PY)` : 'no Chrome', '']);
else {
  let C = null;
  try {
    await startServer();
    // ---- 1440: three sentences; the owner edits the 2nd right after it is typed
    C = await openChrome(1440, 900, false);
    await C.ev(`__sr.scripts[0] = ${JSON.stringify(SCRIPT)}; true`);
    const t0 = Date.now(); await C.ev(`document.getElementById('mic').click(); true`);
    const seen = {}; let edited = false, shotDone = false;
    while (Date.now() - t0 < 32000) {
      const v = await C.ev(text), at = Date.now() - t0;
      if (!seen[1] && v.includes('BEFORE') && !v.includes(S1) && v.includes('תפתח')) seen[1] = at;
      if (!seen[3] && v.includes('ואל') && !v.includes(S3)) seen[3] = at;
      if (seen[1] && !shotDone) { await sleep(150); await C.shot('rolling-1440.png'); shotDone = true; }   // the underline flash shows for 1.6 s
      if (!edited && v.includes(S2)) {   // the owner fixes one word of sentence 2 by hand, inside it: rolling must leave that sentence alone
        await C.ev(`(() => { const ed = document.getElementById('text'), w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.data.indexOf('תשלך'); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 4); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('insertText', false, 'תשלח'); return; } } })(); true`);
        edited = true;
      }
      if (at > 17500 && seen[3]) break;
      if (at > 18000 && (await C.ev(`!!mic && !mic.stopping`))) await C.ev(`document.getElementById('mic').click(); true`);   // Stop after the 3rd final
      await sleep(200);
    }
    await until(C.ev, `!document.getElementById('mic').hasAttribute('data-check')`, 20000);
    const after = await C.ev(text);
    console.log('\ncorrected (ms after Start): sentence 1 at', seen[1], '(spoken until ~6200), sentence 3 at', seen[3], '(spoken until ~16200)\nfinal text:', after);
    await t('sentence 1 corrected in place within ~8 s of its end, BEFORE untouched', () => { assert.ok(seen[1] && seen[1] < 6200 + 8000, String(seen[1])); assert.match(after, /^BEFORE /); return `${seen[1] - 6200} ms after the sentence ended`; });
    await t('sentence 2 (edited by the owner) left exactly as edited', () => { assert.ok(after.includes('אחרי זה תשלח לי סיכום קצר בטלגרם'), after); });
    await t('sentence 3 corrected (after Stop: the last phrase is still read)', () => { assert.ok(seen[3], 'never corrected'); assert.ok(!after.includes(S3)); return `${seen[3] - 16200} ms after the sentence ended`; });
    const log = () => fs.readFileSync(path.join(DATA, 'data', 'client-log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    await sleep(1200);
    await t('DIAG roll line: counts only (2 replaced, 1 skipped), no text; Smart finish skipped (no smart line)', () => {
      const ev = log().flatMap((x) => x.events || [x]), roll = ev.filter((e) => e.step === 'roll'), smart = ev.filter((e) => e.step === 'smart');
      console.log('DIAG roll:', JSON.stringify(roll), '\nDIAG smart:', JSON.stringify(smart.map(({ ua, ...e }) => e)), '\nserver:', fs.readFileSync(path.join(DATA, 'server.log'), 'utf8').split('\n').filter((l) => /\[(roll|voice)\]/.test(l)).join('\n'));
      assert.equal(roll.length, 1, JSON.stringify(roll)); assert.equal(roll[0].replaced, 2); assert.ok(roll[0].skipped >= 1); assert.equal(roll[0].paused, null); assert.equal(roll[0].tail, 0);
      assert.equal(smart.length, 0, JSON.stringify(smart));
      assert.doesNotMatch(JSON.stringify(ev), /[֐-׿]/, 'Hebrew text in DIAG');
      return `phrases ${roll[0].phrases}, avg ${roll[0].avgMs} ms`;
    });
    await t('Undo last correction: sentence 3 back to the live words, the rest kept', async () => {
      assert.equal(await C.ev(`document.getElementById('rollundo').hidden`), false, 'Undo button visible');
      await C.ev(`document.getElementById('rollundo').click(); true`);
      const v = await C.ev(text); assert.ok(v.includes(S3), v); assert.ok(!v.includes(S1), 'sentence 1 still corrected');
    });
    await t('marks gone after the 8 s Undo window', async () => { assert.ok(await until(C.ev, `!document.querySelector('#text .vm, #text .vi')`, 10000)); });
    await t('no page errors (1440)', () => assert.deepEqual(C.errors, []));
    const srvLog = fs.readFileSync(path.join(DATA, 'server.log'), 'utf8');
    await t('server.log: roll phrases logged with times, no text', () => { assert.match(srvLog, /\[roll\] phrase 1 /); assert.doesNotMatch(srvLog, /[֐-׿]/); });
    await C.close(); C = null;

    // ---- 390 (phone size): one sentence corrected, screenshot
    C = await openChrome(390, 844, true);
    await C.ev(`__sr.scripts[0] = ${JSON.stringify(SCRIPT.slice(0, 2))}; true`);
    const t1 = Date.now(); await C.ev(`document.getElementById('mic').click(); true`);
    let at390 = 0; while (Date.now() - t1 < 16000) { const v = await C.ev(text); if (!v.includes(S1) && v.includes('תפתח')) { at390 = Date.now() - t1; break; } await sleep(200); }
    await sleep(150); await C.shot('rolling-390.png');
    await t('390: sentence 1 corrected in place', () => { assert.ok(at390, 'never corrected'); return `${at390 - 6200} ms after the sentence ended`; });
    await C.ev(`document.getElementById('mic').click(); true`); await sleep(1500);
    await t('no page errors (390)', () => assert.deepEqual(C.errors, []));
    await C.close(); C = null;

    // ---- Gemini engine: after rolling settled every sentence, Gemini (stub) still reads the whole clip
    const gemini = async (mode) => {
      fs.writeFileSync(path.join(WORK, 'agy', 'mode'), mode);
      C = await openChrome(1440, 900, false);
      await C.ev(`fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Seat-Token': TOKEN }, body: JSON.stringify({ settings: { voiceSmartEngine: 'gemini' } }) }).then((r) => r.ok)`);
      await C.ev(`setData.settings.voiceSmartEngine = 'gemini'; __sr.scripts[0] = ${JSON.stringify(SCRIPT)}; true`);
      const t2 = Date.now(); await C.ev(`document.getElementById('mic').click(); true`);
      while (Date.now() - t2 < 32000) { if (Date.now() - t2 > 18000 && (await C.ev(`!!mic && !mic.stopping`))) await C.ev(`document.getElementById('mic').click(); true`); if (Date.now() - t2 > 18000 && (await C.ev(`!mic`))) break; await sleep(200); }
      await until(C.ev, `!document.getElementById('mic').hasAttribute('data-check')`, 40000);
      await sleep(1200);
      const smart = log().flatMap((x) => x.events || [x]).filter((e) => e.step === 'smart').pop();
      return { v: await C.ev(text), smart, note: await C.ev(`document.getElementById('recmsg').textContent`) };
    };
    const g1 = await gemini('ok');
    await t('Gemini after rolling settled all: whole dictated part = Gemini (Latin words), BEFORE kept, note says Gemini', () => {
      assert.equal(g1.v, 'BEFORE ' + GEM); assert.equal(g1.smart?.rolled, true); assert.equal(g1.smart?.engineUsed, 'gemini'); assert.equal(g1.smart?.replaced, true); assert.match(g1.note, /Gemini/); return g1.smart.why;
    });
    await C.shot('rolling-gemini-1440.png');
    await t('no page errors (Gemini)', () => assert.deepEqual(C.errors, []));
    await C.close(); C = null;
    const before = (fs.readFileSync(path.join(DATA, 'server.log'), 'utf8').match(/ smart auto=/g) || []).length;
    const g2 = await gemini('fail');
    await t('Gemini fails after rolling: the rolled text stays, no Whisper read of the settled clip', () => {
      assert.match(g2.v, /^BEFORE תפתח/); assert.ok(!g2.v.includes('server log'), g2.v); assert.ok(!g2.v.includes(S1) && !g2.v.includes(S3), 'rolled text expected');
      assert.equal(g2.smart?.status, 503); assert.equal(g2.smart?.replaced, false); assert.equal(g2.smart?.rolled, true);
      const after = (fs.readFileSync(path.join(DATA, 'server.log'), 'utf8').match(/ smart auto=/g) || []).length; assert.equal(after, before, 'Whisper ran a smart read');
    });
    await t('no page errors (Gemini fails)', () => assert.deepEqual(C.errors, []));
  } catch (e) { rows.push(['FAIL', 'browser run', String(e.stack || e).slice(0, 400)]); }
  finally { await C?.close(); srv?.kill(); await sleep(300); if (WORK) fs.rmSync(WORK, { recursive: true, force: true }); }
}
for (const [s, n, d] of rows) console.log(`${s} | ${n} | ${d}`);
const failed = rows.filter((r) => r[0] === 'FAIL').length;
console.log(failed ? `${failed} FAILED` : `all ${rows.length} passed`);
process.exit(failed ? 1 : 0);
