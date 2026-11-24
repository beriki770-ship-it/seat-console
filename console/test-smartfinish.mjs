// Run: node console/test-smartfinish.mjs [--no-browser]. Smart finish of live dictation (public/smartfinish.js + the app.js "Smart finish" block).
// Part 1, plain Node: the replace-or-keep decision. Part 2, headless Chrome on an isolated test instance (own port, data dir, fake claude,
// throwaway HOME): a fake microphone plays a TTS clip, SpeechRecognition is stubbed to type a wrong-language or truncated transcript, and after
// Stop the dictated part (only it) is replaced by Whisper's text; Undo restores it; text before and after is never touched; an edit inside the
// dictated part or a send before Whisper answers cancels the replacement; the language chip switches mid-dictation without losing words.
// Clips: TTS_DIR (default /tmp/voice2) with en.wav, he.wav and mix3.wav (he + en + de sentences with 1.2 s pauses; synthetic speech, e.g. edge-tts). Screenshots go to SHOT_DIR when it is set.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { VOICE_PY } from './voice.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { smartDecide, sfWords } = createRequire(import.meta.url)('./public/smartfinish.js');
const rows = [];
async function t(name, fn) { try { const d = await fn(); rows.push(['PASS', name, d || '']); } catch (e) { rows.push(['FAIL', name, String(e.message || e).slice(0, 300)]); } }

