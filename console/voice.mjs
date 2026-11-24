// Voice input (the composer's mic button): audio bytes in, text out, all on this machine. ffmpeg turns whatever the browser recorded
// (webm/opus from Chrome, Edge and Firefox, ogg, mp4/AAC from Safari) into 16 kHz mono WAV, then a warm faster-whisper worker (voice/worker.py)
// transcribes it. The worker keeps the model loaded between clips and is killed after idleMs without use, which frees its RAM;
// a worker that dies is started again on the next clip. Temp audio is deleted after every clip. Nothing here logs audio or text.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The models Settings > Voice offers, measured on a 15 s Hebrew+English clip (2026-11-23, 40 cores, busy). Default = small: ~4 s where turbo
// takes ~15 s on the shared, busy box (its encoder always runs a 30 s window, so a short clip costs the same); turbo spells Hebrew better.
export const VOICE_MODELS = ['small', 'large-v3-turbo', 'ivrit-ai/whisper-large-v3-turbo-ct2'];
// Smart finish (live dictation re-read by Whisper with language detection): only models whose detection works. ivrit-ai is left out, it was
// fine-tuned on Hebrew and reports English and German clips as Hebrew (p 1.0). Measured 2026-11-24, load ~25: small ~2.7 s, turbo ~10 s per 15 s clip.
export const SMART_MODELS = ['small', 'large-v3-turbo'];
export const VOICE_ENGINES = ['live', 'local'];   // live = the browser's speech service (words while you speak), local = this file (private, slower)
export const VOICE_LANGS = ['', 'he', 'en', 'de'];   // '' = detect (Hebrew when the guess is none of the three)
export const VOICE_MAX = 25 * 1024 * 1024, VOICE_MAX_SEC = 300;
// The python that runs voice/worker.py: VOICE_PY, else a venv next to it (python -m venv console/voice/.venv, then pip install faster-whisper;
// see README). Missing = the mic still works with the browser's live dictation; local transcription, Smart finish and rolling correction say so.
export const VOICE_PY = process.env.VOICE_PY || path.join(path.dirname(fileURLToPath(import.meta.url)), 'voice', '.venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
const REPLY_MS = 5 * 60000;   // longest wait for one clip (5 min of audio with the slowest model on a loaded box stays well under it)

// from (s): start that far in (Smart finish after rolling correction reads only the tail the rolling part has not covered)
const decode = (src, dst, from = 0) => new Promise((ok, no) => execFile('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file', '-i', src, ...(from > 0 ? ['-ss', String(from)] : []), '-t', String(VOICE_MAX_SEC), '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', dst],
  { timeout: 60000 }, (e) => (e ? no(Object.assign(new Error('not audio the server can read'), { code: 'BADAUDIO' })) : ok())));

