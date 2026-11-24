// Rolling correction for live dictation (Settings > Voice > Rolling correction). While the browser's speech service types the words, the page
// streams the same microphone as 16 kHz mono PCM over a WebSocket (/ws/voice). Here the stream is cut at pauses, each finished phrase is read
// by Whisper on this machine (a second warm worker, voice.mjs + voice/worker.py), and the text goes back a few seconds behind the speaker; the
// page swaps it in for the words typed in that time window (public/rolling.js decides). One stream at a time, paused when the box is busy.
// Nothing here logs audio or text: sizes, times and reasons only.
import crypto from 'node:crypto';
import fs from 'node:fs';

// Model per dictation language, measured 2026-11-24 (40 cores, no GPU, load ~3, 10 threads): ivrit-ai turbo forced to Hebrew, temperature 0,
// writes Hebrew exactly, English words inside it too (~4.5-5.5 s per phrase at moderate load). For English and German small and large-v3-turbo
// gave the same text on the test sentences, small in 1.3-1.5 s, turbo in 4.7-5 s: small. ivrit is never used for German (it writes German in
// Hebrew letters).
export const ROLL_MODEL = { he: 'ivrit-ai/whisper-large-v3-turbo-ct2', en: 'small', de: 'small' };
export const ROLL_MAX_LOAD = 30, ROLL_MAX_MS = 8000, ROLL_MAX_RSS = 3.5 * 2 ** 30;   // pause above these (1-min load, one phrase's time, worker RAM)
const SR = 16000, FRAME = 480;   // 30 ms frames

// ---- When rolling must pause (pure, test-roll.mjs). load1: the 1-minute load average; lastMs: the last phrase's time (null for a cold
// worker's first phrase, which includes loading the model); others: another stream is running; rss: the worker's resident memory.
export function rollGuard({ load1 = 0, lastMs = null, others = false, rss = 0 } = {}) {
  if (others) return 'stream';   // one stream ≈ 10 cores and 2 GB: a second dictation (another tab, the phone) stays live-only
  if (load1 > ROLL_MAX_LOAD) return 'load';   // at load 55-65 every phrase took 5-7x longer: it would trail the speaker by half a minute
  if (lastMs != null && lastMs > ROLL_MAX_MS) return 'slow';
  if (rss > ROLL_MAX_RSS) return 'ram';
  return null;
}

// ---- Cuts the PCM stream at pauses. Energy per 30 ms frame against a slowly adapting noise floor (the browser's noise suppression keeps
// silence low). A phrase ends after silenceMs of silence, or at maxMs, then at the quietest frame of its last 2 s, so a word is rarely cut.
// Speech under minSpeechMs in total (a click, a cough) is dropped. Times are stream milliseconds (samples received / 16).
export function createSegmenter({ silenceMs = 650, maxMs = 8000, minSpeechMs = 300, padMs = 200 } = {}) {
  let floor = 0.002, pos = 0, rest = new Int16Array(0), cur = null, quiet = 0, pre = [];   // cur = { start, frames: [{ pcm, rms, speech }] }
  const out = [];
  const close = (n) => {   // the first n frames of cur become a phrase; the rest start the next one
    const fr = cur.frames.slice(0, n), speech = fr.filter((f) => f.speech).length * 30;
    if (speech >= minSpeechMs) {
      const pcm = new Int16Array(fr.length * FRAME); fr.forEach((f, i) => pcm.set(f.pcm, i * FRAME));
      out.push({ startMs: cur.start, endMs: cur.start + fr.length * 30, pcm });
    }
    const left = cur.frames.slice(n); cur = left.some((f) => f.speech) ? { start: cur.start + n * 30, frames: left } : null; quiet = 0;
  };
  function frame(pcm) {
    let sum = 0; for (let i = 0; i < FRAME; i++) sum += (pcm[i] / 32768) ** 2;
    const rms = Math.sqrt(sum / FRAME), speech = rms > Math.max(0.006, floor * 3);
    if (!speech) floor += (rms - floor) * 0.05;
    const t = pos; pos += 30;
    if (!cur) {
      if (!speech) { pre.push(pcm); if (pre.length > padMs / 30) pre.shift(); return; }
      cur = { start: t - pre.length * 30, frames: pre.map((p) => ({ pcm: p, rms: 0, speech: false })) }; pre = [];   // a little lead-in: the first consonant is quiet
    }
    cur.frames.push({ pcm, rms, speech }); quiet = speech ? 0 : quiet + 30;
    if (quiet >= silenceMs) return close(cur.frames.length - Math.round((silenceMs - padMs) / 30));   // keeps padMs of the silence
    if (cur.frames.length * 30 >= maxMs) {
      const from = cur.frames.length - Math.round(2000 / 30); let best = cur.frames.length - 1;
      for (let i = from; i < cur.frames.length - 6; i++) if (cur.frames[i].rms < cur.frames[best].rms) best = i;
      close(best + 1);
    }
  }
  return {
    push(int16) {   // any length; whole frames are processed, the remainder waits for the next push
      const all = new Int16Array(rest.length + int16.length); all.set(rest); all.set(int16, rest.length);
      let i = 0; for (; i + FRAME <= all.length; i += FRAME) frame(all.slice(i, i + FRAME));
      rest = all.slice(i); return out.splice(0);
    },
    flush() { if (cur) close(cur.frames.length); return out.splice(0); },
    get ms() { return pos; },
  };
}

