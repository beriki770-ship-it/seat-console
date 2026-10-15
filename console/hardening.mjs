// Small pure helpers of the Seat Console server, kept out of server.mjs (which starts a server on import) so test-hardening.mjs can import them.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

// Windows briefly locks files (antivirus, indexer): a write or rename that fails once usually works 50 ms later.
// Per-conversation throttle for `conv` summaries: at most one per `ms`, the newest waiting one always goes out. `removed` drops a conversation's waiting summary and
// timestamp, and the timer callback returns when nothing is pending, so a deleted conversation never sends `data: undefined`. now/setTimer are injectable for tests.
export function convThrottle(sendAll, ms, now = Date.now, setTimer = (fn, d) => setTimeout(fn, d).unref()) {
  const last = new Map(), timer = new Map();
  return (obj) => {
    if (obj.removed) { timer.delete(obj.removed); last.delete(obj.removed); }
    const id = obj.conv?.id; if (!id) return sendAll(obj);
    const wait = ms - (now() - (last.get(id) || 0));
    if (wait <= 0 && !timer.has(id)) { last.set(id, now()); return sendAll(obj); }
    const had = timer.has(id); timer.set(id, obj);          // the newest summary replaces the waiting one
    if (!had) setTimer(() => { const o = timer.get(id); if (!o) return; timer.delete(id); last.set(id, now()); sendAll(o); }, Math.max(wait, 0));
  };
}
export const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function retry(fn, tries = 3, ms = 50) {
  for (let i = 1; ; i++) { try { return fn(); } catch (e) { if (i >= tries) throw e; nap(ms); } }
}

// Log rotation by copy-truncate: the file may be held open by a redirect (cmd's `>>`), which forbids renaming it. Keeps <f>.1 and <f>.2.
export function rotateLog(f, maxBytes = 5 * 1024 * 1024) {
  try {
    if (fs.statSync(f).size < maxBytes) return false;
    fs.rmSync(f + '.2', { force: true });
    if (fs.existsSync(f + '.1')) fs.renameSync(f + '.1', f + '.2');
    fs.copyFileSync(f, f + '.1'); fs.truncateSync(f, 0);
    return true;
  } catch (e) { if (e.code !== 'ENOENT') throw e; return false; }
}

// Pending user turns: +1 when a message is written to the process, -1 on each result. `working` is derived from the counter.
export const turnStart = (c) => { c.turns = (c.turns || 0) + 1; c.working = true; };
export const turnEnd = (c) => { c.turns = Math.max(0, (c.turns || 0) - 1); c.working = c.turns > 0; };
export const clearTurns = (c) => { c.turns = 0; c.working = false; };

// Replay offset of a conversation's host output: the last logged event of the CURRENT host generation. A respawn (or compaction)
// restarts the file at byte 0, so a hoff written by an older generation points past the new file and must be ignored.
export const lastHoff = (events, gen) => events.findLast((e) => e.hoff && (e.hgen || 0) === (gen || 0))?.hoff || 0;

// The newest `page` events before index `before`; without `before` the window also reaches back to the oldest still-open approval card.
export function eventWindow(all, pendingIds, before, page = 500) {
  const end = before == null ? all.length : Math.max(0, Math.min(all.length, before));
  let from = Math.max(0, end - page);
  if (before == null) for (const id of pendingIds) { const i = all.findIndex((e) => e.type === 'console_perm' && e.requestId === id); if (i >= 0 && i < from) from = i; }
  return { from, events: all.slice(from, end), total: all.length };
}

// Which live conversation to stop to make room: the idle one that was quiet the longest; undefined when every one is busy.
export const pickIdle = (live, isBusy, quietSince) => live.filter((c) => !isBusy(c)).sort((a, b) => quietSince(a) - quietSince(b))[0];

// First n characters without cutting a surrogate pair (emoji) in half.
export const clipChars = (s, n) => Array.from(String(s)).slice(0, n).join('');