// ---- Part 1: the decision ----
const D = (o) => smartDecide({ liveLangs: ['he'], lang: 'he', prob: 0.99, ...o });   // Whisper's whole-clip answer (no segments): the voice2 rules
await t('another language Whisper is sure of -> replace (lang)', () => assert.equal(D({ live: 'הלו איי וונט טו', whisper: 'Hello, I want to test the console', lang: 'en' }).why, 'lang'));
await t('another language below 0.6 -> keep', () => assert.equal(D({ live: 'אחת שתיים שלוש ארבע', whisper: 'one two three four', lang: 'en', prob: 0.55 }).replace, false));
await t('no probability -> no language replace', () => assert.equal(D({ live: 'אחת שתיים שלוש ארבע', whisper: 'one two three four', lang: 'en', prob: null }).replace, false));
await t('Edge dropout: 3 of 30 words -> replace (short)', () => assert.equal(D({ live: 'שלום אני רוצה', whisper: 'שלום אני רוצה לבדוק את המערכת החדשה של הקונסולה היום אנחנו עובדים על הכתבה קולית ואני מקווה שהיא תזהה את המילים שלי גם כשאני מדבר מהר' }).why, 'short'));
await t('8 of 10 words (80 %) -> keep', () => assert.equal(D({ live: 'a b c d e f g h', whisper: 'a b c d e f g h i j', lang: 'he' }).replace, false));
await t('6 of 10 words (60 %) -> replace', () => assert.equal(D({ live: 'a b c d e f', whisper: 'a b c d e f g h i j' }).replace, true));
await t('empty live + 1-2 Whisper words (silence hallucination) -> keep', () => { assert.equal(D({ live: '', whisper: 'תודה רבה' }).replace, false); assert.equal(D({ live: '', whisper: 'תודה' }).replace, false); });
await t('empty live + 5 Whisper words -> replace', () => assert.equal(D({ live: '', whisper: 'תשלח לי את הדוח בבקשה' }).replace, true));
await t('empty Whisper text -> keep', () => assert.equal(D({ live: 'שלום', whisper: '  ' }).why, 'empty'));
await t('switched mid-dictation (he + en), Whisper says en -> no language replace', () => assert.equal(D({ live: 'שלום hello there friend', whisper: 'shalom hello there friend', liveLangs: ['he', 'en'], lang: 'en' }).replace, false));
// mixed languages (2026-11-24): Whisper segments and Gemini
const W = (o) => smartDecide({ liveLangs: ['he'], engine: 'whisper', ...o });
await t('Whisper segments he + en (sure), Hebrew session -> replace (mixed)', () => assert.equal(W({ live: 'שלום עולם פליז אופן דה סרבר', whisper: 'שלום עולם. Please open the server', segments: [{ lang: 'he', prob: 0.97 }, { lang: 'en', prob: 0.99 }] }).why, 'mixed'));
await t('Whisper segments: a 2nd language below 0.6 -> keep', () => assert.equal(W({ live: 'שלום עולם מה נשמע', whisper: 'שלום עולם. ma nishma', segments: [{ lang: 'he', prob: 0.97 }, { lang: 'en', prob: 0.5 }] }).replace, false));
await t('Whisper segments after a chip switch: same words -> keep (no mixed / lang)', () => assert.equal(W({ live: 'שלום עולם please open the server', whisper: 'שלום עולם. Please open the server', liveLangs: ['he', 'en'], segments: [{ lang: 'he', prob: 0.97 }, { lang: 'en', prob: 0.99 }] }).replace, false));
await t('Whisper segments after a chip switch: clearly more words -> replace (short)', () => assert.equal(W({ live: 'שלום', whisper: 'שלום עולם. Please open the server log now', liveLangs: ['he', 'en'], segments: [{ lang: 'he', prob: 0.97 }, { lang: 'en', prob: 0.99 }] }).why, 'short'));
const G = (o) => smartDecide({ liveLangs: ['he'], engine: 'gemini', lang: null, prob: null, ...o });
await t('Gemini he + en, Hebrew session -> replace (mixed)', () => assert.equal(G({ live: 'תפתח את הסרבר לוג', whisper: 'תפתח את ה-server log', langs: ['he', 'en'] }).why, 'mixed'));
await t('Gemini says only he but has Latin words the live text lacks -> replace (latin)', () => assert.equal(G({ live: 'תעשה דיפלוי לסטייג׳ינג', whisper: 'תעשה deploy ל-staging', langs: ['he'] }).why, 'latin'));
await t('Gemini another language, DE session -> replace (lang)', () => assert.equal(G({ live: 'Kids Open der Server', whisper: 'Please open the server', liveLangs: ['de'], langs: ['en'] }).why, 'lang'));
await t('Gemini same words as live (case, punctuation) -> keep', () => assert.equal(G({ live: 'please open the server log', whisper: 'Please open the server log.', liveLangs: ['en'], langs: ['en'] }).replace, false));
await t('Gemini after a chip switch, he + en: still replaces a different text (trusted to spell across languages)', () => assert.equal(G({ live: 'תפתח את הסרבר log', whisper: 'תפתח את ה-server log', liveLangs: ['he', 'en'], langs: ['he', 'en'] }).why, 'mixed'));
await t('Gemini he + en but clearly shorter than the live text (recording missed the end) -> keep', () => assert.equal(G({ live: 'תפתח את הסרבר לוג ותבדוק את הערורים האחרונים בבקשה', whisper: 'תפתח את ה-server log', langs: ['he', 'en'] }).replace, false));
await t("Gemini 'iw' / stray codes are filtered server-side; langs ['he'] in a he session with the same Latin count -> keep", () => assert.equal(G({ live: 'שלום server', whisper: 'שלום, server!', langs: ['he'] }).replace, false));
await t('Gemini, empty live + 2 words -> keep (no hallucination replace)', () => assert.equal(G({ live: '', whisper: 'תודה רבה', langs: ['he'] }).replace, false));
await t('Gemini, Edge dropout 2 of 12 words, same language -> replace (short)', () => assert.equal(G({ live: 'שלום אני', whisper: 'שלום אני רוצה לבדוק היום את מערכת ההכתבה החדשה של הקונסולה', langs: ['he'] }).why, 'short'));
// after rolling correction settled the dictation (live = the rolled text, ivrit: English words in Hebrew letters), Gemini reads the whole clip
await t('rolled text with transliterated English, Gemini has the Latin words -> replace (latin)', () => assert.equal(G({ live: 'תפתח את הסרבר לוג ותבדוק את הדיפלוי', whisper: 'תפתח את ה-server log ותבדוק את ה-deploy', langs: ['he'] }).why, 'latin'));
await t('rolled text, Gemini he + en segments -> replace (mixed)', () => assert.equal(G({ live: 'שלום. פליז אופן דה סרבר', whisper: 'שלום. Please open the server', langs: ['he', 'en'] }).why, 'mixed'));
await t('rolled text, Gemini only Hebrew with a different spelling -> keep the rolled text', () => assert.equal(G({ live: 'תשלח לי סיכום קצר בטלגרם', whisper: 'תשלח לי סכום קצר בטלגרם', langs: ['he'] }).replace, false));
await t('rolled text already has the Latin words Gemini has -> keep', () => assert.equal(G({ live: 'תפתח את ה server log', whisper: 'תפתח את ה-server log', langs: ['he'] }).replace, false));
await t('rolled text missing words Gemini heard -> replace (short)', () => assert.equal(G({ live: 'תפתח את הלוג', whisper: 'תפתח את הלוג ותבדוק למה ההעלאה נכשלה אתמול בלילה', langs: ['he'] }).why, 'short'));
await t('word count: Hebrew, English, contractions, file names', () => { assert.equal(sfWords('don\'t open server.mjs, שלום-עליכם ok'), 5); assert.equal(sfWords(''), 0); assert.equal(sfWords(null), 0); });