const wav = (pcm) => {   // 16 kHz mono 16-bit WAV for voice.transcribe (it decodes with ffmpeg like any recording)
  const h = Buffer.alloc(44), n = pcm.byteLength;
  h.write('RIFF', 0); h.writeUInt32LE(36 + n, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(n, 40);
  return Buffer.concat([h, Buffer.from(pcm.buffer, pcm.byteOffset, n)]);
};

// ---- A minimal WebSocket (RFC 6455) on the console's own http servers: no dependency for one route. Text and binary messages from the page,
// text messages back; ping answered; fragmented frames joined; a message over maxMsg closes the socket.
function wsServe(socket, onMessage, onClose, maxMsg = 1 << 20) {
  let buf = Buffer.alloc(0), parts = [], open = true;
  const frame = (op, data) => {
    const n = data.length, h = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
    if (open) socket.write(Buffer.concat([h, data]));
  };
  const close = (code = 1000) => { if (!open) return; const b = Buffer.alloc(2); b.writeUInt16BE(code); frame(8, b); open = false; socket.end(); };
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const fin = buf[0] & 0x80, op = buf[0] & 15, masked = buf[1] & 0x80; let n = buf[1] & 127, off = 2;
      if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); off = 4; } else if (n === 127) { if (buf.length < 10) return; n = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (!masked || n > maxMsg) return close(1009);   // a browser always masks; nothing the page sends is that big
      if (buf.length < off + 4 + n) return;
      const key = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, off + 4 + n)); buf = buf.subarray(off + 4 + n);
      for (let i = 0; i < n; i++) data[i] ^= key[i & 3];
      if (op === 8) { close(); continue; }
      if (op === 9) { frame(10, data); continue; }
      if (op === 10) continue;
      parts.push(data); if (parts.reduce((s, p) => s + p.length, 0) > maxMsg) return close(1009);
      if (op) parts.op = op; else if (parts.length === 1) return close(1002);   // a continuation with no message open
      if (!fin) continue;
      const msg = Buffer.concat(parts), kind = parts.op; parts = [];
      onMessage(kind === 1 ? msg.toString('utf8') : msg);
    }
  });
  socket.on('close', () => { open = false; onClose(); }); socket.on('error', () => {});
  return { send: (obj) => frame(1, Buffer.from(JSON.stringify(obj))), close, get open() { return open; } };
}