// ---- file previews: which path segments are never served ----
// A directory is matched by WHOLE name (secrets/, .env.local/, credentials/, tokens/, passwords/): "design-tokens/" and "tokenizer/" are ordinary folders.
// The FILE name keeps the loose pattern (any name containing secret/token/password/credential, .env, *.pem, *.key, id_rsa).
const DENY_DIR = /^(secrets?|credentials?|tokens?|passwords?|\.env(\..*)?)$/i;
const DENY_FILE = /secret|token|password|credential|\.env|\.pem$|\.key$|id_rsa/i;
export function isDeniedPath(real) {
  const segs = real.split(/[\\/]/).filter(Boolean), file = segs.pop() || '';
  return DENY_FILE.test(file) || segs.some((s) => DENY_DIR.test(s));
}
// A path a message names -> the real file, null (missing), or 'forbidden'. Allowed: under the projects folder or the conversation's cwd, a preview type (rules.mime),
// never this server's folder (token.txt, chat logs) or data dir, never .claude, never a denied name. Used by GET /api/file and by the Telegram file sender alike.
const under = (file, dir) => { const f = file.toLowerCase(), d = dir.toLowerCase().replace(/[\\/]+$/, ''); return f === d || f.startsWith(d + path.sep); };
export function resolveIn(p, c, { projects, here, data, defaultCwd, mime }) {
  if (!p) return null;
  const base = c?.cwd || defaultCwd;
  let real; try { real = fs.realpathSync(path.resolve(base, p)); } catch { return null; }
  if (!fs.statSync(real).isFile()) return null;
  const ok = under(real, projects) || (c && under(real, fs.realpathSync(c.cwd)));
  if (!ok || under(real, here) || under(real, data) || /\.claude/i.test(real) || isDeniedPath(real) || !mime[path.extname(real).slice(1).toLowerCase()]) return 'forbidden';
  return real;
}
// The files a finished turn produced, for Telegram: [{ path, name, size }]. On top of the /api/file rules (resolveIn), Telegram gets media + pdf only (SEND_EXT):
// it is an automatic push, and config.json / .mcp.json / settings.json / *-adminsdk-*.json carry keys. `writes` = files the turn created (Write);
// `named` = paths the reply only mentions: sent only when modified at or after the turn start (`since`), so an old render or a doc the reply quotes is not re-sent.
// Each real file once, empty files left out (Telegram rejects them).
export const SEND_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'pdf']);
export function outFiles({ writes = [], named = [], since = 0 }, c, rules) {
  const seen = new Set(), out = [];
  for (const [p, fresh] of [...writes.map((p) => [p, false]), ...named.map((p) => [p, true])]) {
    try {
      const real = resolveIn(p, c, rules); if (!real || real === 'forbidden' || seen.has(real.toLowerCase()) || !SEND_EXT.has(path.extname(real).slice(1).toLowerCase())) continue;
      const st = fs.statSync(real); if (fresh && st.mtimeMs < since) continue;
      seen.add(real.toLowerCase()); if (st.size) out.push({ path: real, name: path.basename(real), size: st.size });
    } catch {}   // a file deleted or a cwd gone in between: not sent, nothing else breaks
  }
  return out;
}

// ---- host output lines ----
// Wraps the per-line work for one conversation. The replay offset (c.hostOff) moves only AFTER handle() succeeded; a line that throws is logged and skipped, and from then on
// the offset stays where it was (a restart replays from the failing line; events already logged carry their own hoff, so nothing is doubled).
// After a compaction the host-out file restarts at byte 0: a live line whose `end` is bigger than the file now is a stale offset from the old file. The line itself is real output
// (dropping it would hang a turn), so it is handled, just without an offset.
export function lineHandler({ c, r, handle, sizeOf, onAdvance = () => {}, onError }) {
  return (line, end) => {
    let off = end;
    if (r.compacted) { if (end > sizeOf()) off = 0; else r.compacted = false; }
    try { handle(line, off); }
    catch (e) { r.lineFailed = true; onError(e, line); return; }
    if (off && !r.lineFailed) { c.hostOff = off; onAdvance(); }
  };
}

// Truncate the host-out file once everything in it has been handled. Returns true only when the file really is empty afterwards (a line the host appended between our
// check and the truncate would make it non-empty: then nothing is bumped by the caller).
// `beforeTruncate` runs after the size check and BEFORE the truncate: the caller persists the new offset there, so a crash between the two steps leaves a reset offset on an
// untruncated file (nothing replayed twice because the offset restarts at 0 of a new generation) and never an old offset pointing into an emptied file.
export function compactFile(f, hostOff, x = fs, beforeTruncate) {
  if (x.statSync(f).size !== hostOff) return false; // something not handled yet is in there: leave it
  beforeTruncate?.();
  x.truncateSync(f, 0);
  return x.statSync(f).size === 0;
}

