// Run: node console/test-voice.mjs. POST /api/transcribe on an isolated test instance (own port, own data dir, fake claude, throwaway HOME):
// a token is required, a body over 25 MB is refused with 413, an empty body and non-audio bytes are refused, and the short Hebrew WAV
// fixture comes back as Hebrew text (the small model: it loads fastest; the real page uses the model from Settings > Voice); Smart finish's
// segment mode reads a he + en + de clip as three languages, and without the Antigravity CLI (agy) the Gemini engine falls back to it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VOICE_PY } from './voice.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), PORT = 4858, REAL_HOME = os.homedir();
// no faster-whisper python here (CI, a fresh clone): nothing to test (README: Voice)
if (!fs.existsSync(VOICE_PY)) { console.log(`SKIP | test-voice | no Whisper python at ${VOICE_PY} (set VOICE_PY)`); process.exit(0); }
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-voice-test-')), DATA = path.join(WORK, 'data');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(path.join(WORK, 'home'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ voiceSmartEngine: 'gemini' }));   // the Gemini engine is opt-in: on here for the no-agy fallback check
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/i.test(k) && k !== 'SMART_AGY_BIN')), HOME: path.join(WORK, 'home'),
  VOICE_PY, HF_HOME: process.env.HF_HOME || path.join(REAL_HOME, '.cache', 'huggingface') };   // the throwaway HOME must not hide the python or the cached models
const fd = fs.openSync(path.join(DATA, 'server.log'), 'a');
const srv = spawn(process.execPath, [path.join(HERE, 'server.mjs'), '--port', String(PORT), '--data', DATA, '--claude', path.join(HERE, 'fixtures', 'fake-claude.mjs')], { stdio: ['ignore', fd, fd], env, cwd: HERE });
fs.closeSync(fd);
let TOKEN = '';
const post = (p, buf, { token = TOKEN, len } = {}) => new Promise((ok, no) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: p, agent: false, timeout: 180000, headers: { 'Content-Type': 'application/octet-stream', ...(len === 'chunked' ? {} : { 'Content-Length': len ?? buf.length }), ...(token ? { 'X-Seat-Token': token } : {}) } }, (res) => {
    let t = ''; res.setEncoding('utf8'); res.on('data', (d) => (t += d)); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} ok({ status: res.statusCode, json: j }); });
  });
  req.on('error', no); req.on('timeout', () => req.destroy(new Error('timeout'))); req.end(buf);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
async function t(name, fn) { try { const d = await fn(); rows.push(['PASS', name, d || '']); } catch (e) { rows.push(['FAIL', name, String(e.message || e)]); } }
try {
  for (let i = 0; ; i++) { try { TOKEN = fs.readFileSync(path.join(DATA, 'token.txt'), 'utf8').trim(); if (TOKEN && (await new Promise((ok) => http.get(`http://127.0.0.1:${PORT}/health`, (r) => { r.resume(); ok(r.statusCode === 200); }).on('error', () => ok(false))))) break; } catch {} if (i > 200) throw new Error('server did not start'); await sleep(300); }
  const wav = fs.readFileSync(path.join(HERE, 'fixtures', 'voice-he.wav'));
  await t('no token = 403', async () => { const r = await post('/api/transcribe', wav, { token: '' }); assert.equal(r.status, 403); });
  await t('wrong token = 403', async () => { const r = await post('/api/transcribe', wav, { token: 'x'.repeat(32) }); assert.equal(r.status, 403); });
  await t('over 25 MB (Content-Length) = 413', async () => { const r = await post('/api/transcribe', Buffer.alloc(0), { len: 26 * 1024 * 1024 }).catch((e) => ({ status: 'err ' + e.message })); assert.equal(r.status, 413); });
  await t('over 25 MB (chunked, no Content-Length) = 413', async () => { const big = Buffer.alloc(26 * 1024 * 1024); const r = await post('/api/transcribe', big, { len: 'chunked' }).catch((e) => ({ status: 'err ' + e.message })); assert.ok(r.status === 413 || String(r.status).startsWith('err'), String(r.status)); return String(r.status); });
  await t('empty body = 422 empty', async () => { const r = await post('/api/transcribe', Buffer.alloc(0)); assert.equal(r.status, 422); assert.equal(r.json.code, 'empty'); });
  await t('non-audio bytes = 422 badaudio', async () => { const r = await post('/api/transcribe', Buffer.from('this is not audio at all, just text bytes'.repeat(20))); assert.equal(r.status, 422); assert.equal(r.json.code, 'badaudio'); });
  await t('Hebrew WAV fixture -> Hebrew text', async () => {
    const r = await post('/api/transcribe?model=small', wav); assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.lang, 'he'); assert.match(r.json.text, /[֐-׿]/); assert.match(r.json.text, /שלום/); assert.ok(r.json.ms > 0);
    return `${r.json.ms} ms (first clip: includes the model load)`;
  });
  // Smart finish, Whisper segment mode: fixtures/voice-mix3.webm = a Hebrew, an English and a German sentence (edge-tts) with 1.2 s pauses
  const mix = fs.readFileSync(path.join(HERE, 'fixtures', 'voice-mix3.webm'));
  await t('mixed he + en + de clip, Whisper segments: 3 languages, Hebrew and Latin script joined in order', async () => {
    const r = await post('/api/transcribe?smart=1&lang=auto&model=small&engine=whisper', mix); assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.langs, ['he', 'en', 'de']); assert.equal(r.json.segments.length, 3); assert.equal(r.json.engine, 'whisper');
    assert.match(r.json.text, /^[^A-Za-z]*[֐-׿][^A-Za-z]*[A-Za-z]/); assert.match(r.json.text, /[A-Za-z]{3,}.*[A-Za-z]{3,}/);   // Hebrew first, then Latin script (no exact spelling: a model update may change it)
    return `${r.json.ms} ms, ${r.json.segments.map((x) => `${x.lang} ${x.start}-${x.end}s p${x.prob}`).join(', ')}`;
  });
  await t('Smart finish engine Gemini without the Antigravity CLI: falls back to Whisper (fallback noagy)', async () => {
    const r = await post('/api/transcribe?smart=1&lang=auto&model=small', mix); assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.engine, 'whisper'); assert.equal(r.json.fallback, 'noagy'); assert.equal(r.json.langs.length, 3);
  });
  await t('server.log carries no transcript text', async () => { const log = fs.readFileSync(path.join(DATA, 'server.log'), 'utf8'); assert.doesNotMatch(log, /שלום|server log|Bericht/); assert.match(log, /\[voice\] \d+ bytes/); });
} finally { srv.kill(); await sleep(500); fs.rmSync(WORK, { recursive: true, force: true }); }
for (const r of rows) console.log(r.join(' | '));
const bad = rows.filter((r) => r[0] !== 'PASS').length;
console.log(bad ? `${bad} FAILED` : `all ${rows.length} passed`); process.exit(bad ? 1 : 0);