export function createVoice({ python, script, idleMs = 30 * 60000, maxQueue = 3, env = {}, log = () => {} }) {   // env: e.g. VOICE_THREADS for the rolling worker
  let proc = null, ready = null, buf = '', seq = 0, idleT = null, queue = Promise.resolve(), waiting = 0;
  const pending = new Map();
  const stop = () => { if (proc) { proc.kill(); proc = null; ready = null; } };
  function start() {
    if (ready) return ready;
    ready = new Promise((ok, no) => {
      const p = proc = spawn(python, ['-u', script], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env, HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE ?? '1' } });
      let err = '';
      p.stdin.on('error', () => {});   // EPIPE when the worker dies mid-write: 'exit' below fails the pending clip
      p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });   // library warnings only (the worker never prints content there)
      p.stdout.on('data', (d) => {
        buf += d; let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.ready) { ok(); continue; }
          const w = pending.get(m.id); if (w) { pending.delete(m.id); w(m); }
        }
      });
      p.on('error', (e) => { log('[voice] worker failed to start: ' + e.message); if (proc === p) { proc = null; ready = null; } no(e); });   // the next clip tries again (a fixed venv works at once)
      p.on('exit', (code) => {
        if (proc === p) { proc = null; ready = null; } buf = '';
        if (code && code !== 143 && code !== null) log(`[voice] worker exited ${code}: ${err.split('\n').filter(Boolean).slice(-1)[0] || ''}`);
        no(new Error('voice worker exited')); for (const [id, w] of pending) { pending.delete(id); w({ error: 'voice worker stopped' }); }
      });
    });
    return ready;
  }
  // One clip at a time (the model uses most of its threads); more than maxQueue waiting = busy, the page says so.
  // mode 'segments' (Smart finish): the clip is cut at pauses and each piece is read in its own language (worker.py segments()).
  async function transcribe(audio, { model = VOICE_MODELS[0], lang = '', mode = '', temperature = null, from = 0 } = {}) {   // temperature 0: rolling correction (no sampling fallbacks)
    if (!VOICE_MODELS.includes(model)) model = VOICE_MODELS[0];
    if (!VOICE_LANGS.includes(lang)) lang = '';
    if (waiting >= maxQueue) throw Object.assign(new Error('busy'), { code: 'BUSY' });
    waiting++;
    const run = queue.then(async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-voice-'));
      try {
        const src = path.join(dir, 'in'), wav = path.join(dir, 'in.wav');
        fs.writeFileSync(src, audio, { mode: 0o600 });
        await decode(src, wav, from);
        const audioMs = Math.round(Math.max(0, fs.statSync(wav).size - 44) / 32);   // 16 kHz x 16 bit mono = 32 bytes per ms
        if (audioMs < 300) throw Object.assign(new Error('no audio in the recording'), { code: 'EMPTY' });
        clearTimeout(idleT); await start();
        const id = ++seq, t0 = Date.now();
        const r = await new Promise((ok) => {
          const to = setTimeout(() => { pending.delete(id); ok({ error: 'transcription timed out' }); stop(); }, REPLY_MS);   // a stuck clip must not block voice for good
          pending.set(id, (m) => { clearTimeout(to); ok(m); });
          try { proc.stdin.write(JSON.stringify({ id, path: wav, model, lang: lang || null, mode: mode || null, temperature }) + '\n'); } catch (e) { clearTimeout(to); pending.delete(id); ok({ error: String(e.message || e) }); }
        });
        if (r.error) throw new Error(r.error);
        return { text: r.text, lang: r.lang, prob: r.prob ?? null, first: r.first ?? null, segments: r.segments ?? null, langs: r.langs ?? null, ms: Date.now() - t0, audioMs };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        clearTimeout(idleT); idleT = setTimeout(stop, idleMs); idleT.unref?.();
      }
    });
    queue = run.catch(() => {}); try { return await run; } finally { waiting--; }
  }
  return { transcribe, stop, running: () => !!proc, pid: () => proc?.pid };
}