// ---- failures ----
// N consecutive failures call onTrip once; the first success after that calls onClear.
export function failCounter(limit, onTrip, onClear) {
  let n = 0, tripped = false;
  return { fail() { if (++n >= limit && !tripped) { tripped = true; onTrip(); } }, ok() { n = 0; if (tripped) { tripped = false; onClear(); } }, get tripped() { return tripped; } };
}
// Errors that only mean "the other end went away" (a seat process or a socket died mid-write); everything else on uncaughtException ends the process so the supervisor restarts it.
export const isBenignCrash = (e) => /\b(EPIPE|ECONNRESET|ERR_STREAM_DESTROYED|ERR_STREAM_WRITE_AFTER_END|ECONNABORTED)\b/.test(String(e?.code || '') + ' ' + String(e?.message || e));
// Wraps a timer body: a throw is logged at most once per window per message instead of every tick.
export function guard(name, fn, log = console.log, windowMs = 5 * 60000, now = Date.now) {
  const seen = new Map();
  return (...a) => {
    try { return fn(...a); } catch (e) {
      const key = String(e?.message || e), t = now(), s = seen.get(key);
      if (!s || t - s.at >= windowMs) { log(`[${name}] ${e?.stack || e}${s?.n ? ` (repeated ${s.n}x)` : ''}`); seen.set(key, { at: t, n: 0 }); } else s.n++;
    }
  };
}

// ---- telegram offset ----
// The persisted getUpdates offset belongs to ONE bot: with another token its update ids restart, so the old offset would hide every new update. Only a hash of the token is stored.
export function offsetFor(st, token) {
  const h = token ? crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16) : null;
  // No hash yet = a state.json from before this check: the stored offset belongs to the token in use now (resetting would replay every update Telegram still holds), so only record the hash.
  if (h && st.tgTokenHash !== h) { if (st.tgTokenHash) st.tgOffset = 0; st.tgTokenHash = h; }
  return st.tgOffset || 0;
}

// M5 safety net. Measured 2026-10-13 (haiku, a 20 s turn, second message sent after 5 s): the CLI folds a mid-turn message INTO the running turn and emits ONE `result`
// for both. The pending-turn counter then stays at 1 for ever. After a result with turns still pending, `r.clampAt` is set; if no assistant/user/tool activity follows
// for settleMs, no second result is coming and the counter is cleared. A late real activity event still restarts the working state (handleLine: CLI-started turns).
// A queued second turn on a high-effort model can stay silent for well over 6 s before its first event, so the clamp waits CLAMP_MS (not the 6 s "finished" settle window)
// and never runs while background agents/tasks are listed (c.bg): the CLI may start the next turn by itself when one finishes.
export const CLAMP_MS = 120000;
export const staleTurns = (c, r, now, settleMs) => !!(r.clampAt && c.turns > 0 && !(r.perms?.size) && !(c.bg?.length) && r.activityAt <= r.clampAt && now - r.clampAt >= settleMs);

// ---- request gate: Host/Origin allow-list, then Basic auth for everything that is not this PC itself ----
// `tailscale serve --https=443 http://127.0.0.1:4850` proxies the phone's https requests FROM 127.0.0.1, so a loopback socket alone no longer means "local".
// A request came through serve when its Host is the bare MagicDNS name (a local browser always sends host:port) or it carries the headers serve adds
// (Tailscale-User-Login / Tailscale-User-Name for tailnet users, X-Forwarded-For always). Such a request needs Basic auth exactly like the Tailscale-IP listener.
// Defence in depth: ANY proxy header (Via, Forwarded, X-Forwarded-*, Tailscale-*) marks a request as proxied, whatever proxy sits in front, so no future proxy inherits "local".
export const isLoopback = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
const PROXY_HEADERS = ['via', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'];
export const viaServe = (h, tsName) => (!!tsName && String(h.host || '').toLowerCase() === tsName.toLowerCase())
  || PROXY_HEADERS.some((k) => h[k] != null) || Object.keys(h).some((k) => k.startsWith('tailscale-'));   // node lowercases header names
export const isLocal = (addr, h, tsName) => isLoopback(addr) && !viaServe(h, tsName);
const sameStr = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
// 403 = foreign Host (DNS rebinding) or Origin (another website); 401 = remote without the right Basic auth; 0 = pass.
export function gate(addr, h, { hosts, origins, tsName, auth }) {
  if ((h.origin && !origins.includes(h.origin)) || !hosts.includes(h.host)) return 403;
  if (!isLocal(addr, h, tsName) && !sameStr(h.authorization || '', auth)) return 401;
  return 0;
}