// ---- Part 2: the page ----
const TTS = process.env.TTS_DIR || '/tmp/voice2', SHOTS = process.env.SHOT_DIR || '';
const CHROME = ['google-chrome', 'chromium', 'chromium-browser'].map((c) => process.env.PATH.split(':').map((d) => path.join(d, c)).find((p) => fs.existsSync(p))).find(Boolean);
const browser = !process.argv.includes('--no-browser') && CHROME && fs.existsSync(VOICE_PY) && ['en', 'he', 'mix3'].every((f) => fs.existsSync(path.join(TTS, f + '.wav')));
if (!browser) rows.push(['SKIP', 'browser part', !CHROME ? 'no Chrome' : !fs.existsSync(VOICE_PY) ? `no Whisper python at ${VOICE_PY} (set VOICE_PY)` : `no ${TTS}/en.wav + he.wav + mix3.wav`]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// SpeechRecognition stand-in: window.__sr.scripts[n] = the steps of the n-th session ({ at, text, final } or { at, end: true } = the service ends
// the session by itself, like Edge after a pause). stop() turns the pending interim into a final, as Chrome does.
const STUB = `(() => { localStorage.setItem('diagUntil', String(Date.now() + 3600000)); const S = window.__sr = { scripts: [], made: [] };
  class FakeSR { constructor() { this.lang = ''; this.res = []; this.n = S.made.length; S.made.push(this); }
    start() { this.on = true; setTimeout(() => this.onstart?.(), 10); this.timers = (S.scripts[this.n] || []).map((st) => setTimeout(() => { if (!this.on) return; if (st.end) { this.on = false; this.onend?.(); } else this.emit(st.text, st.final); }, st.at)); }
    emit(text, final) { if (this.res.length && !this.res[this.res.length - 1].isFinal) this.res.pop(); const r = [{ transcript: text }]; r.isFinal = !!final; this.res.push(r); this.onresult?.({ resultIndex: this.res.length - 1, results: this.res }); }
    stop() { this.on = false; this.timers.forEach(clearTimeout); const last = this.res[this.res.length - 1]; setTimeout(() => { if (last && !last.isFinal) { last.isFinal = true; this.onresult?.({ resultIndex: this.res.length - 1, results: this.res }); } this.onend?.(); }, 50); }
    abort() { if (!this.on) return; this.on = false; this.timers.forEach(clearTimeout); setTimeout(() => this.onend?.(), 10); } }
  window.SpeechRecognition = window.webkitSpeechRecognition = FakeSR; })();`;

let srv = null, WORK = null;
async function startServer(port) {
  WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-sf-test-')); const DATA = path.join(WORK, 'data');
  fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(path.join(WORK, 'home'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ language: 'en', guideOffered: 'done', voiceRolling: false }));   // not a first run: the page opens on the composer; rolling correction off (test-rollcdp.mjs covers it)
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/i.test(k))), HOME: path.join(WORK, 'home'),
    VOICE_PY, HF_HOME: process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface') };
  const fd = fs.openSync(path.join(DATA, 'server.log'), 'a');
  srv = spawn(process.execPath, [path.join(HERE, 'server.mjs'), '--port', String(port), '--data', DATA, '--claude', path.join(HERE, 'fixtures', 'fake-claude.mjs')], { stdio: ['ignore', fd, fd], env, cwd: HERE });
  fs.closeSync(fd);
  for (let i = 0; ; i++) { if (await new Promise((ok) => http.get(`http://127.0.0.1:${port}/health`, (r) => { r.resume(); ok(r.statusCode === 200); }).on('error', () => ok(false)))) return DATA; if (i > 200) throw new Error('server did not start'); await sleep(300); }
}
async function openChrome(wav) {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-sf-chrome-'));
  // port 0 = a free one, read back from the profile: a fixed port can be another Chrome on this box (the owner's own browser once)
  const ch = spawn(CHROME, ['--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${prof}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let dport = 0; for (let i = 0; i < 80 && !dport; i++) { try { dport = +fs.readFileSync(path.join(prof, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch {} if (!dport) await sleep(250); }
  let tgt; for (let i = 0; i < 80 && !tgt; i++) { try { tgt = (await (await fetch(`http://127.0.0.1:${dport}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!tgt) await sleep(250); }
  const ws = new WebSocket(tgt.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = {}, errors = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) pend[d.id](d); if (d.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(d.params.exceptionDetails).slice(0, 300)); };
  const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (e) => { const r = await cmd('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed'); return r.result.result.value; };
  await cmd('Runtime.enable'); await cmd('Page.enable');
  await cmd('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  const close = async () => { ch.kill(); await sleep(400); fs.rmSync(prof, { recursive: true, force: true }); };
  return { cmd, ev, errors, close };
}
const until = async (ev, expr, ms, what) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return; await sleep(200); } throw new Error('timed out waiting for ' + what); };
const text = `document.getElementById('text').value`;
const typed = `(() => { const c = document.getElementById('text').cloneNode(true); c.querySelectorAll('.vi').forEach((n) => n.remove()); return c.textContent; })()`;   // committed words only (not the grey interim ones)

if (browser) {
  const PORT = 4859; let C = null;
  try {
    const DATA = await startServer(PORT);
    const page = async (wav, w, h, mobile) => {
      C = await openChrome(wav);
      await C.cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
      if (mobile) await C.cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await C.cmd('Page.navigate', { url: `http://localhost:${PORT}/` });   // localhost = a secure context: the page may open the microphone
      await until(C.ev, `typeof setData !== 'undefined' && !!setData && !document.getElementById('mic').hidden`, 20000, 'the composer');
      await C.ev(`localStorage.removeItem('voiceLiveLang'); micUi(); document.getElementById('text').focus(); document.execCommand('insertText', false, 'BEFORE'); true`);
    };
    const shot = async (f) => { if (!SHOTS) return; fs.writeFileSync(path.join(SHOTS, f), Buffer.from((await C.cmd('Page.captureScreenshot')).result.data, 'base64')); };

    // A: English spoken into a Hebrew session (1440). The stub types Hebrew-sounding nonsense; Whisper hears English -> replaced; Undo restores.
    await page(path.join(TTS, 'en.wav'), 1440, 900, false);
    await t('chip shows HE (Settings default) and its label names the language', async () => { const r = await C.ev(`({ txt: miclang.textContent, hidden: miclang.hidden, label: miclang.getAttribute('aria-label') })`); assert.equal(r.txt, 'HE'); assert.equal(r.hidden, false); assert.match(r.label, /Dictation language/); });
    await C.ev(`__sr.scripts[0] = [{ at: 400, text: 'הלו איי' }, { at: 1500, text: 'הלו איי וונט טו טסט', final: true }, { at: 2500, text: 'דה ניו וויס' }]; true`);
    await C.ev(`document.getElementById('mic').click(); true`);
    await sleep(12000);   // the fake microphone plays the clip into the parallel recording meanwhile
    await t('live dictation typed the stub words after BEFORE, recorder running', async () => { const r = await C.ev(`({ v: ${text}, rec: !!(mic && mic.sf), lang: __sr.made[0].lang, alt: __sr.made[0].maxAlternatives })`); assert.match(r.v, /^BEFORE הלו איי וונט טו טסט/); assert.ok(r.rec, 'parallel MediaRecorder running'); assert.equal(r.lang, 'he-IL'); assert.equal(r.alt, 1); });
    await C.ev(`document.getElementById('mic').click(); true`);
    await until(C.ev, `!mic`, 3000, 'stop');
    await t('Stop keeps the last interim words; mic shows the checking dot', async () => { const r = await C.ev(`({ v: ${text}, dot: document.getElementById('mic').hasAttribute('data-check') })`); assert.equal(r.v, 'BEFORE הלו איי וונט טו טסט דה ניו וויס'); assert.ok(r.dot); });
    await C.cmd('Input.insertText', { text: ' AFTER' });   // typing on while Whisper reads
    await until(C.ev, `document.getElementById('rec').className === 'note' || !document.getElementById('mic').hasAttribute('data-check')`, 60000, 'Whisper');
    const afterA = await C.ev(text);
    await t('English clip: dictated part replaced by Whisper, BEFORE and AFTER untouched', async () => { assert.match(afterA, /^BEFORE Hello, I want to test the new voice input/); assert.match(afterA, / AFTER$/); assert.doesNotMatch(afterA, /[֐-׿]/); return afterA.length + ' chars'; });
    await shot('voice2-1440.png');
    await t('note "Improved by Whisper · Undo" visible', async () => { assert.equal(await C.ev(`document.getElementById('rec').className`), 'note'); assert.match(await C.ev(`document.getElementById('recmsg').textContent`), /Improved by Whisper\s*Undo/); });
    await C.ev(`document.getElementById('sfundo').click(); true`);
    await t('Undo restores the live text exactly, AFTER kept, marks gone', async () => { const r = await C.ev(`({ v: ${text}, marks: document.querySelectorAll('#text .vm, #text .vi').length, note: document.getElementById('rec').hidden })`); assert.equal(r.v, 'BEFORE הלו איי וונט טו טסט דה ניו וויס AFTER'); assert.equal(r.marks, 0); assert.ok(r.note); });

    // B: the language chip mid-dictation + Edge's early 'end' with words still interim (still 1440, no Smart finish needed)
    await C.ev(`document.getElementById('text').textContent = ''; document.getElementById('text').focus(); __sr.made.length = 0; __sr.scripts = [[{ at: 300, text: 'אחת שתיים', final: true }, { at: 800, text: 'שלוש' }, { at: 1200, end: true }], [{ at: 300, text: 'ארבע' }], [{ at: 300, text: 'five six', final: true }]]; setData.settings.voiceSmart = false; true`);
    await C.ev(`document.getElementById('mic').click(); true`); await sleep(2200);
    await t("Edge-style 'end' with interim words: they are typed, listening restarts", async () => { const r = await C.ev(`({ v: ${typed}, i: document.querySelector('#text .vi')?.textContent, n: __sr.made.length })`); assert.equal(r.v, 'אחת שתיים שלוש'); assert.equal(r.i?.trim(), 'ארבע'); assert.equal(r.n, 2); });
    await sleep(300); await C.ev(`document.getElementById('miclang').click(); true`); await sleep(900);
    await t('chip tap mid-dictation: interim kept, new session in en-US, chip says EN, remembered', async () => { const r = await C.ev(`({ v: ${text}, n: __sr.made.length, lang: __sr.made[2]?.lang, chip: miclang.textContent, ls: localStorage.getItem('voiceLiveLang') })`); assert.equal(r.v, 'אחת שתיים שלוש ארבע five six'); assert.equal(r.n, 3); assert.equal(r.lang, 'en-US'); assert.equal(r.chip, 'EN'); assert.equal(r.ls, 'en'); });
    await C.ev(`document.getElementById('mic').click(); true`); await until(C.ev, `!mic`, 3000, 'stop');
    await t('right-click opens the 3-language menu, a pick sets it', async () => {
      await C.ev(`miclang.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); true`);
      const n = await C.ev(`document.querySelectorAll('#miclangmenu:not([hidden]) [role=menuitemradio]').length`); assert.equal(n, 3);
      await C.ev(`document.querySelector('#miclangmenu [data-lang=de]').click(); true`);
      const r = await C.ev(`({ chip: miclang.textContent, open: !document.getElementById('miclangmenu').hidden })`); assert.equal(r.chip, 'DE'); assert.equal(r.open, false);
    });
    await t('no page errors (1440)', async () => assert.deepEqual(C.errors, []));
    await C.close(); C = null;

    // F: BUG #1 (owner, 2026-11-24, Edge): a dictation with chip switches DE -> HE -> EN -> DE -> HE -> EN never ran Smart finish (no "smart"
    // DIAG line). The fake mic plays a he + en + de clip; the stub types a few words per session; after Stop the smart step must run and log.
    await page(path.join(TTS, 'mix3.wav'), 1440, 900, false);
    await C.ev(`localStorage.setItem('voiceLiveLang', 'de'); micUi(); setData.settings.voiceSmart = true; __sr.made.length = 0; __sr.scripts = [0, 1, 2, 3, 4, 5].map((n) => [{ at: 300, text: 'w' + n + 'a w' + n + 'b', final: true }]); true`);
    await C.ev(`document.getElementById('mic').click(); true`);
    for (let i = 0; i < 5; i++) { await sleep(1800); await C.ev(`document.getElementById('miclang').click(); true`); }
    await sleep(1800);
    await t('chip switches mid-dictation: 6 sessions, recorder still running', async () => { const r = await C.ev(`({ n: __sr.made.length, langs: __sr.made.map((x) => x.lang), rec: mic?.sf?.rec?.state })`); assert.equal(r.n, 6, JSON.stringify(r)); assert.equal(r.rec, 'recording'); return r.langs.join(' '); });
    await C.ev(`document.getElementById('mic').click(); true`); await until(C.ev, `!mic`, 3000, 'stop');
    await until(C.ev, `!document.getElementById('mic').hasAttribute('data-check')`, 90000, 'Smart finish');
    await sleep(1500);   // the DIAG beacon is sent 800 ms after the last event
    const smartF = fs.readFileSync(path.join(DATA, 'data', 'client-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.k === 'mic' && e.step === 'smart').pop();
    await t('after switches: Smart finish ran and logged (segments, langs, decision)', async () => { assert.ok(smartF, 'no smart line'); assert.equal(smartF.status, 200); assert.deepEqual(smartF.liveLangs, ['de', 'he', 'en']); assert.ok(smartF.segments >= 2, JSON.stringify(smartF)); assert.ok(typeof smartF.why === 'string'); return `segs ${smartF.segments} langs ${smartF.langs} why ${smartF.why} ${smartF.engineUsed}/${smartF.fallback}`; });
    // G: the parallel recording ends on its own mid-dictation (its track ended: the suspected Edge cause of F). It used to wait for an
    // 'onstop' that had already fired, so Smart finish never ran and nothing was logged; now it logs why it did not replace.
    await C.ev(`document.getElementById('text').textContent = ''; document.getElementById('text').focus(); __sr.made.length = 0; __sr.scripts = [[{ at: 300, text: 'eins zwei drei', final: true }]]; true`);
    await C.ev(`document.getElementById('mic').click(); true`); await sleep(2500);
    await C.ev(`mic.sf.stream.getTracks().forEach((tr) => tr.stop()); true`); await sleep(2500);
    await C.ev(`document.getElementById('mic').click(); true`); await until(C.ev, `!mic`, 3000, 'stop');
    await until(C.ev, `!document.getElementById('mic').hasAttribute('data-check')`, 30000, 'Smart finish (recording ended early)'); await sleep(1500);
    const smartG = fs.readFileSync(path.join(DATA, 'data', 'client-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.k === 'mic' && e.step === 'smart').pop();
    await t('recording ended mid-dictation: smart step still logged, text kept', async () => { assert.ok(smartG && smartG.t > smartF.t, 'no new smart line'); assert.equal(smartG.replaced, false); assert.equal(smartG.why, 'partial'); assert.equal(await C.ev(text), 'eins zwei drei'); });
    await t('no page errors (switches)', async () => assert.deepEqual(C.errors, []));
    await C.close(); C = null;

    // C: Edge dropout at 390 (touch): Hebrew clip, the stub hears only 3 words -> Whisper's full text replaces them; note expires, marks removed
    await page(path.join(TTS, 'he.wav'), 390, 800, true);
    await C.ev(`__sr.scripts[0] = [{ at: 600, text: 'שלום אני רוצה', final: true }]; true`);
    await C.ev(`document.getElementById('mic').click(); true`); await sleep(14000); await C.ev(`document.getElementById('mic').click(); true`);
    await until(C.ev, `document.getElementById('rec').className === 'note' || (!mic && !document.getElementById('mic').hasAttribute('data-check'))`, 60000, 'Whisper');
    const afterC = await C.ev(text);
    await t('Hebrew clip, 3 live words: replaced by Whisper (more words), BEFORE kept', async () => { assert.match(afterC, /^BEFORE שלום/); assert.ok(sfWords(afterC) > 15, afterC); return sfWords(afterC) + ' words'; });
    await shot('voice2-390.png');
    await sleep(8500);
    await t('after 8 s: note gone, marks removed, text stays', async () => { const r = await C.ev(`({ v: ${text}, marks: document.querySelectorAll('#text .vm, #text .vi').length, note: document.getElementById('rec').hidden })`); assert.equal(r.v, afterC); assert.equal(r.marks, 0); assert.ok(r.note); });

    // D: an edit inside the dictated part while Whisper reads -> no replacement
    await C.ev(`document.getElementById('text').textContent = 'BEFORE'; __sr.made.length = 0; __sr.scripts[0] = [{ at: 600, text: 'שלום אני', final: true }]; document.getElementById('text').focus(); caretEnd(); true`);
    await C.ev(`document.getElementById('mic').click(); true`); await sleep(6000); await C.ev(`document.getElementById('mic').click(); true`); await until(C.ev, `!mic`, 3000, 'stop');
    await C.ev(`(() => { const t = [...document.getElementById('text').childNodes].find((n) => n.nodeType === 3 && n.data.includes('אני')); const r = document.createRange(); r.setStart(t, t.data.indexOf('אני')); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('insertText', false, 'X'); return true; })()`);
    await until(C.ev, `!document.getElementById('mic').hasAttribute('data-check')`, 60000, 'Whisper');
    await t('edit inside the dictated part: Whisper result not applied', async () => { assert.equal(await C.ev(text), 'BEFORE שלום Xאני'); assert.equal(await C.ev(`document.querySelectorAll('#text .vm').length`), 0); });

    // E: Send before Whisper answers -> skipped (the real send is stubbed: it just empties the box)
    await C.ev(`document.getElementById('text').textContent = 'BEFORE'; __sr.made.length = 0; __sr.scripts[0] = [{ at: 600, text: 'שלום', final: true }]; document.getElementById('composer').onsubmit = (e) => { e.preventDefault(); document.getElementById('text').textContent = ''; }; document.getElementById('text').focus(); caretEnd(); true`);
    await C.ev(`document.getElementById('mic').click(); true`); await sleep(6000); await C.ev(`document.getElementById('mic').click(); true`); await until(C.ev, `!mic`, 3000, 'stop');
    await C.ev(`document.getElementById('composer').requestSubmit(); document.execCommand('insertText', false, 'next message'); true`);
    await until(C.ev, `!document.getElementById('mic').hasAttribute('data-check')`, 60000, 'Whisper');
    await t('sent before Whisper answered: the next message is left alone', async () => assert.equal(await C.ev(text), 'next message'));
    await t('no page errors (390)', async () => assert.deepEqual(C.errors, []));
    await t('server.log: smart clips logged with auto language, no transcript text', async () => { const log = fs.readFileSync(path.join(DATA, 'server.log'), 'utf8'); assert.match(log, /\[voice\] \d+ bytes.* smart auto=en/); assert.match(log, /smart auto=he/); assert.doesNotMatch(log, /Hello, I want|שלום אני רוצה לבדוק/); });
  } catch (e) { rows.push(['FAIL', 'browser run', String(e.stack || e).slice(0, 400)]); }
  finally { await C?.close(); srv?.kill(); await sleep(500); if (WORK) fs.rmSync(WORK, { recursive: true, force: true }); }
}
for (const r of rows) console.log(r.join(' | '));
const bad = rows.filter((r) => r[0] === 'FAIL').length;
console.log(bad ? `${bad} FAILED` : `all ${rows.filter((r) => r[0] === 'PASS').length} passed`); process.exit(bad ? 1 : 0);