// ---- Smart finish with Gemini through the owner's Google login (Settings > Voice > Smart finish engine, the default). Whisper detects one
// language per piece of speech, so a sentence that mixes Hebrew and English words ("תפתח את ה-server log") comes back all in Hebrew letters;
// Gemini writes each word in the script it was spoken in. No API key and no paid API (owner, 2026-11-24): the Antigravity CLI (agy, the
// antigravity seat's own Google login in ~/.gemini) is asked to read the clip as a WAV file in a fresh temp folder. Measured 2026-11-24 on a
// 15 s he+en+de clip and a 6.6 s Hebrew sentence with English words: 8-11 s wall (CLI start included), both verbatim; on Google's
// "no capacity" (503) days agy retries for 30 s to minutes, so the 20 s limit hands the clip to Whisper. The audio goes to Google
// (Settings says so); agy's local conversation files for the clip are deleted after each read. Nothing here logs audio or text.
export const GEMINI_MODELS = ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium'];   // `agy models`: the Gemini ones; low = fastest, no thinking needed for a transcript
export const SMART_ENGINES = ['gemini', 'whisper'];
const SPOKEN = ['he', 'en', 'de'];
const GEMINI_PROMPT = 'Transcribe the audio file clip.wav in this folder verbatim. Open it with your file reading tool (it is audio). The speaker mixes Hebrew, English and German, sometimes inside one sentence. Write every word in the language and script it was spoken in: Hebrew words in Hebrew letters, English and German words in Latin letters. Never translate, never transliterate, never summarise, never add words that were not spoken. Punctuation only at natural sentence ends. If nothing is spoken, text is "". Do not run any commands, programs or other tools. Reply with only JSON: {"text": string, "langs": array of the ISO 639-1 codes spoken, in order of first use}.';
let geminiBusy = 0;   // one agy run at a time: a second dictation meanwhile goes straight to Whisper (each agy run is a whole CLI for up to 20 s)
export async function geminiTranscribe(audio, { agy, model = GEMINI_MODELS[0], timeoutMs = 20000, from = 0 } = {}) {
  if (!agy || !fs.existsSync(agy)) throw Object.assign(new Error('no Antigravity CLI'), { code: 'NOAGY' });
  if (geminiBusy) throw Object.assign(new Error('Gemini already reading a clip'), { code: 'BUSY' });
  if (!GEMINI_MODELS.includes(model)) model = GEMINI_MODELS[0];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-voice-g-')), t0 = Date.now();
  let conv = null;
  geminiBusy++;
  try {
    const src = path.join(dir, 'in'), wav = path.join(dir, 'clip.wav');
    fs.writeFileSync(src, audio, { mode: 0o600 }); await decode(src, wav, from); fs.rmSync(src);
    if (fs.statSync(wav).size - 44 < 300 * 32) throw Object.assign(new Error('no audio in the recording'), { code: 'EMPTY' });
    // stream-json: the conversation id arrives first ('init'), so even a clip cut off by the time limit gets its history files deleted
    // Its own process group: the time limit kills agy and anything it started, and the clean-up below waits (max 2 s) until they are gone.
    let closed; const gone = new Promise((r) => { closed = r; });
    const out = await new Promise((ok, no) => {
      const p = spawn(agy, [`-p=${GEMINI_PROMPT}`, '--model', model, '--output-format', 'stream-json', '--disable-slash-commands', '--sandbox'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      let o = '';
      p.stdout.on('data', (d) => {
        o += d; if (o.length > 1e6) { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }   // a runaway answer (a transcript is a few KB)
        if (!conv) for (const line of o.split('\n').slice(0, -1)) { try { const x = JSON.parse(line); if (x.event === 'init' && /^[\w-]+$/.test(x.conversation_id || '')) { conv = x.conversation_id; break; } } catch {} }   // only from the complete init line
      });
      p.stderr.resume();
      const to = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch {} no(Object.assign(new Error('Gemini (agy) took over ' + timeoutMs / 1000 + ' s'), { code: 'TIMEOUT' })); }, timeoutMs);
      p.on('error', (e) => { clearTimeout(to); closed(); no(e); });
      p.on('close', () => { clearTimeout(to); closed(); ok(o); });
    }).catch(async (e) => { await Promise.race([gone, new Promise((r) => setTimeout(r, 2000))]); throw e; });
    let j = null; for (const line of out.split('\n')) { try { const x = JSON.parse(line); if (x?.event === 'result') j = x.result; } catch {} }
    if (j?.status !== 'SUCCESS') {   // the status and the HTTP class only: agy's error text can quote the request
      const e = String(j?.error || ''); throw Object.assign(new Error(`agy ${j?.status || 'no answer'}${/\b(429|503)\b/.exec(e)?.[0] ? ' ' + /\b(429|503)\b/.exec(e)[0] : ''}`), { code: /429|quota|exhausted/i.test(e) ? 'QUOTA' : /503|capacity/i.test(e) ? 'BUSY' : 'GEMINI' });
    }
    const resp = String(j.response || ''), a = resp.indexOf('{'), b = resp.lastIndexOf('}');   // the JSON object, even inside a ``` fence or after a sentence
    let r; try { r = JSON.parse(resp.slice(a, b + 1)); } catch {}
    // measured 2026-11-24: about half the he+en+de clips came back cut off mid-word by "This request was blocked by Gemini's filters"
    if (typeof r?.text !== 'string') throw Object.assign(new Error('Gemini answer without text'), { code: /blocked by Gemini's filters/.test(resp) ? 'BLOCKED' : 'GEMINI' });
    // only the three the owner speaks ('iw' = the old code for Hebrew): a stray 'ar' or 'yi' must not count as "another language" in smartDecide
    const langs = [...new Set((Array.isArray(r.langs) ? r.langs : []).map((l) => String(l).toLowerCase().slice(0, 2).replace('iw', 'he')).filter((l) => SPOKEN.includes(l)))];
    return { text: r.text.trim(), langs, lang: langs[0] || null, prob: null, model, ms: Date.now() - t0 };
  } finally {
    geminiBusy--;
    fs.rmSync(dir, { recursive: true, force: true });
    if (conv && /^[\w-]+$/.test(conv)) {   // the clip's conversation in agy's own history (it holds the transcript): not kept
      const h = path.join(os.homedir(), '.gemini', 'antigravity-cli');
      for (const f of [`conversations/${conv}.db`, `conversations/${conv}.db-wal`, `conversations/${conv}.db-shm`, `brain/${conv}`, `presence/${conv}.lock`]) fs.rmSync(path.join(h, f), { recursive: true, force: true });
    }
  }
}