// ---- The /ws/voice endpoint. auth(req) = the page's token (offered as the WebSocket subprotocol: a browser cannot set headers on a
// WebSocket) and voice + rolling switched on; anything else gets 403 before the upgrade. voice = a createVoice() instance of its own.
export function createRolling({ voice, auth, loadavg = () => 0, log = () => {} }) {
  let active = null;   // the one stream allowed at a time
  const rssOf = (pid) => { try { return +/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1] * 1024; } catch { return 0; } };
  function upgrade(req, socket) {
    const key = req.headers['sec-websocket-key'], protos = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());
    if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket' || !auth(protos[1] || '')) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: seat\r\n\r\n`);
    socket.setNoDelay(true); socket.setKeepAlive(true, 20000);
    session(socket);
  }
  function session(socket) {
    const me = {}; let lastPcm = Date.now(), lang = 'he', seg = null, queue = Promise.resolve(), waiting = 0, paused = null, ending = false, id = 0, lastMs = null, tick = null, t0 = Date.now();
    const ws = wsServe(socket, onMsg, () => { clearInterval(tick); if (active === me) active = null; paused ??= 'closed'; });
    const pause = (why) => {
      if (paused) return; paused = why; clearInterval(tick); if (active === me) active = null;
      log(`[roll] paused: ${why} (load ${loadavg().toFixed(1)})`); ws.send({ type: 'paused', why }); ws.close();
    };
    // no audio for 20 s while streaming: a phone that dropped off the network without closing (the one-stream slot must not stay taken)
    const check = () => { if (!ending && Date.now() - lastPcm > 20000) return pause('silent'); const pid = voice.pid?.(), w = rollGuard({ load1: loadavg(), lastMs, rss: pid ? rssOf(pid) : 0 }); if (w === 'ram') voice.stop(); if (w) pause(w); };
    function onMsg(m) {
      if (paused) return;
      if (typeof m !== 'string') {   // PCM: 16-bit little-endian, 16 kHz mono
        if (!seg || ending) return; lastPcm = Date.now();
        if (seg.ms > 5 * 60000) return pause('long');   // the 5-minute cap /api/transcribe has too
        for (const p of seg.push(new Int16Array(m.buffer, m.byteOffset, m.length >> 1))) run(p);
        return;
      }
      let x; try { x = JSON.parse(m); } catch { return; }
      if (x.type === 'lang' && seg && !ending) for (const p of seg.flush()) run(p);   // speech before the switch is read in its own language
      if (x.type === 'lang' || x.type === 'start') lang = ROLL_MODEL[x.lang] ? x.lang : 'he';
      if (x.type === 'lang' && seg && me.model !== ROLL_MODEL[lang]) warm();
      if (x.type === 'start' && !seg) {
        const w = rollGuard({ load1: loadavg(), others: !!active && active !== me });
        if (w) return pause(w);
        active = me; seg = createSegmenter(); t0 = Date.now(); tick = setInterval(check, 10000); tick.unref?.();
        ws.send({ type: 'ready', model: ROLL_MODEL[lang] }); warm();
      }
      if (x.type === 'end' && !seg) { ws.send({ type: 'done' }); paused = 'done'; return ws.close(); }   // stopped before the stream started
      if (x.type === 'end' && seg && !ending) {   // dictation stopped: the last phrase is read, then 'done'
        ending = true; if (active === me) active = null; for (const p of seg.flush()) run(p);   // the slot is free at once: a new dictation may start while the last phrase is read
        queue.then(() => { if (!paused) { ws.send({ type: 'done' }); paused = 'done'; ws.close(); if (active === me) active = null; clearInterval(tick); } });
      }
    }
    // Loads the model while the owner starts speaking (1 s of silence: Whisper's VAD finds nothing, ~1 s once loaded). Measured 2026-11-24:
    // without it the first phrase took 8.4 s (the load) and the next two waited behind it, 9 s behind the speaker instead of ~5.
    function warm() {
      const model = me.model = ROLL_MODEL[lang], l = lang;
      queue = queue.then(() => voice.transcribe(wav(new Int16Array(SR)), { model, lang: l, temperature: 0 })).catch(() => {});
    }
    function run(p) {
      const phraseId = ++id, l = lang, model = ROLL_MODEL[l];
      if (waiting >= 3) return pause('behind');   // phrases piling up: the worker cannot keep pace with the speaker
      waiting++;
      queue = queue.then(async () => {
        if (paused) return;
        const cold = !voice.running() || me.model !== model; me.model = model;   // a phrase that paid a model (re)load (warm-up failed): not judged by time
        try {
          const r = await voice.transcribe(wav(p.pcm), { model, lang: l, temperature: 0 });
          lastMs = cold ? null : r.ms;
          log(`[roll] phrase ${phraseId} ${((p.endMs - p.startMs) / 1000).toFixed(1)} s audio, ${r.ms} ms, ${model}${cold ? ' cold' : ''}`);
          if (!paused || paused === 'done') ws.send({ type: 'phrase', phraseId, text: r.text, lang: l, startMs: p.startMs, endMs: p.endMs, ms: r.ms });
          if (!ending) check();
        } catch (e) { if (e.code !== 'EMPTY') { log(`[roll] phrase ${phraseId} failed: ${String(e.message || e).slice(0, 120)}`); pause(e.code === 'BUSY' ? 'behind' : 'error'); } }
      }).finally(() => { waiting--; });
    }
    log(`[roll] stream open`);
    socket.on('close', () => log(`[roll] stream closed after ${((Date.now() - t0) / 1000).toFixed(0)} s${paused && paused !== 'done' && paused !== 'closed' ? ', ' + paused : ''}`));
  }
  return { upgrade, get active() { return !!active; } };
}
