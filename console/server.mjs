// Seat Console server: several `claude -p` stream-json processes per Team seat (one per conversation),
// a browser chat UI on top. Zero dependencies. Listens on loopback and on the Tailscale IP only.
// Every log line carries a UTC stamp ("2026-10-13T18:03:21Z text"): the morning digest counts the errors since 20:00 from server.log.
{ const log = console.log.bind(console); console.log = (...a) => log(new Date().toISOString().slice(0, 19) + 'Z', ...a); }
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createTelegram, Throttle, sentLine, quotaWarnDue, buildQuotaWarning, esc } from './telegram.mjs';
import { markInterrupted, isCleanExit, crashLoop, crashWarnDue } from './recovery.mjs';
import { createRoutines } from './routines.mjs';
import { slimEvent, slimEvents, toolDetail, memTrim, memSlim } from './slim.mjs';
import { applyBackground, isActivity, backgroundText } from './background.mjs';
import { convThrottle, retry, rotateLog, turnStart, turnEnd, clearTurns, lastHoff, eventWindow, pickIdle, clipChars, staleTurns, CLAMP_MS, lineHandler, compactFile, failCounter, isBenignCrash, guard, offsetFor, gate, viaServe, resolveIn, outFiles, isDeniedPath } from './hardening.mjs';
import { createLifecycle } from './lifecycle.mjs';
import { guardedKillers, hostNeedle } from './procid.mjs';
import { applyCtx, parseContextReply, ctxLevel, AUTOCOMPACT_BUFFER } from './context.mjs';
import { runRetention, readLogText, restoreLog, gzPath, purgeArchive } from './retention.mjs';
import { viennaHm, viennaYmd, viennaHour, dueSlot, digestRefs, classify, digestRoutines, scanLog, buildMorningDigest, buildEveningDigest } from './digest.mjs';
import { markTurn, answered, addManualPin, donePin, activePins, setTitle, autoTitle } from './marks.mjs';
import { paths as hostPaths, pidAlive, readJson, readOutFrom, spawnHost, connectHost, stopHost } from './hostlink.mjs';
import { loadRemotes, followRemote, parseLine, STALE_MS } from './remote.mjs';
import * as rhost from './rhost.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { findPaths } = createRequire(import.meta.url)('./public/paths.js');   // the browser's preview detector: the same paths become Telegram attachments
const SEATS_DIR = path.dirname(HERE);
// `--port <n>` and `--data <dir>` start an isolated TEST instance (start-test.ps1: 4851, console\test-data): own state, logs, uploads and token,
// no Tailscale bind and Telegram fully off (a second getUpdates poller on the production bot would steal its updates). All agent testing happens there.
const arg = (name) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : null; };
const PORT = +arg('port') || 4850;
const DATA = arg('data') ? path.resolve(arg('data')) : HERE;
const ISOLATED = DATA !== HERE;
if (ISOLATED && PORT === 4850) { console.log('refusing: --data with the production port 4850'); process.exit(1); }

// ---- bind FIRST. A second instance (a manual start, the supervisor racing start-console.ps1) must find out the port is taken before it touches anything:
// no state load/save, no reattach (it could kill a live conversation's claude), no Telegram poller, no routines, no crash-recover message. It just leaves.
// The request handler is gated until startup below has finished (503 meanwhile); the process 'exit' handler at the bottom is registered only after this bind succeeded.
let ready = false;
await new Promise((ok) => {
  // /health answers 503 {ready:false} while startup runs, so start-console.ps1 can tell "starting" from "hung" and never kills a starting console (the handler serves it once ready).
  const first = http.createServer((req, res) => (ready ? handler(req, res)
    : req.url === '/health' ? (res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' }), res.end('{"ready":false}'))
    : (res.writeHead(503, { 'Retry-After': '2' }), res.end('starting'))));
  let bound = false;
  first.on('error', (e) => {
    if (bound) return console.log(`[listen] 127.0.0.1: ${e.message}`);
    if (e.code === 'EADDRINUSE') { console.log(`[listen] 127.0.0.1:${PORT} is taken by a running console: exiting`); process.exit(0); }
    console.log(`[listen] 127.0.0.1: ${e.message}`); process.exit(1);
  });
  first.listen(PORT, '127.0.0.1', () => { bound = true; ok(); });
});
fs.mkdirSync(DATA, { recursive: true });
// seats.json (copy seats.example.json): the seats plus `projectsDir`, the default cwd and the root file previews may read from.
const CONFIG = JSON.parse(fs.readFileSync(path.join(SEATS_DIR, 'seats.json'), 'utf8').replace(/^﻿/, ''));
const SEATS = CONFIG.seats;
const WIN = process.platform === 'win32';
const HOME = WIN ? process.env.USERPROFILE : os.homedir();
// claude --effort choices (2.1.284) plus 'ultracode', the app's top stop: it has no CLI flag, so it runs
// at --effort max and every message carries the 'ultracode' keyword, which opts the turn into Workflow orchestration.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];

// A server started from inside a Claude session inherits its CLAUDE_* / CLAUDECODE vars
// (account uuid, session id, child-session marker). Passed on, they turn off transcript
// saving in the seat ("inherited CLAUDE_CODE_CHILD_SESSION marker") and can point it at the
// wrong account. Every seat process starts from an env without them.
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k];
  return env;
}
// npm's claude.cmd just wraps claude.exe. The npm global was installed from inside the
// Claude desktop app (MSIX), so its real files live in the package's LocalCache; %APPDATA%\npm
// only exists in the app's virtualized view. Started by the scheduled task or a shortcut we are
// OUTSIDE that view, so look in the real places first.
// Linux / macOS: `claude` on PATH, else the native installer's ~/.local/bin and the usual npm-global / Homebrew bins (a systemd or launchd PATH is short).
const CLAUDE_EXE = !WIN ? [...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'claude')),
  path.join(HOME, '.local/bin/claude'), path.join(HOME, '.npm-global/bin/claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'].find((p) => fs.existsSync(p)) || 'claude' : (() => {
  const npmExe = 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
  const pkgs = path.join(process.env.LOCALAPPDATA, 'Packages');
  const candidates = [
    ...(fs.existsSync(pkgs) ? fs.readdirSync(pkgs).filter(d => d.startsWith('Claude_')).map(d => path.join(pkgs, d, 'LocalCache/Roaming', npmExe)) : []),
    path.join(process.env.APPDATA, npmExe),
    path.join(HOME, '.local/bin/claude.exe'),
  ];
  return candidates.find(p => fs.existsSync(p)) || candidates[candidates.length - 1];
})();
const TAILSCALE = WIN ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : 'tailscale';
// TEST instance only: `--claude <file.mjs|binary>` runs a fake claude (no login, no quota) for the smoke runs on Windows and Linux; a .mjs runs under this node.
const FAKE_CLAUDE = ISOLATED && arg('claude') ? path.resolve(arg('claude')) : null;
const CLAUDE_CMD = !FAKE_CLAUDE ? [CLAUDE_EXE] : /\.m?js$/.test(FAKE_CLAUDE) ? [process.execPath, FAKE_CLAUDE] : [FAKE_CLAUDE];
const DEFAULT_CWD = path.resolve(CONFIG.projectsDir || path.join(HOME, 'projects'));
const STATE_FILE = path.join(DATA, 'state.json');
const TOKEN_FILE = path.join(DATA, 'token.txt');
const TELEGRAM_FILE = ISOLATED ? path.join(DATA, 'telegram-off.json') : path.join(HOME, '.claude', 'secrets', 'seat-console-telegram.json');   // a test instance points at a file that never exists: nothing is sent
const UPLOADS = path.join(DATA, 'uploads');
const ROUTINES_FILE = arg('routines') ? path.resolve(arg('routines')) : path.join(HERE, 'routines.json');   // --routines <file>: the test instance runs a temporary routine from its own file
const AUTH_FILE = path.join(HOME, '.claude', 'secrets', 'seat-console-auth.json');
const MAX_PER_SEAT = 5;
// Stream events the UI never shows: they would bloat the log and the browser.
const NOISE = new Set(['hook_started', 'hook_response', 'commands_changed', 'post_turn_summary', 'task_summary']);
const MODE_ARGS = {
  auto: ['--permission-mode', 'auto', '--permission-prompt-tool', 'stdio'],
  ask: ['--permission-mode', 'manual', '--permission-prompt-tool', 'stdio'],
  bypass: ['--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions'],
};

const PUBLIC_STATIC = new Set(['/manifest.webmanifest', '/sw.js', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png']);   // see the gate in the handler
// ---- secrets: CSRF token (every POST) and Basic Auth (every request not from this PC itself, see gate() in hardening.mjs). Never logged. ----
if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(24).toString('hex'));
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
if (!fs.existsSync(AUTH_FILE)) fs.writeFileSync(AUTH_FILE, JSON.stringify({ user: 'seat', password: crypto.randomBytes(24).toString('base64url') }, null, 2));
const AUTH = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
const AUTH_HEADER = 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.password}`).toString('base64');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ---- Tailscale: second listener + extra allowed names. Tailscale down -> loopback only. ----
// After a boot Tailscale is often not up yet when this starts, so detection is repeatable: bindTailscale() (bottom of file) retries every 10 s until the listener is up.
let tsIp = null, tsName = null, tsWarn = null, NAMES, ALLOWED_HOSTS, ALLOWED_ORIGINS, PHONE;
function detectTailscale() {
  if (!ISOLATED) try {
    tsIp = execFileSync(TAILSCALE, ['ip', '-4'], { encoding: 'utf8', timeout: 5000 }).trim().split(/\s+/)[0] || null;
    const st = JSON.parse(execFileSync(TAILSCALE, ['status', '--json'], { encoding: 'utf8', timeout: 5000 }));
    tsName = (st.Self?.DNSName || '').replace(/\.$/, '') || null;
  } catch (e) { const m = String(e.message).split('\n')[0]; if (m !== tsWarn) { tsWarn = m; console.log('[tailscale] unavailable, loopback only (retrying):', m); } }
  if (ISOLATED) tsName = arg('ts-name');   // test instance: `--ts-name <name>` lets a curl with that Host exercise the serve path on 4851 (nothing is bound to Tailscale)
  NAMES = ['127.0.0.1', 'localhost', tsIp, os.hostname().toLowerCase(), tsName].filter(Boolean);
  // `tailscale serve` (https://<tsName>, port 443) forwards the phone's bare Host and https Origin; gate() in hardening.mjs makes those requests authenticate.
  ALLOWED_HOSTS = [...NAMES.map((n) => `${n}:${PORT}`), ...(tsName ? [tsName] : [])];
  ALLOWED_ORIGINS = [...NAMES.map((n) => `http://${n}:${PORT}`), ...(tsName ? [`https://${tsName}`] : [])];
  // Telegram "open in console" links: the https serve name when known, so on the phone they open the installed app (its scope) instead of the old http tab.
  PHONE = tsName && !ISOLATED ? `https://${tsName}` : `http://${tsIp || '127.0.0.1'}:${PORT}`;
  return !!tsIp;
}
detectTailscale();

// ---- state: conversations persisted atomically on every change ----
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
state.conversations ??= {};
state.cwds ??= {};
state.usage ??= {};         // seat -> { windows, at }: last rate_limit_event the seat's account reported
state.quotaWarned ??= {};   // seat -> resetsAt (s) of the 5 h window the 90 % Telegram warning was already sent for
state.telegramMsgs ??= {};  // telegram message_id -> conversation id, so a reply finds its conversation
state.tgOffset ??= 0;       // next getUpdates offset: without it a restart re-reads (and re-runs) the last updates Telegram still holds
for (const c of Object.values(state.conversations)) if (c.working && !c.turns) c.turns = 1; // state.json from before the pending-turn counter
// ---- remotes (remotes.json): read before anything looks at a conversation, because a conversation can live on a remote (c.remote = its name) ----
const REMOTES = loadRemotes(path.join(SEATS_DIR, 'remotes.json'), HOME);
const CTL = new Map(REMOTES.filter((r) => r.control).map((r) => [r.name, r]));   // remotes with "control": true: the console may start conversations there (rhost.mjs)
// A conversation on a remote that is no longer control: true (or no longer configured) is PARKED: moved out of state.conversations, so no route, Telegram button
// or timer can reach it, and read-only stays read-only. It comes back unchanged when the remote is control: true again. Its host, if it still runs there, is left alone.
state.parkedConvs ??= {};
for (const [id, c] of Object.entries(state.conversations)) if (c.remote && !CTL.has(c.remote)) { state.parkedConvs[id] = c; delete state.conversations[id]; }
for (const [id, c] of Object.entries(state.parkedConvs)) if (CTL.has(c.remote)) { state.conversations[id] = c; delete state.parkedConvs[id]; }
// Request data picks conversations/seats/modes by key: plain `obj[key]` would resolve "__proto__" / "constructor" to a real object.
const convOf = (id) => (typeof id === 'string' && Object.hasOwn(state.conversations, id) ? state.conversations[id] : undefined);
const hasKey = (o, k) => typeof k === 'string' && Object.hasOwn(o, k);
// A transient lock on state.json must not take the server down: 3 tries, then log and keep the in-memory state (the next save writes it).
// Three failures in a row: one Telegram warning and a red banner in the page until a save works again (a silent failure means a crash loses everything since).
const saveFails = failCounter(3,
  () => { saveError = true; try { broadcast({ saveError: true }); tg.send('⚠️ Seat Console cannot write state.json (3 saves failed in a row). Conversations are kept in memory only until it works again.').catch(notifyFailed); } catch {} }, // try: at startup broadcast/tg are not defined yet
  () => { saveError = false; try { broadcast({ saveError: false }); } catch {} });
let saveError = false;
function saveState() {
  try { retry(() => { const tmp = STATE_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state, null, 2)); fs.renameSync(tmp, STATE_FILE); }); saveFails.ok(); }
  catch (e) { console.log('[state] save failed: ' + e.message); saveFails.fail(); }
}

// Runtime part of each conversation (not persisted): process, events, pending permission requests.
const rt = new Map();
const R = (c) => { let r = rt.get(c.id); if (!r) { r = { proc: null, events: null, buf: '', perms: new Map(), procCost: 0, status: null, turnFiles: new Set(), turnWrites: new Set(), turnAsks: [], activityAt: 0, done: null, shown: null, starting: null, stopping: null, clampAt: 0, silent: false, silentGaveUp: false, lineFailed: false, compacted: false, appendFailed: false, lastAt: Date.now() }; rt.set(c.id, r); } return r; };
// A conversation that was mid-turn when the server died has no process any more: persist that as `interrupted` (see recovery.mjs).
// Each conversation's claude.exe lives in its own detached host (host.mjs), so a conversation whose host is still alive keeps working through a server restart: it is reattached by reattachAll() below, not interrupted.
const hostBase = (c) => path.join(DATA, 'logs', c.seat, c.id);
const hostInfoOf = (c) => readJson(hostPaths(hostBase(c)).info);
const liveHosts = new Set(Object.values(state.conversations).filter((c) => { try { const i = hostInfoOf(c); return i && (c.remote || pidAlive(i.pid)); } catch { return false; } }).map((c) => c.id)); // a malformed entry is handled (and logged) by reattachAll; a remote host is asked over ssh after the start (reattachRemotes)
const crashLoopStart = crashLoop(state, Date.now()); state.lastExit = null; state.lastStartAt = Date.now();
const crashed = markInterrupted(state, liveHosts) || crashLoopStart; saveState();
for (const c of Object.values(state.conversations)) { R(c).status = c.interrupted ? 'interrupted' : 'stopped'; }
const interruptedConvs = () => Object.values(state.conversations).filter((c) => !c.archived && R(c).status === 'interrupted').sort((a, b) => b.updatedAt - a.updatedAt);

const clients = new Set();
// Every client watches at most one conversation (?conv= on /api/events). Its events are sent only to the clients watching it, in slim form (slim.mjs);
// everyone else gets the compact `conv` summary, at most CONV_MS apart per conversation (the last one always goes out), so a busy agent cannot flood the page or a phone.
const CONV_MS = 500;
const sendAll = (obj) => { const line = `data: ${JSON.stringify(obj)}\n\n`; for (const x of clients) x.write(line); };
const broadcast = convThrottle(sendAll, CONV_MS);
function broadcastEvent(c, ev, i) {
  let line; for (const x of clients) if (x.watch === c.id) { line ??= (() => { const s = slimEvent(ev, i); return s ? `data: ${JSON.stringify({ convId: c.id, event: s })}\n\n` : ''; })(); if (!line) return; x.write(line); }
}
// What the user sees. The raw status says whether the TURN is running; a conversation is `working` too while background agents/tasks of its process run
// (c.bg, persisted so a console restart does not forget them) or events kept arriving in the last 20 s after the result.
const QUIET_MS = 20000;
const effStatus = (c) => { const r = R(c); if (r.status === 'stopped' && r.proc) return 'idle'; /* a live process is never `stopped` */ return r.status === 'idle' && ((c.bg?.length || 0) > 0 || Date.now() - r.activityAt < QUIET_MS) ? 'working' : r.status; };
// A conversation on a remote that ssh cannot reach (and that has no live link) reads `error · unreachable since HH:MM` until the remote answers again.
const summary = (c) => { const r = R(c), status = r.shown = effStatus(c), cut = !!c.remote && remoteDown.has(c.remote) && !r.proc; return { id: c.id, seat: c.remote ? groupOf(c.remote) : c.seat /* the page files a conversation under its group */, title: c.title, mode: c.mode, cwd: c.cwd, model: c.model, effort: c.effort, cost: c.cost, status: cut ? 'error' : status, background: cut ? downText(c.remote) : backgroundText(c.bg || []), pending: r.perms.size, needsAnswer: !!c.needsAnswer, pins: activePins(c), suggest: c.suggest || [], archived: !!c.archived, updatedAt: c.updatedAt, sessionId: c.sessionId, ctx: ctxView(c) }; };
function setStatus(c, status) { R(c).status = status; if (status !== 'interrupted') c.interrupted = false; c.updatedAt = Date.now(); saveState(); broadcast({ conv: summary(c) }); }

const logFile = (c) => path.join(DATA, 'logs', c.seat, c.id + '.jsonl');
// Memory keeps a clipped copy of each logged event (memSlim) plus the byte range of its line in the jsonl, as a non-enumerable `logAt` (never serialized,
// never spread into a page copy). /api/tool reads the full event back from there (fullEvent). An event without a range (not written yet) stays whole.
const slimAt = (ev, start, end) => { Object.defineProperty(ev, 'logAt', { value: [start, end] }); return memSlim(ev); };
function loadLog(c) {
  let got;
  try { got = readLogText(logFile(c), gzPath(DATA, c)); }   // retention.mjs may have gzipped an old conversation's log: read it from the archive
  catch (e) { // a corrupt or locked gz must not 500 /api/conversation or kill the whole digest; the gz stays (retention never overwrites it)
    console.log(`[log] read failed conv=${c.id.slice(0, 8)}: ${e.message}`);
    if (!fs.existsSync(logFile(c))) R(c).fromGz = true;    // a TRANSIENT lock (EBUSY, AV scan) must not let the next append start a jsonl beside the archive: pushEvent restores first
    return [];
  }
  if (!got) return [];
  if (got.fromGz) R(c).fromGz = true;                      // the next append restores the jsonl first (pushEvent)
  // Byte offsets count over the text of the jsonl or of its gz: both hold the same bytes (the gz is the jsonl, a restore writes it back unchanged).
  const evs = []; let at = 0;
  for (const l of got.text.split('\n')) { const start = at, n = Buffer.byteLength(l); at += n + 1; if (!l) continue; try { evs.push(slimAt(memTrim(JSON.parse(l)), start, start + n)); } catch {} }
  return evs;
}
const eventsOf = (c) => (R(c).events ??= loadLog(c));
// The same events, read the way the start (reattachAll) needs it: in 1 MB chunks with a yield after each, so /health keeps answering 503 meanwhile,
// and the log never sits in memory as one string plus its split copy. loadLog's transient peak (1.4 GB RSS for four logs of 47-149 MB) under memory
// pressure stalled a production start for 11 minutes with the loop blocked. A missing / archived / unreadable jsonl goes the sync way (its gz and error handling).
async function loadLogAsync(c) {
  const r = R(c); if (r.events) return r.events;
  let fh; try { fh = await fs.promises.open(logFile(c), 'r'); } catch { return eventsOf(c); }
  const evs = [], dec = new StringDecoder('utf8'), buf = Buffer.alloc(1 << 20); let rest = '', at = 0;
  const add = (l) => { const start = at, n = Buffer.byteLength(l); at += n + 1; if (!l) return; let e; try { e = slimAt(memTrim(JSON.parse(l)), start, start + n); } catch { return; } if (e) evs.push(e); };
  try {
    for (let n; (n = (await fh.read(buf, 0, buf.length, null)).bytesRead); await new Promise(setImmediate)) { const lines = (rest + dec.write(buf.subarray(0, n))).split('\n'); rest = lines.pop(); lines.forEach(add); }
    add(rest + dec.end());
  } catch { return eventsOf(c); }   // a read that failed half-way: the sync path reads it again (and logs a failure)
  finally { await fh.close().catch(() => {}); }
  return (r.events ??= evs);   // something that loaded it meanwhile (it read the file later, so it is at least as complete) wins
}

// ---- context window meter (context.mjs): c.ctx = {used, window, autoCompactAt, model, updatedAt} follows the stream; c.ctxBreakdown = the last parsed /context reply ----
function ctxView(c) {
  const x = c.ctx; if (!x?.used) return null;
  const pct = x.window ? Math.round((x.used / x.window) * 1000) / 10 : null, b = c.ctxBreakdown;
  return { used: x.used, window: x.window ?? null, pct, level: pct == null ? null : ctxLevel(pct), left: x.autoCompactAt ? Math.max(0, x.autoCompactAt - x.used) : null,
    model: x.model || null, updatedAt: x.updatedAt, compacting: !!rt.get(c.id)?.compacting,
    breakdown: b ? { at: b.at, categories: [...b.categories, ...(x.window ? [{ name: 'Autocompact buffer', tokens: AUTOCOMPACT_BUFFER, pct: Math.round((AUTOCOMPACT_BUFFER / x.window) * 1000) / 10, derived: true }] : [])] } : null };
}
// A conversation from before the meter existed has no c.ctx: fold the tail of its log (assistant usage + the last result's window) once at start.
// Only the last 1.5 MB are read, logs reach 30 MB; a window not found there stays empty until the next result.
for (const c of Object.values(state.conversations)) {
  if (c.ctx) continue;
  try {
    const f = logFile(c), size = fs.statSync(f).size, n = Math.min(size, 1500000), fd = fs.openSync(f, 'r'), buf = Buffer.alloc(n);
    try { fs.readSync(fd, buf, 0, n, size - n); } finally { fs.closeSync(fd); }
    const ctx = {}; let lines = buf.toString('utf8').split(/\r?\n/); if (size > n) lines = lines.slice(1);
    for (const l of lines) { let ev; try { ev = JSON.parse(l); } catch { continue; } applyCtx(ctx, ev, ev.ts); }
    if (ctx.used) c.ctx = ctx;
  } catch {}
}
function pushEvent(c, ev) {
  ev.ts ??= Date.now();
  eventsOf(c).push(ev); R(c).lastAt = ev.ts;
  const r = R(c), line = JSON.stringify(ev);
  // A new event must land on the whole log, not start a fresh file beside the archive. The restore is a full gunzip + write, so after a failure it is retried
  // at most every 30 s, not on every event (a large log would block the event loop). Logged once per conversation.
  if (r.fromGz && Date.now() >= (r.restoreAt || 0)) {
    try { retry(() => restoreLog(logFile(c), gzPath(DATA, c))); r.fromGz = false; }
    catch (e) {
      if (!r.restoreFailed) console.log(`[retention] restore failed conv=${c.id.slice(0, 8)}: ${e.message} (new events wait in memory)`);
      r.restoreFailed = true; r.restoreAt = Date.now() + 30000;
      // A corrupt gz (zlib error) will never restore: it is kept for a person and new events go to a fresh jsonl, or they would only ever live in memory.
      if (/^Z_/.test(e.code || '')) r.fromGz = false;   // the code only: a file-system EINVAL also says "invalid" and must keep retrying
    }
  }
  // Events that could not be written yet (restore pending, append failed) wait in r.unwritten and go out IN ORDER ahead of the next event that can be written,
  // so the jsonl never gets a gap. The host-out file stays their durable copy meanwhile (appendFailed blocks its compaction).
  let at = null;   // where this event's line starts in the jsonl, once it is written there (the file's size before the append + the waiting lines ahead of it)
  if (r.fromGz) { (r.unwritten ??= []).push(line); r.appendFailed = true; }
  else try { const lines = [...(r.unwritten || []), line]; retry(() => { fs.mkdirSync(path.dirname(logFile(c)), { recursive: true }); at = fileSize(logFile(c)) + lines.slice(0, -1).reduce((n, l) => n + Buffer.byteLength(l) + 1, 0); fs.appendFileSync(logFile(c), lines.join('\n') + '\n'); }); if (r.unwritten?.length) r.appendFailed = false; r.unwritten = []; } // flushed: the jsonl is whole again, host-out may be compacted
  catch (e) { at = null; (r.unwritten ??= []).push(line); r.appendFailed = true; console.log(`[log] append failed conv=${c.id.slice(0, 8)}: ${e.message}`); } // the event stays in memory and on the page
  memTrim(ev);   // after the log append: the file keeps the whole event, memory only what is read
  if (at !== null) slimAt(ev, at, at + Buffer.byteLength(line));   // written: memory keeps the clipped copy, /api/tool reads the rest from the file
  broadcastEvent(c, ev, eventsOf(c).length - 1);
}

const fileSize = (f) => { try { return fs.statSync(f).size; } catch (e) { if (e.code === 'ENOENT') return 0; throw e; } };
// The whole logged event behind a clipped memory copy, read from its byte range in the jsonl (an archived conversation: from its gz, decompressed on demand,
// it holds the same bytes). Anything unexpected (unreadable, a line that is not this event) falls back to the memory copy: clipped, but never a failed request.
async function fullEvent(c, ev) {
  if (!ev.logAt) return ev;
  const [start, end] = ev.logAt;
  try {
    let buf;
    if (fs.existsSync(logFile(c))) { const fh = await fs.promises.open(logFile(c), 'r'); try { buf = Buffer.alloc(end - start); await fh.read(buf, 0, buf.length, start); } finally { await fh.close(); } }
    else { const raw = await fs.promises.readFile(gzPath(DATA, c)); buf = (await new Promise((ok, no) => zlib.gunzip(raw, (e, b) => (e ? no(e) : ok(b))))).subarray(start, end); }
    const full = JSON.parse(buf.toString('utf8'));
    if (full.type === ev.type && full.ts === ev.ts) return full;
    console.log(`[tool] conv=${c.id.slice(0, 8)}: the line at ${start} is another event, memory copy used`);
  } catch (e) { console.log(`[tool] conv=${c.id.slice(0, 8)}: full event not read (${e.message}), memory copy used`); }
  return ev;
}
// GET /api/tool: the newest tool_use and tool_result of this id (toolDetail's choice), read back whole, then toolDetail as before.
async function toolDetailFull(c, id) {
  const evs = eventsOf(c); let use, res;
  for (let k = evs.length - 1; k >= 0 && !(use && res); k--) for (const b of evs[k].message?.content || []) {
    if (!use && evs[k].type === 'assistant' && b.type === 'tool_use' && b.id === id) use = evs[k];
    else if (!res && evs[k].type === 'user' && b.type === 'tool_result' && b.tool_use_id === id) res = evs[k];
  }
  return toolDetail(await Promise.all([use, res].filter(Boolean).map((e) => fullEvent(c, e))), id);
}

// ---- remote read-only conversations (remote.mjs): a Claude run on another machine, its stream-json file followed over ssh ----
// Each remote file is a conversation in state.remoteConvs, NOT in state.conversations: nothing that starts, sends, stops, reaps or archives looks there,
// and every POST route resolves ids with convOf, so a remote conversation can never be written to. The lines are mirrored into a local jsonl
// (logs/remote-<name>/<id>.jsonl) through pushEvent, the same path local events take: slim events in memory, /api/tool reads the full row from the mirror,
// and a restart continues after the last mirrored line (its `roff` = byte offset in the remote file), so nothing is shown twice.
state.remoteConvs ??= {};
const remoteDown = new Map();   // remote name -> since when ssh fails (ms)
const groupOf = (name) => 'remote: ' + name;
const remoteOf = (id) => (typeof id === 'string' && Object.hasOwn(state.remoteConvs, id) ? state.remoteConvs[id] : undefined);
const viewOf = (id) => convOf(id) || remoteOf(id);   // the GET routes that READ a conversation (page, tool row, live stream) only
const downText = (name) => (remoteDown.has(name) ? 'unreachable since ' + viennaHm(remoteDown.get(name)) : '');
const remoteStale = (c) => !c.done && Date.now() - (c.grewAt || 0) > STALE_MS;   // no line for 30 min and no `result`: a killed run, shown idle and read once a minute
const remoteSummary = (c) => ({ id: c.id, seat: groupOf(c.remote), title: c.title, mode: 'remote', cwd: null, model: null, effort: null, cost: c.cost, status: remoteDown.has(c.remote) ? 'error' : c.done || remoteStale(c) ? 'idle' : 'working',
  background: downText(c.remote) || (remoteStale(c) ? 'no new lines for 30+ min' : ''), pending: 0, needsAnswer: false, pins: [], suggest: [], archived: false, updatedAt: c.updatedAt, sessionId: c.sessionId, ctx: ctxView(c), remote: true });
const viewSummary = (c) => (remoteOf(c.id) === c ? remoteSummary(c) : summary(c));   // a conversation STARTED on a remote also carries c.remote, but it is a normal one
function remoteConv(r, file) {
  const id = 'remote-' + crypto.createHash('sha1').update(r.name + '\n' + file).digest('hex').slice(0, 16);
  return (state.remoteConvs[id] ??= { id, seat: 'remote-' + r.name, remote: r.name, file, title: path.posix.basename(file, '.jsonl'), cost: 0, updatedAt: Date.now() });   // seat = its log folder
}
let remoteSave = null;   // a 70 MB first read is thousands of lines: state.json is written at most once a second for them
function remoteLine(c, line, end, live) {
  c.grewAt = Date.now();   // the file grew (any line, even one skipped below): not stale
  const ev = parseLine(line); if (!ev) return;   // not an event object: skipped, the follower's offset still moves past it
  if (NOISE.has(ev.subtype) || ev.type === 'rate_limit_event' || /^control_/.test(ev.type || '')) return;   // the remote account's quota is not a local seat's
  ev.roff = end;
  applyCtx(c.ctx ??= {}, ev);
  if (ev.session_id) c.sessionId = ev.session_id;
  if (ev.type === 'result') { c.cost = ev.total_cost_usd ?? c.cost; c.done = true; } else if (ev.type === 'assistant' || ev.type === 'user') c.done = false;
  c.updatedAt = Date.now();
  pushEvent(c, ev);
  broadcast({ conv: remoteSummary(c) });
  remoteSave ??= setTimeout(() => { remoteSave = null; saveState(); }, 1000);
  // The same finished/error message a local turn gets (Telegram is off on a test instance). Not for results read from byte 0: that is history.
  if (ev.type === 'result' && live) remoteDone(c, ev);
}
// A finished `claude -p` run can write dozens of result lines at once (seen: 64 results in one second, one Telegram
// message each, some refused with 429). Wait until no further result came for 15 s, then send ONE message for the
// last one, through the same 60 s per-conversation throttle local turns use.
const remoteDoneTimers = new Map();
function remoteDone(c, ev) {
  clearTimeout(remoteDoneTimers.get(c.id));
  remoteDoneTimers.set(c.id, setTimeout(() => {
    remoteDoneTimers.delete(c.id);
    if (!doneThrottle.allow(c.id)) return;
    tg.notify(ev.is_error ? 'error' : 'done', { seat: groupOf(c.remote), title: c.title, text: ev.result || '', convId: c.id, files: [], ...ctxNote(c) }, PHONE).catch(notifyFailed);
  }, 15000).unref());
}
// ssh to a remote failed (err = its message) or worked again (err = null): reported by the follower and by every control action (rhost.mjs).
function remoteStatus(name, err) {
  if (!err === !remoteDown.has(name)) return;
  if (err) { remoteDown.set(name, Date.now()); console.log(`[remote] ${name} unreachable: ${err} (retrying with backoff)`); } else { remoteDown.delete(name); console.log(`[remote] ${name} reachable again`); }
  for (const c of Object.values(state.remoteConvs)) if (c.remote === name) broadcast({ conv: remoteSummary(c) });
  for (const c of Object.values(state.conversations)) if (c.remote === name) broadcast({ conv: summary(c) });
}
function startRemotes() {
  const followed = REMOTES.filter((r) => r.paths.length);   // a control remote may have no run files to follow
  const followers = followed.map((r) => followRemote(r, {
    offsetOf: async (file) => (await loadLogAsync(remoteConv(r, file))).findLast((e) => e.roff)?.roff || 0,
    onLines: (file, lines, live) => { const c = remoteConv(r, file); for (const x of lines) remoteLine(c, x.line, x.end, live); },
    done: (file) => { const c = remoteConv(r, file); return !!c.done || remoteStale(c); },
    onStatus: (err) => remoteStatus(r.name, err) }));
  process.on('exit', () => followers.forEach((f) => f.stop()));   // the ssh in flight goes with the server (a forced kill skips this: that ssh ends with its tail)
  if (followed.length) console.log(`[remote] following ${followed.map((r) => r.name).join(', ')} (read-only)`);
}

// ---- conversations STARTED on a remote (control: true; rhost.mjs). They live in state.conversations like local ones (c.remote = the remote's name, c.seat =
// 'remote-<name>' = its log folder) and go through the same send / permission / stop / reap / reattach code; what differs is only where the host runs:
// spawn, liveness, kills and file cleanup go over ssh, the link is `ssh -W`. A local copy of the host record (logs/remote-<name>/<id>.host.json, with `remote`)
// marks "this conversation may still have a host there"; it is removed once the host is known to be gone.
const ctlOf = (c) => (c.remote ? CTL.get(c.remote) : null);
const ctlByGroup = (name) => [...CTL.values()].find((r) => groupOf(r.name) === name || 'remote-' + r.name === name) || null;   // the page sends the group name, a conversation its seat
// The remote ssh actions of ONE conversation run one after another: a cleanup still in flight must never delete the files of the host started right after it.
const rseq = (c, fn) => { const r = R(c), run = (r.rseq || Promise.resolve()).then(fn, fn); r.rseq = run.catch(() => {}); return run; };
// Is the conversation's host still running? Local: its pid. Remote: asked over ssh (pid + its own cfg name in the command line, so a reused pid is not ours);
// null = ssh failed, unknown.
async function hostAlive(c, info) {
  const rem = ctlOf(c); if (!rem) return pidAlive(info.pid);
  const a = await rhost.remoteAlive(rem, info.pid, hostNeedle(hostBase(c)));
  remoteStatus(rem.name, a === null ? 'ssh failed while checking a host' : null);
  return a;
}

const HOST_JS = path.join(HERE, 'host.mjs');
// Remove the host's files (info/out/exit/log) once its claude is gone, and forget the replay offset that belonged to them.
function cleanHostFiles(c) { const p = hostPaths(hostBase(c)); for (const f of [p.info, p.out, p.exit, p.cfg]) fs.rmSync(f, { force: true }); c.hostOff = 0; const rem = ctlOf(c); if (rem) rseq(c, () => rhost.remoteClean(rem, c.id)); }
// taskkill without blocking the event loop (a synchronous call stalled every conversation and the page for the time it took).
const taskkill = (args) => new Promise((ok) => execFile('taskkill', args, { windowsHide: true, timeout: 10000 }, () => ok()));
// A host that survived the server but lost its claude, or whose claude outlived a dead host: kill what is left (by pid, image name checked so a reused pid is safe).
// Pid reuse: procid.mjs also checks the command line (this conversation's host-cfg file / session id) before a kill, so a pid that now belongs to something else is left alone.
const killers = guardedKillers({ taskkill });
// The running claude carries the id it was SPAWNED with; c.sessionId can change on resume/compact, so both are accepted.
const sessionNeedles = (c) => [c.spawnSessionId, c.sessionId].filter(Boolean);
// A remote conversation's pids live on the remote: killed there, with the same command-line check (rhost.remoteKill). A kill ssh could not deliver THROWS:
// the teardown then stops before it removes the host record (lifecycle.mjs track/cleanIfIdle), so the host is never forgotten while it may still run there;
// silentGaveUp lets the next message try the kill again before it starts a new one, and a restart reattaches it.
// remoteKillFailed: startProc refuses to start a second claude while the old host may still run there (lifecycle's teardown swallows the throw).
const remoteKilled = (c) => (ok) => { R(c).remoteKillFailed = !ok; if (!ok) { R(c).silentGaveUp = true; throw new Error(`remote ${c.remote} unreachable: its host could not be stopped`); } };
const killClaudePid = (pid, c) => (ctlOf(c) ? rhost.remoteKill(ctlOf(c), pid, sessionNeedles(c), true).then(remoteKilled(c)) : killers.killClaude(pid, sessionNeedles(c), c.spawnedAt));
const killHostPid = (pid, c) => (ctlOf(c) ? rhost.remoteKill(ctlOf(c), pid, hostNeedle(hostBase(c)), false).then(remoteKilled(c)) : killers.killHost(pid, hostBase(c), c.spawnedAt));
// Stop / lost host / start / make room live in lifecycle.mjs (testable against fakes): a stop and a start of one conversation may overlap, see the header there.
const { isBusy, busyCount, killProc, hostLost, stopConv, stopIdle, makeRoom, ensureProc } = createLifecycle({
  R, convs: () => Object.values(state.conversations), QUIET_MS, MAX_PER_SEAT,
  killHostPid, killClaudePid, killTree: (pid, c) => (ctlOf(c) ? killClaudePid(pid, c) : killers.killClaudeTree(pid, sessionNeedles(c), c.spawnedAt)),
  hostInfoOf, pidAlive, cleanHostFiles, startProc: (c) => startProc(c), pickIdle, clearTurns, setStatus, pushEvent, log: (l) => console.log(l) });

// `end` = byte offset after this line in the host's output file; stored on the events it produces so a reattach can resume exactly after the last one logged.
function handleLine(c, line, end) {
  if (!line.trim()) return;
  let ev; try { ev = JSON.parse(line); } catch { return; }
  const r = R(c);
  if (end) { ev.hoff = end; if (c.hostGen) ev.hgen = c.hostGen; } // the generation says which host-out file the offset belongs to
  if (ev.type === 'control_request') {
    if (ev.request?.subtype !== 'can_use_tool') { writeProc(c, { type: 'control_response', response: { subtype: 'error', request_id: ev.request_id, error: 'unsupported by Seat Console' } }); return; }
    const q = ev.request;
    // A request replayed after a reattach is already in the log (and in r.perms, rebuilt from it): showing it twice would give two approval cards.
    if (eventsOf(c).some((e) => e.type === 'console_perm' && e.requestId === ev.request_id)) return;
    r.perms.set(ev.request_id, { input: q.input, tool: q.tool_name });
    tg.notify('perm', { seat: c.seat, title: c.title, tool: q.display_name || q.tool_name, input: q.input, convId: c.id, ...quotaOf(c.seat) }, PHONE, tg.permButtons(c.id, ev.request_id)).catch(notifyFailed);
    pushEvent(c, { type: 'console_perm', requestId: ev.request_id, tool: q.display_name || q.tool_name, input: q.input, description: q.description || '', blockedPath: q.blocked_path || null, ...(end ? { hoff: end, ...(c.hostGen ? { hgen: c.hostGen } : {}) } : {}) });
    setStatus(c, 'waiting'); return;
  }
  if (ev.type === 'control_cancel_request') { r.perms.delete(ev.request_id); broadcast({ conv: summary(c) }); return; }
  // The CLI reports the account's rate-limit windows with every turn; keep the latest per seat (free usage meter).
  if (ev.type === 'rate_limit_event') { const w = ev.rate_limit_info?.unifiedWindows; if (w) { state.usage[c.seat] = { windows: w, at: Date.now() }; saveState(); broadcast({ usage: { seat: c.seat, ...state.usage[c.seat] } }); quotaWatch(c.seat); } return; }
  if (NOISE.has(ev.subtype) || ev.type === 'control_response') return;
  // Context meter. The CLI answers /context and /compact with synthetic assistant/user messages (the table, the compaction summary, a replay of the older /context text):
  // while one of OUR slash commands runs they are not chat, only the numbers matter.
  const slash = r.slash && Date.now() - r.slash.at < 600000 ? r.slash : null;
  if (applyCtx(c.ctx ??= {}, ev)) broadcast({ conv: summary(c) });
  if (ev.type === 'system' && ev.subtype === 'status' && !!r.compacting !== (ev.status === 'compacting')) { r.compacting = ev.status === 'compacting'; broadcast({ conv: summary(c) }); }
  if (ev.type === 'system' && ev.subtype === 'compact_boundary' && slash) slash.boundary = ev.compact_metadata;
  if (slash && (ev.type === 'assistant' || ev.type === 'user')) return;
  if (ev.type === 'result' && ev.local_command === 'context') {
    const b = parseContextReply(ev.result);
    if (b) { c.ctxBreakdown = { at: Date.now(), categories: b.categories }; if (b.window && !c.ctx.window) { c.ctx.window = b.window; c.ctx.autoCompactAt = b.window - AUTOCOMPACT_BUFFER; } }
    ev.result = '';   // the table is 9 KB, it lives in c.ctxBreakdown, not in every log read
  }
  if (ev.type === 'assistant') for (const b of ev.message?.content || []) if (b.type === 'tool_use' && /^(Write|Edit|NotebookEdit|MultiEdit)$/.test(b.name) && (b.input?.file_path || b.input?.notebook_path)) r.turnFiles.add(path.basename(b.input.file_path || b.input.notebook_path));
  // Files the turn CREATED (Write) go to Telegram with the done-message; an Edit of an existing file (HANDOFF.md every turn) is not a product.
  if (ev.type === 'assistant') for (const b of ev.message?.content || []) if (b.type === 'tool_use' && b.name === 'Write' && b.input?.file_path) r.turnWrites.add(b.input.file_path);
  // A question the turn asked through the question tool is a question to the user even when the final text has none (marks.mjs).
  if (ev.type === 'assistant') for (const b of ev.message?.content || []) if (b.type === 'tool_use' && b.name === 'AskUserQuestion') r.turnAsks.push(b.input);
  if (ev.session_id && ev.session_id !== c.sessionId) { c.sessionId = ev.session_id; saveState(); }
  if (ev.type === 'result') { r.procCost = ev.total_cost_usd ?? r.procCost; c.cost = (c.baseCost || 0) + r.procCost; turnEnd(c); r.activityAt = 0; }
  pushEvent(c, ev);
  const evIndex = eventsOf(c).length - 1;   // a pin made from this event points here (the page jumps to it)
  if (isActivity(ev)) {
    r.activityAt = Date.now();
    // The CLI starts turns on its own (a background agent finished): work after a result means the conversation is working again.
    if (r.status === 'idle' && (ev.type === 'assistant' || ev.type === 'user')) { turnStart(c); setStatus(c, 'working'); }
  }
  // Background agents/tasks: the list is kept per conversation; a change is shown at once and may be what lets a pending "finished" notification go out.
  const bg = applyBackground(c.bg || [], ev), had = c.bg || [];
  if (bg !== had) { c.bg = bg; saveState(); broadcast({ conv: summary(c) }); settleDone(c); }
  if (ev.type === 'result') {
    r.clampAt = c.turns > 0 ? Date.now() : 0; // turns still pending: either a queued message gets its own result, or the CLI folded it into this turn (see staleTurns)
    setStatus(c, c.turns > 0 ? 'working' : ev.is_error ? 'error' : 'idle'); // a message sent mid-turn is still queued: not idle yet
    if (ev.local_command || slash) slashDone(c, ev, slash);   // a /context or /compact reply is not a finished task: no "finished" message
    else {
    // Needs-your-answer mark, auto-pins and suggestions of this turn (marks.mjs); persisted, the summary carries them to the page.
    markTurn(c, { result: ev.result || '', isError: !!ev.is_error, i: evIndex, asks: r.turnAsks }); r.turnAsks = []; saveState();   // spent: a later result of the same turn must not pin them again broadcast({ conv: summary(c) });
    const info = { needsAnswer: !!c.needsAnswer, seat: c.seat, title: c.title, text: ev.result, convId: c.id, files: [...r.turnFiles], out: { writes: [...r.turnWrites], named: findPaths(ev.result || '', !WIN), since: r.turnAt ?? Infinity }, ...quotaOf(c.seat), ...ctxNote(c) };   // out: Write targets + files the reply names (the console's preview cards), see outFiles; no turnAt (turn began before a restart) = no named files
    if (ev.is_error) { r.done = null; tg.notify('error', info, PHONE).catch(notifyFailed); }
    else { r.done = { info, at: Date.now() }; settleDone(c); }   // the latest result wins; it is announced once ALL work of the conversation is over
    }
  }
}
// ---- /context and /compact, sent by the console itself (never into a running turn) ----
const COMPACT_FROM_PCT = 70;   // the Telegram "Compact" button appears on a finished-message from this share of the window
function ctxNote(c) { const v = ctxView(c); return v?.pct == null ? {} : { ctxPct: Math.round(v.pct), ctxCompact: v.pct >= COMPACT_FROM_PCT }; }
async function runSlash(c, kind, instructions, notify) {
  const r = R(c), busy = () => !['idle', 'stopped', 'error'].includes(effStatus(c)) || r.perms.size || c.turns || r.starting || (r.slash && Date.now() - r.slash.at < 600000);
  if (busy()) throw new Error('This conversation is running: /' + kind + ' only runs while it is idle.');
  await ensureProc(c);
  if (busy()) throw new Error('This conversation started working again: /' + kind + ' only runs while it is idle.');   // a message slipped in while the process started
  const text = kind === 'compact' && instructions?.trim() ? '/compact ' + clipChars(instructions.trim().replace(/\s+/g, ' '), 500) : '/' + kind;
  r.slash = { kind, at: Date.now(), notify: !!notify, pre: c.ctx?.used || 0 };
  if (kind === 'compact') pushEvent(c, { type: 'console_user', text });
  r.clampAt = 0; turnStart(c); setStatus(c, 'working');
  if (!writeProc(c, { type: 'user', message: { role: 'user', content: text } })) { r.slash = null; turnEnd(c); setStatus(c, 'error'); throw new Error('seat process is not accepting input, try again'); }
}
// The slash command's own `result` arrived: numbers are already folded in (applyCtx); tell Telegram how a compaction went when it was asked from there.
function slashDone(c, ev, slash) {
  const r = R(c); r.slash = null; r.compacting = false;
  if (slash?.kind === 'compact' && slash.notify) {
    const m = slash.boundary, v = ctxView(c), k = (n) => (n >= 1000 ? Math.round(n / 100) / 10 + 'k' : String(n));
    tg.send(m ? `🗜️ <b>${esc(c.seat)}</b> · <i>${esc(clipChars(c.title, 40))}</i> · Compact: ${k(m.pre_tokens)} ← ${k(m.post_tokens)}${v?.pct != null ? ` (🧠 ${Math.round(v.pct)}%)` : ''}`
      : `⚠️ <b>${esc(c.seat)}</b> · <i>${esc(clipChars(c.title, 40))}</i> · Compact failed`).catch(notifyFailed);
  }
  broadcast({ conv: summary(c) });
}
async function tgCompact(convShort, instructions) {
  const c = Object.values(state.conversations).find((x) => x.id.startsWith(convShort));
  if (!c) throw new Error('conversation not found');
  await runSlash(c, 'compact', instructions, true);
  return 'Compacting…';
}

// "Finished" goes out when the turn ended AND no background work is left AND nothing happened for SETTLE_MS (a finishing background agent starts the next turn
// a moment later). A background task that never ends (a dev server) must not silence the notification for ever: after BG_GIVE_UP_MS it is announced anyway.
const SETTLE_MS = 6000, BG_GIVE_UP_MS = 30 * 60000;
function settleDone(c) {
  const r = R(c); if (!r.done || r.status !== 'idle') return;
  if (Date.now() - r.activityAt < SETTLE_MS) return;
  if (c.bg?.length && Date.now() - r.done.at < BG_GIVE_UP_MS) return;
  // Two turns finishing within the throttle window: the later one stays pending (re-checked every second) and goes out when the window has passed, it is never dropped.
  if (!doneThrottle.allow(c.id)) return;
  const { info } = r.done; r.done = null;
  console.log(`[done] ${new Date().toISOString().slice(11, 19)} conv=${c.id.slice(0, 8)} notify=sent`);
  // The turn's files follow as replies to the done-message, under the same rules as /api/file (outFiles in hardening.mjs).
  tg.notify('done', info, PHONE, info.ctxCompact ? tg.compactButton(c.id) : null).then((m) => { const f = m && !c.remote && outFiles(info.out, c, FILE_RULES);   /* a remote conversation's files are on the remote: never matched against this PC's */ return f?.length ? tg.sendFiles(m.message_id, f) : null; }).catch(notifyFailed);
}
// Once a second: announce settled conversations, and refresh the page when the 20 s "recent events" window of a conversation runs out.
setInterval(guard('tick', () => { for (const c of Object.values(state.conversations)) { if (staleTurns(c, R(c), Date.now(), CLAMP_MS)) { clearTurns(c); R(c).clampAt = 0; setStatus(c, 'idle'); console.log(`[turns] conv=${c.id.slice(0, 8)}: result seen, nothing since: pending-turn counter cleared`); } settleDone(c); if (effStatus(c) !== R(c).shown) broadcast({ conv: summary(c) }); } }), 1000).unref();
// A seat process can die between our check and the write (EPIPE): never throw from here, tell the caller (false) and the page (console_error).
function writeProc(c, obj) {
  const stdin = R(c).proc?.stdin;
  if (!stdin?.writable) { pushEvent(c, { type: 'console_error', text: 'seat process is not accepting input (it exited); send again to restart it' }); return false; }
  stdin.write(JSON.stringify(obj) + '\n');
  return true;
}

// Prepare the seat dir (junctions, settings, MCP merge) with the launcher's own code. It takes seconds, so it runs async and at most once per seat per
// boot (again when one of the things init makes is gone). A change in ~/.claude/settings.json reaches a seat at the next boot.
// The signature is NOT the dir's mtime: claude itself creates files in the seat dir all the time, which would defeat the cache.
const seatInit = new Map(); // seat -> { sig: which init products exist after the last init, pending: promise of a run in progress }
const INIT_PRODUCTS = ['agents', 'commands', 'hooks', 'plugins', 'projects', 'skills', 'CLAUDE.md', '.claude.json']; // junctions + files of Initialize-Seat in seat.ps1
async function initSeat(seat) {
  const dir = path.join(HOME, '.claude-seats', seat), sigOf = () => INIT_PRODUCTS.map((n) => (fs.existsSync(path.join(dir, n)) ? 1 : 0)).join('');
  const e = seatInit.get(seat) || {}; seatInit.set(seat, e);
  if (e.pending) return e.pending;
  if (e.sig && e.sig === sigOf() && !e.sig.includes('0')) return;
  // Under memory pressure powershell starts slowly: 120 s, and one retry after 2 s before the send fails. The log line tells a timeout (killed) from a real script error.
  // POSIX: seat.sh, the same steps with symlinks instead of junctions.
  const [initExe, initArgs] = WIN ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SEATS_DIR, 'seat.ps1'), seat, '-InitOnly']] : ['sh', [path.join(SEATS_DIR, 'seat.sh'), seat, '--init-only']];
  const runInit = () => new Promise((ok, no) => execFile(initExe, initArgs, { encoding: 'utf8', windowsHide: true, timeout: 120000, env: cleanEnv() }, // a server started from a Claude session must not hand its CLAUDE_* vars to seat.ps1 either
    (err, out, serr) => (err ? (console.log(`[init] seat ${seat} -InitOnly error killed=${err.killed} code=${err.code} signal=${err.signal}`), no(new Error((WIN ? 'seat.ps1 -InitOnly' : 'seat.sh --init-only') + ' failed: ' + String(serr || out || err.message).slice(0, 300)))) : ok())));
  e.pending = runInit().catch(() => new Promise((r) => setTimeout(r, 2000)).then(runInit));
  try { await e.pending; e.sig = sigOf(); console.log(`[init] seat ${seat} prepared`); } finally { e.pending = null; }
}
async function startProc(c) {
  const rem = ctlOf(c);   // a remote conversation: no seat dir to prepare, claude runs there under the remote's own login
  if (!rem) await initSeat(c.seat);
  else if (R(c).remoteKillFailed) throw new Error(`remote ${rem.name} unreachable: the previous host there could not be stopped; send again when it answers`);
  const configDir = rem ? `(remote ${rem.name}: its own login)` : path.join(HOME, '.claude-seats', c.seat);
  const ending = 'End every final reply with one last line that starts with "Summary:" — at most 3 short sentences: what was done, the result, and what (if anything) is needed from the user.';
  const role = rem ? `You are a Claude session on the remote machine '${rem.name}', driven from the user's Seat Console. ${ending}`
    : `You are the '${c.seat}' seat (${SEATS[c.seat].email}) in the user's multi-seat setup. Your area: ${SEATS[c.seat].role}. Prefer work in that area, but a task the user sends you explicitly is always yours to do. ${ending}`;
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...MODE_ARGS[c.mode],
    '--append-system-prompt', role, '--name', `seat:${c.seat}`];
  // First start pins the session id to the conversation id; every later start resumes it.
  if (c.started) args.push('--resume', c.sessionId); else args.push('--session-id', c.sessionId);
  if (c.model) args.push('--model', c.model);
  if (c.effort) args.push('--effort', c.effort === 'ultracode' ? 'max' : c.effort);
  // claude runs inside a detached host (hostlink.mjs / host.mjs); the host dies only with claude, never with this server. Its env is the clean env + this seat's config dir.
  c.spawnSessionId = c.sessionId; // what this claude's command line will carry (--session-id / --resume)
  // Remote: the host starts there (rhost.spawnRemoteHost); the local copy of its record (+ `remote`) is what hostInfoOf / reattach find after a console restart.
  const info = rem ? await rseq(c, () => rhost.spawnRemoteHost(rem, { id: c.id, args, cwd: c.cwd, token: crypto.randomBytes(24).toString('hex') })).then((i) => {
    remoteStatus(rem.name, null); fs.mkdirSync(path.dirname(hostBase(c)), { recursive: true }); fs.writeFileSync(hostPaths(hostBase(c)).info, JSON.stringify({ ...i, remote: rem.name })); return i;
  }, (e) => { if (e.down) remoteStatus(rem.name, e.message); throw e; })
    : await spawnHost({ base: hostBase(c), script: HOST_JS, exe: CLAUDE_CMD[0], args: [...CLAUDE_CMD.slice(1), ...args], cwd: c.cwd, env: { ...cleanEnv(), CLAUDE_CONFIG_DIR: configDir }, token: crypto.randomBytes(24).toString('hex') });
  c.spawnedAt = Date.now(); // host + claude were created before this instant: the creation-time fallback of the guarded kills (procid.mjs) needs it when the command-line lookup fails
  c.hostOff = 0; c.hostGen = (c.hostGen || 0) + 1; // a new host-out file starts at byte 0: offsets logged by the previous host no longer apply
  const r = R(c); r.procCost = 0; c.started = true; r.silent = false; r.lineFailed = false; r.compacted = false; r.appendFailed = false; saveState(); // a new host-out file: nothing from the old one applies
  attach(c, info, 0);
  console.log(`[spawn] seat=${c.seat} conv=${c.id.slice(0, 8)} pid=${info.claudePid} host=${info.pid} mode=${c.mode} CLAUDE_CONFIG_DIR=${configDir} cwd=${c.cwd} model=${c.model || 'default'}`);
  pushEvent(c, { type: 'console_spawn', pid: info.claudePid, configDir, cwd: c.cwd, model: c.model || null, mode: c.mode });
}

// Connect this server to a conversation's host and make the link its `proc`. `proc.stdin` keeps the shape writeProc() already uses.
let offTimer = null; // the replay offset is saved at most once a second; the events in the log carry their own `hoff`, so nothing is lost or doubled if a save is missed
function attach(c, info, from, { reattach = false } = {}) {
  const r = R(c);
  const onLine = lineHandler({ c, r, handle: (line, end) => handleLine(c, line, end), onAdvance: () => { offTimer ??= setTimeout(() => { offTimer = null; saveState(); }, 1000); },
    sizeOf: () => { try { return fs.statSync(hostPaths(hostBase(c)).out).size; } catch { return 0; } },
    onError: (e, line) => console.log(`[line] handleLine threw conv=${c.id.slice(0, 8)} (${String(line).slice(0, 80)}): ${e?.stack || e}`) }); // the replay offset stays before the failing line
  const rem = ctlOf(c);
  const link = connectHost(info, from, {
    onLine,
    onExit: (code, err) => { if (r.proc === p) procGone(c, code, err); },
    // Remote: a dropped link is first of all a network event, the host may well still run there: ask before calling it lost (remoteDropped).
    onClose: () => { if (r.proc === p) (rem ? remoteDropped(c) : hostLost(c)); },
    ...(rem ? { socket: () => rhost.sshSocket(rem, info.port), timeout: 25000 } : {}),   // ssh's own connect timeout is 10 s
  });
  const p = { pid: info.claudePid, hostPid: info.pid, link, stdin: { get writable() { return link.writable; }, write: (s) => link.write(s) } };
  r.proc = p; r.buf = '';
  // Handshake failed or timed out. A host WE just spawned that cannot be reached is lost; a host being reattached after a console restart may only be slow:
  // the caller retries and, if it stays silent, leaves it running (reattachAll).
  link.ready.catch(() => { if (!reattach && r.proc === p) hostLost(c); });
  return p;
}
// claude exited (normal end of the process, or a crash of claude itself). Same behaviour as when it was a direct child.
function procGone(c, code, err) {
  const r = R(c); r.proc?.link.close();
  c.baseCost = (c.baseCost || 0) + r.procCost; r.procCost = 0; r.proc = null; r.perms.clear(); c.bg = []; r.done = null; r.slash = null; r.compacting = false; // no process left to send a pending "finished" later; a stale one would keep the conversation busy
  cleanHostFiles(c);
  r.clampAt = 0;
  if (c.working) { clearTurns(c); const text = `process exited (${code}) ${String(err).trim()}`; pushEvent(c, { type: 'console_error', text }); setStatus(c, 'error'); tg.notify('error', { seat: c.seat, title: c.title, text, convId: c.id }, PHONE).catch(notifyFailed); }
  else setStatus(c, 'stopped');
}
// hostLost (the host vanished while we were connected: `interrupted`, recover works) lives in lifecycle.mjs.

// ---- server start: reattach to hosts that survived the previous server, and clean up the ones nobody owns ----
function rebuildPerms(c) { // approvals still open = logged console_perm without a console_perm_done
  const r = R(c); r.perms.clear();
  const done = new Set(eventsOf(c).filter((e) => e.type === 'console_perm_done').map((e) => e.requestId));
  for (const e of eventsOf(c)) if (e.type === 'console_perm' && !done.has(e.requestId)) r.perms.set(e.requestId, { input: e.input, tool: e.tool });
}
// A host that is alive but slow to answer must not be killed: retry the handshake, and only a host that is really gone (or refuses every try for good) is given up on.
async function tryAttach(c, info, from, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { const p = attach(c, info, from, { reattach: true }); await p.link.ready; return true; }
    catch { R(c).proc?.link.close(); R(c).proc = null; if ((await hostAlive(c, info)) === false) return false; await new Promise((r) => setTimeout(r, 500)); }
  }
  return false;
}
// Everything a conversation needs once its host answers again: approvals and background work come from the log, the status from what is open.
function adopt(c, info) {
  const r = R(c); r.silent = false; r.silentGaveUp = false;
  rebuildPerms(c);
  c.bg = eventsOf(c).reduce((l, e) => e.type === 'console_spawn' ? [] : applyBackground(l, e), []); // the logged events are the truth about what still runs (also covers a state.json from before c.bg existed)
  setStatus(c, r.perms.size ? 'waiting' : c.working ? 'working' : 'idle');
  console.log(`[host] reattached conv=${c.id.slice(0, 8)} host=${info.pid} status=${r.status}`);
}
// A host that stayed silent through every handshake try but is still running: the conversation shows `interrupted` (the turn's fate is unknown), the host is left alone,
// and we keep knocking every 30 s; the day it answers, the conversation is adopted again. ensureProc refuses to start a second claude beside it meanwhile.
function reconnectLater(c, info, left = 20) {
  const t = setTimeout(async () => {
    const r = R(c);
    if (r.proc || r.starting || r.stopping || !hasKey(state.conversations, c.id) || !r.silent) return; // stopped, deleted or restarted meanwhile (killProc/killSilent clear `silent`)
    const alive = await hostAlive(c, info);   // remote: null = ssh failed, keep knocking
    if (alive === false) { r.silent = false; if (c.remote) reattachOne(c); return; }   // a remote host that is gone: replay its last output there and clean up
    const from = Math.max(c.hostOff || 0, lastHoff(eventsOf(c), c.hostGen));
    if (alive && await tryAttach(c, info, from, 1)) adopt(c, info); else if (left > 1) reconnectLater(c, info, left - 1); else r.silentGaveUp = true; // gave up: the next send may kill this host and start fresh
  }, 30000); t.unref();
}
async function reattachAll() {
  // 1. hosts of conversations that no longer exist (deleted while the server was down, state lost): tell them to die, drop their files.
  for (const seat of Object.keys(SEATS)) {
    const dir = path.join(DATA, 'logs', seat); let names = []; try { names = fs.readdirSync(dir); } catch { continue; }
    for (const f of names.filter((n) => n.endsWith('.host.json'))) {
      const id = f.slice(0, -'.host.json'.length);
      if (hasKey(state.conversations, id)) continue;
      const info = readJson(path.join(dir, f)), killed = info ? await stopHost(info) : false;
      await new Promise((r) => setTimeout(r, 400)); // the dying host may still write its exit file
      for (const x of names.filter((n) => n.startsWith(id + '.host'))) fs.rmSync(path.join(dir, x), { force: true });
      console.log(`[host] stale host for deleted conversation ${id.slice(0, 8)}: ${killed ? 'killed' : 'was already gone'}`);
    }
  }
  // 2. conversations with a host record: read what the host wrote while we were away, then reconnect if it still runs.
  // In parallel: each handshake can take seconds (3 tries x 5 s on a slow host) and the page is blocked (503) until all are done. The conversations are independent.
  // Remote conversations are NOT awaited here (reattachRemotes, after `ready`): an unreachable remote must never hold up the start.
  await Promise.all(Object.values(state.conversations).filter((c) => !c.remote).map(reattachOne));
}
const reattachRemotes = () => { for (const c of Object.values(state.conversations)) if (c.remote) reattachOne(c); };
// The link of a remote conversation dropped without the host saying claude exited: a network event first of all. reattachOne asks the remote: still running ->
// reconnect (the host replays what was missed); unreachable -> `unreachable since`, knocking every 30 s; gone -> its last output is read there, then cleaned up.
function remoteDropped(c) {
  const r = R(c), p = r.proc; r.proc = null; p.link.close(); r.perms.clear(); r.silent = true;   // silent: no second claude is started beside it meanwhile
  console.log(`[host] conv=${c.id.slice(0, 8)}: link to remote ${c.remote} dropped, checking the host there`);
  reattachOne(c);
}
// One conversation with a host record (start, or a remote link that dropped). Never rejects.
async function reattachOne(c) { try {
    const info = hostInfoOf(c); if (!info) return;
    await loadLogAsync(c);   // before the sync replay below: its eventsOf() then finds the events loaded, the start never blocks on a full log read
    const r = R(c), p = hostPaths(hostBase(c)), rem = ctlOf(c);
    let from = Math.max(c.hostOff || 0, lastHoff(eventsOf(c), c.hostGen));
    r.procCost = 0;
    // Remote: asked over ssh first (true / false / null = unreachable). A live remote host replays from `from` itself when we connect; a gone one is read from its file there.
    const reach = rem ? await hostAlive(c, info) : true;
    // The output file stays readable when the host is gone. A line that throws is logged and skipped: it must not abort the start of every conversation, and c.hostOff stays before it.
    for (const x of !rem ? readOutFrom(p.out, from).lines : reach === false ? await rhost.remoteOutFrom(rem, c.id, from) : []) { from = x.end; try { handleLine(c, x.line, x.end); if (!r.lineFailed) c.hostOff = x.end; } catch (e) { r.lineFailed = true; console.log(`[line] replay: handleLine threw conv=${c.id.slice(0, 8)}: ${e?.stack || e}`); } }
    // No command-line check here: a failed WMI query under start-up load made a LIVE host look dead (files deleted, claude orphaned). A reused pid cannot answer the token handshake in tryAttach.
    // A host spawned before this PC's last boot cannot be alive: after a reboot Windows reuses its pid for something else (2026-10-15: unsecapp.exe),
    // and the console waited forever on a host that would never answer. Such a conversation is simply interrupted, so Resume starts a fresh host.
    // (The remote's uptime is not this PC's: the boot check is local only; remotely the command-line check in hostAlive is the pid-reuse guard.)
    const running = rem ? reach !== false : pidAlive(info.pid) && !(c.spawnedAt && c.spawnedAt < Date.now() - os.uptime() * 1000);
    if (running && reach && await tryAttach(c, info, from)) adopt(c, info);
    else if (running) {
      c.bg = []; r.silent = true; // counts against the seat's cap and is killed by Stop/Delete/eviction (killSilent) - see lifecycle.mjs
      if (c.working) { clearTurns(c); c.interrupted = true; pushEvent(c, { type: 'console_error', text: reach === null ? `remote ${c.remote} is unreachable: the turn is shown as interrupted; the console keeps trying to reconnect (the host keeps running there)` : 'seat host is running but did not answer: the turn is shown as interrupted; the console keeps trying to reconnect' }); }
      setStatus(c, c.interrupted ? 'interrupted' : 'stopped');
      console.log(`[host] conv=${c.id.slice(0, 8)}: host ${info.pid} ${reach === null ? 'not reachable (remote ' + c.remote + ')' : 'alive but silent'}, left running (retrying every 30 s)`);
      reconnectLater(c, info);
    } else {
      const ex = readJson(p.exit); await killClaudePid(info.claudePid, c); cleanHostFiles(c); c.bg = []; r.silent = false;
      if (c.working) { clearTurns(c); c.interrupted = true; pushEvent(c, { type: 'console_error', text: ex ? `process exited (${ex.code}) ${String(ex.err || '').trim()}` : 'seat host is gone: the turn was interrupted, use recover to continue it' }); setStatus(c, 'interrupted'); }
      else setStatus(c, R(c).status === 'interrupted' ? 'interrupted' : 'stopped');
      console.log(`[host] conv=${c.id.slice(0, 8)}: host not running (${ex ? 'claude exited ' + ex.code : 'gone'})`);
    }
  } catch (e) { // one bad conversation must never abort the start of the others
    console.log(`[reattach] conv=${String(c?.id).slice(0, 8)} failed: ${e?.stack || e}`);
    try { c.working = false; c.turns = 0; c.interrupted = true; setStatus(c, 'interrupted'); } catch (e2) { console.log(`[reattach] could not mark it interrupted: ${e2.message}`); }
    const info = c.remote && hostInfoOf(c); if (info) { R(c).silent = true; reconnectLater(c, info); }   // e.g. ssh failed half-way: its host may still run there, keep asking
  } }

// Idle conversations only wait for the next message: after IDLE_REAP_MS without any event (and no background work, no open approval) the process is stopped
// (status `stopped`; the next send resumes the same session). The cap of MAX_PER_SEAT live processes is made of busy conversations only: an idle one is evicted for a new start.
const IDLE_REAP_MS = +arg('reap-ms') || 5 * 60000; // 5 min since 2026-10-15: idle claude processes hold ~0.5 GB each; was 15 min
async function reapIdle() {
  for (const c of Object.values(state.conversations)) {
    if (!R(c).proc || isBusy(c) || Date.now() - R(c).lastAt < IDLE_REAP_MS) continue;
    try { await stopIdle(c, `idle for ${Math.round((Date.now() - R(c).lastAt) / 60000)} min, process stopped`); } catch (e) { console.log('[idle] ' + e.message); }
  }
}
function newConversation(seat, { cwd, model, effort, mode }) {
  const id = crypto.randomUUID();
  const c = state.conversations[id] = { id, seat, sessionId: id, cwd, mode: mode || 'auto', model: model || null, effort: effort || null, title: 'New conversation', cost: 0, baseCost: 0, started: false, working: false, updatedAt: Date.now() };
  return c;
}

// ---- image attachments: magic bytes decide the type, never the extension ----
const IMG_MAX = 15 * 1024 * 1024;
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
function sniffImage(b) {
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'gif';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}
let imgSeq = 0;
function storeImage(dirName, buf, draftId) {
  const ext = sniffImage(buf); if (!ext) throw new Error('not a png/jpg/gif/webp image');
  if (buf.length > IMG_MAX) throw new Error('image over 15 MB');
  fs.mkdirSync(path.join(UPLOADS, dirName), { recursive: true });
  const name = `${draftId ? draftId + '-' : ''}${Date.now()}-${++imgSeq}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS, dirName, name), buf);
  return name;
}
// Browser uploads arrive before a new conversation exists, so they wait in _staged and move into the conversation's folder at send.
// A staged name is <draftId>-<ts>-<n>.<ext>; the draftId is random per draft in the page, so one draft can never claim another's files.
function claimImages(c, ids, buffers, draftId) {
  const names = [];
  for (const id of ids || []) {
    const m = /^(_staged|[0-9a-f-]{36})\/(?:([0-9a-f]{16})-)?(\d+-\d+\.(?:png|jpg|gif|webp))$/.exec(String(id));
    const staged = m && m[1] === '_staged';
    if (!m || (staged ? !m[2] || m[2] !== draftId : m[1] !== c.id || m[2])) throw new Error('bad image id');
    const from = path.join(UPLOADS, m[1], (m[2] ? m[2] + '-' : '') + m[3]); if (!fs.existsSync(from)) throw new Error('image gone: ' + m[3]);
    if (staged) { fs.mkdirSync(path.join(UPLOADS, c.id), { recursive: true }); fs.renameSync(from, path.join(UPLOADS, c.id, m[3])); }
    names.push(m[3]);
  }
  for (const buf of buffers || []) names.push(storeImage(c.id, buf));
  return names;
}
// ---- any other file (pdf, zip, txt, ...): stored as is, the message names its path so claude opens it with its own tools ----
// 50 MB: the body is held in memory while it arrives, so the cap bounds RAM; Telegram's own bot download limit is 20 MB, phone documents fit far below.
const FILE_MAX = 50 * 1024 * 1024;
// The client's name is never trusted: last path part only, NFC, letters/marks/digits (any script, so Hebrew stays) and ` ._()+,-`, no `..`, no leading/trailing
// dot or space, at most 80 characters before a short extension. The stored name is `<ts>-<n>-<safe>`, so a reserved Windows name (con.txt) can never be the whole name.
function safeName(raw) {
  const s = String(raw || '').split(/[\\/]/).pop().normalize('NFC').replace(/[^\p{L}\p{M}\p{N} ._()+,-]/gu, '_').replace(/\.{2,}/g, '.').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '');
  const ext = /\.[\p{L}\p{N}]{1,10}$/u.exec(s)?.[0] || '', stem = [...s.slice(0, s.length - ext.length)].slice(0, 80).join('').replace(/[ .]+$/, '');
  return (stem || 'file') + ext;
}
const fileLabel = (stored) => stored.replace(/^\d+-\d+-/, '');
function storeFile(dirName, buf, name, draftId) {
  if (buf.length > FILE_MAX) throw new Error('file over 50 MB');
  fs.mkdirSync(path.join(UPLOADS, dirName), { recursive: true });
  const stored = `${draftId ? draftId + '-' : ''}${Date.now()}-${++imgSeq}-${safeName(name)}`;
  fs.writeFileSync(path.join(UPLOADS, dirName, stored), buf);
  return stored;
}
// Same claim rules as images (staged files only for their own draft). Every id is checked and, for a remote conversation, copied there (rem) BEFORE any
// staged file is moved: a refused id or a failed copy leaves the draft's files where they were, so a retry of the same send still finds them.
// -> [{ stored, label, size, path }]: path = what claude is told (the remote path for a remote conversation).
async function claimFiles(c, ids, buffers, draftId, rem) {
  const got = [];
  for (const id of ids || []) {
    const m = /^(_staged|[0-9a-f-]{36})\/(?:([0-9a-f]{16})-)?(\d+-\d+-[^\\/]+)$/.exec(String(id));
    const staged = m && m[1] === '_staged';
    if (!m || safeName(fileLabel(m[3])) !== fileLabel(m[3]) || (staged ? !m[2] || m[2] !== draftId : m[1] !== c.id || m[2])) throw new Error('bad file id');
    const from = path.join(UPLOADS, m[1], (m[2] ? m[2] + '-' : '') + m[3]); if (!fs.existsSync(from)) throw new Error('file gone: ' + fileLabel(m[3]));
    got.push({ from, stored: m[3], staged });
  }
  for (const f of buffers || []) { const stored = storeFile(c.id, f.data, f.name); got.push({ from: path.join(UPLOADS, c.id, stored), stored }); }
  const out = [];
  // A remote claude cannot read this PC: each file is copied to ~/.seat-console/uploads/<conv>/ there and the message names the REMOTE path.
  for (const g of got) out.push({ stored: g.stored, label: fileLabel(g.stored), size: fs.statSync(g.from).size, path: rem ? await rhost.putUpload(rem, c.id, g.stored, fs.readFileSync(g.from)) : path.join(UPLOADS, c.id, g.stored) });
  for (const g of got.filter((x) => x.staged)) { fs.mkdirSync(path.join(UPLOADS, c.id), { recursive: true }); fs.renameSync(g.from, path.join(UPLOADS, c.id, g.stored)); }
  return out;
}
const sizeText = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
// Telegram files arrive as bytes: an image (magic bytes, within the image cap) keeps the image path, anything else is a file.
const asImage = (buf) => !!sniffImage(buf) && buf.length <= IMG_MAX;

// Staged files nobody claimed (draft abandoned) are swept after an hour.
function sweepStaged() {
  const dir = path.join(UPLOADS, '_staged');
  try { for (const f of fs.readdirSync(dir)) { const fp = path.join(dir, f); if (Date.now() - fs.statSync(fp).mtimeMs > 3600e3) fs.rmSync(fp, { force: true }); } }
  catch (e) { if (e.code !== 'ENOENT') console.log('[sweep] ' + e.message); }
}
const imageBlock = (c, name) => ({ type: 'image', source: { type: 'base64', media_type: IMG_MIME[path.extname(name).slice(1)], data: fs.readFileSync(path.join(UPLOADS, c.id, name)).toString('base64') } });
function binBody(req, max) {
  return new Promise((ok, no) => {
    let n = 0; const chunks = [];
    req.on('data', (x) => { n += x.length; if (n > max) { no(new Error(`over ${max / 1024 / 1024} MB`)); req.destroy(); } else chunks.push(x); });
    req.on('end', () => ok(Buffer.concat(chunks)));
  });
}

async function send(b) {
  let c = b.conversationId && convOf(b.conversationId);
  if (b.conversationId && !c) throw new Error('unknown conversation');
  const rem = c ? ctlOf(c) : ctlByGroup(b.seat);   // a new conversation on a control remote: the page sends its group name ("remote: <name>")
  const seat = c ? c.seat : rem ? 'remote-' + rem.name : b.seat;
  if (!rem && !hasKey(SEATS, seat)) throw new Error('unknown seat');
  if (b.mode && !hasKey(MODE_ARGS, b.mode)) throw new Error('unknown mode');
  const cwd = b.cwd || c?.cwd || state.cwds[seat] || (rem ? await rhost.remoteHome(rem) : DEFAULT_CWD);
  // A remote folder only has to be an absolute path here: it is checked THERE, a missing one fails the host start with claude's own error.
  if (rem ? !/^\/[^\0\r\n]*$/.test(cwd) : !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('cwd does not exist: ' + cwd);
  if (c && R(c).slash && Date.now() - R(c).slash.at < 600000) throw new Error('/' + R(c).slash.kind + ' is running on this conversation: send again when it has finished.');
  const created = !c;
  if (!c) { c = newConversation(seat, { cwd, model: b.model, effort: b.effort, mode: b.mode }); if (rem) c.remote = rem.name; }
  // Anything below failing (spawn, bad image id, dead stdin) must not leave a ghost conversation behind that THIS call created.
  try {
  // cwd, model and effort are fixed per process: changing one restarts it on the same session. Mode never changes after start.
  const model = b.model || c.model;
  if (b.effort && !EFFORTS.includes(b.effort)) throw new Error('unknown effort');
  const effort = b.effort || c.effort;
  // Restarting the process ends its running turn: an explicit change is only taken while the conversation is idle, never silently mid-turn.
  if (R(c).proc && (c.cwd !== cwd || model !== c.model || effort !== c.effort)) {
    if (c.working || c.bg?.length || R(c).perms.size) throw new Error('This conversation is running: model, effort and folder can only be changed while it is idle. Wait for it to finish (or stop it), then send again.');
    await killProc(c);
  }
  c.cwd = cwd; c.model = model || null; c.effort = effort || null;
  if (created) state.cwds[seat] = cwd; // the seat's default folder follows NEW conversations only, not every message into an old one
  await ensureProc(c);
  const images = claimImages(c, b.images, b.imageBuffers, b.draftId);
  const files = await claimFiles(c, b.files, b.fileBuffers, b.draftId, rem);
  autoTitle(c, b.title || clipChars(b.text.trim().replace(/\s+/g, ' '), 60));   // never over a title the user set (rename)
  if (!b.auto) answered(c);   // the user wrote: the needs-answer mark goes, the automatic pins made before this message are released. b.auto = an automated sender (recover, routine, send.ps1): not an answer
  pushEvent(c, { type: 'console_user', text: b.text, ...(images.length ? { images } : {}), ...(files.length ? { files: files.map((f) => ({ name: f.stored, label: f.label, size: f.size })) } : {}) });
  const r = R(c); if (!c.turns) { r.turnFiles.clear(); r.turnWrites.clear(); r.turnAsks = []; r.turnAt = Date.now() - 2000; } // a second message mid-turn keeps the files the running turn already wrote; turnAt (2 s mtime slack): reply-named files count from here
  r.clampAt = 0; turnStart(c); setStatus(c, r.perms.size ? 'waiting' : 'working'); // clampAt of the previous result must not clamp this new turn before its first event
  const text = (c.effort === 'ultracode' ? 'ultracode\n\n' + b.text : b.text) + files.map((f) => `\nAttached file: ${f.path} (${f.label}, ${sizeText(f.size)})`).join('');
  if (!writeProc(c, { type: 'user', message: { role: 'user', content: images.length ? [{ type: 'text', text }, ...images.map((n) => imageBlock(c, n))] : text } })) {
    turnEnd(c); setStatus(c, c.turns ? 'working' : 'error'); throw new Error('seat process is not accepting input, try again');
  }
  return c;
  } catch (e) {
    if (created) { await killProc(c); delete state.conversations[c.id]; rt.delete(c.id); saveState(); fs.rmSync(logFile(c), { force: true }); fs.rmSync(path.join(UPLOADS, c.id), { recursive: true, force: true }); broadcast({ removed: c.id }); }
    throw e;
  }
}

function decide(c, requestId, allow) {
  const r = R(c), p = r.perms.get(requestId);
  if (!p || !r.proc) throw new Error('no such pending request');
  r.perms.delete(requestId);
  if (!writeProc(c, { type: 'control_response', response: { subtype: 'success', request_id: requestId,
    response: allow ? { behavior: 'allow', updatedInput: p.input } : { behavior: 'deny', message: 'Denied by the user in Seat Console' } } })) throw new Error('seat process is not running, the approval could not be delivered');
  pushEvent(c, { type: 'console_perm_done', requestId, allow });
  setStatus(c, r.perms.size ? 'waiting' : 'working');
}

// ---- telegram: shares decide() with POST /api/permission, and routes replies through send() ----
const doneThrottle = new Throttle(60000);
async function tgDecision(convShort, requestId, allow) {
  const c = Object.values(state.conversations).find((x) => x.id.startsWith(convShort));
  if (!c) throw new Error('conversation not found');
  decide(c, requestId, allow);
  return allow ? 'Allowed' : 'Denied';
}
async function tgReply(convId, { text, images, files = [] }) {
  const c = convOf(convId); if (!c) throw new Error('that conversation was deleted');
  const all = [...images, ...files];   // a photo sent "as a file" is still an image
  await send({ conversationId: c.id, text, imageBuffers: all.filter((x) => asImage(x.data)).map((x) => x.data), fileBuffers: all.filter((x) => !asImage(x.data)).map((x) => ({ data: x.data, name: x.name })) });
  return sentLine(c.seat, c.title);
}
tgReply.acceptsImages = true;
// A new task from the bot: send() with no cwd uses that seat's last cwd (or the default).
async function tgNewTask({ seat, model, mode, text }) { await send({ seat, text, model: model || undefined, mode }); }
const tgList = async () => Object.values(state.conversations).filter((c) => !c.archived).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8).map((c) => ({ id: c.id, seat: c.seat, title: c.title, status: effStatus(c) }));
// Digest input: per seat, its non-archived conversations touched in the last 24 h + the last result text + the 5 h usage window.
// A window whose resetsAt has passed counts as 0 % until a new event arrives (the page shows it as "reset").
const fiveHour = (name) => {
  const w = state.usage[name]?.windows?.five_hour; if (!w || typeof w.resetsAt !== 'number') return null;
  const expired = w.resetsAt * 1000 <= Date.now();
  return { util: expired ? 0 : w.utilization, resetsAt: w.resetsAt * 1000, expired };
};
const quotaOf = (name) => { const q = fiveHour(name); return q ? { usage: q.util, resetsAt: q.resetsAt } : {}; };
const tgUsage = async () => Object.fromEntries(Object.keys(SEATS).map((n) => [n, fiveHour(n)?.util]).filter(([, u]) => u != null));
// 90 % warning, ONE per seat per window; names the seat with the most quota left.
function quotaWatch(seat) {
  const q = fiveHour(seat); if (!q || q.expired || !quotaWarnDue(state.quotaWarned, seat, q.util, q.resetsAt / 1000)) return;
  saveState();
  const alt = Object.keys(SEATS).filter((n) => n !== seat).map((name) => ({ name, util: fiveHour(name)?.util })).filter((x) => x.util != null).sort((a, b) => a.util - b.util)[0] || null;
  tg.send(buildQuotaWarning({ seat, util: q.util, resetsAt: q.resetsAt, alt })).catch(notifyFailed);
}
const tgStatus = async () => ({ seats: Object.keys(SEATS).map((name) => {
  return { name, ...quotaOf(name),
    convs: Object.values(state.conversations).filter((c) => c.seat === name && !c.archived && Date.now() - c.updatedAt < 24 * 3600 * 1000)
      .map((c) => ({ id: c.id, title: c.title, status: effStatus(c), bg: c.bg?.length || 0, ctxPct: ctxNote(c).ctxPct, updatedAt: c.updatedAt, result: eventsOf(c).findLast((e) => e.type === 'result')?.result || '' })) };
}) });
// Crash recovery from Telegram: the same "continue" text recover.ps1 sends (tasks/recover-continue.txt, approved by the user).
const tgRecoverList = async () => interruptedConvs().map((c) => ({ id: c.id, seat: c.seat, title: c.title, updatedAt: c.updatedAt }));
async function tgRecover(which) { // 'all' or a conversation id prefix; a conversation that is no longer interrupted is skipped, so a second tap does nothing
  const text = fs.readFileSync(path.join(SEATS_DIR, 'tasks', 'recover-continue.txt'), 'utf8').trim();
  const out = { resumed: [], failed: [] };
  for (const c of interruptedConvs().filter((x) => which === 'all' || x.id.startsWith(which))) {
    try { await send({ conversationId: c.id, text, auto: true }); out.resumed.push({ seat: c.seat, title: c.title }); } catch (e) { out.failed.push({ seat: c.seat, title: c.title, error: e.message }); }
  }
  return out;
}
const tgFind = (short) => { const c = Object.values(state.conversations).find((x) => x.id.startsWith(short)); return c && { id: c.id, seat: c.seat, title: c.title }; };
const notifyFailed = (e) => console.log('telegram notify failed: ' + (e?.message || e));
const tg = createTelegram({ cfgFile: TELEGRAM_FILE, linkCodeFile: path.join(DATA, 'telegram-link-code.txt'), onNewTask: tgNewTask, onList: tgList, onStatus: tgStatus, onDigest: async (kind) => digestMessage(Date.now(), kind), onUsage: tgUsage, onRecoverList: tgRecoverList, onRecover: tgRecover, onRoutineTap: (d) => routines.tap(d), onRoutineList: () => routines.listMessage(), findConv: tgFind, seats: Object.keys(SEATS), phoneBase: () => PHONE, onDecision: tgDecision, onReply: tgReply, onCompact: tgCompact, msgMap: state.telegramMsgs, onMapChange: saveState, getOffset: () => offsetFor(state, tg.readCfg()?.botToken), setOffset: (o) => { offsetFor(state, tg.readCfg()?.botToken); state.tgOffset = o; saveState(); } }); // offsetFor first: it records which bot this offset belongs to

// ---- routines: recurring prompts that only ASK at their due time (Telegram buttons) and start on the user's tap, never unattended (routines.mjs) ----
const routines = createRoutines({ file: ROUTINES_FILE, state, save: saveState, deps: {
  ask: (text, rows) => tg.send(text, rows), edit: (mid, text, rows) => tg.edit(mid, text, rows), telegramOn: () => !!tg.readCfg()?.chatId,
  start: async ({ routine, seat, title, text }) => (await send({ seat, text, title, cwd: routine.cwd, model: routine.model, effort: routine.effort, mode: routine.mode, auto: true })).id,
  seatLoad: (seat) => ({ alive: busyCount(seat), max: MAX_PER_SEAT, usage: fiveHour(seat)?.util ?? null }),
  seatNames: () => Object.keys(SEATS), base: () => PHONE, log: (l) => console.log(l) } });

// ---- digests (digest.mjs): one message at 08:00 and one at 21:00 Vienna, /digest and /evening on demand, GET /api/digest[?kind=evening] for the text without sending ----
function tailOf(file, bytes) {
  try { const size = fs.statSync(file).size, n = Math.min(size, bytes), fd = fs.openSync(file, 'r'), buf = Buffer.alloc(n); try { fs.readSync(fd, buf, 0, n, size - n); } finally { fs.closeSync(fd); } return buf.toString('utf8'); } catch { return ''; }
}
// kind 'morning': since 20:00, today's routines. 'evening': since 08:00, tomorrow's routines (+24 h from the slot, so a late one sent at 07:00 lists that same day). slot = dueSlot() result for the late/skipped lines.
function digestMessage(now = Date.now(), kind = 'morning', slot = null) {
  const evening = kind === 'evening', { since, routinesAt } = digestRefs(kind, now, slot), sinceLabel = viennaHm(since);
  const convs = Object.values(state.conversations).filter((c) => !c.archived).map((c) => {
    const r = R(c), status = effStatus(c), live = status === 'working' || status === 'waiting';
    // only conversations touched since 20:00 (evening: 08:00) have their log read for a result (a stopped 66 MB log is not loaded for nothing)
    const res = (status === 'idle' || status === 'stopped') && c.updatedAt >= since ? eventsOf(c).findLast((e) => e.type === 'result' && !e.local_command) : null;
    return { id: c.id, seat: c.seat, title: c.title, status, lastAt: live ? (eventsOf(c).at(-1)?.ts ?? c.updatedAt) : 0, resultAt: res?.ts ?? 0, result: res?.result || '' };
  });
  const k = classify(convs, now, since);
  return (evening ? buildEveningDigest : buildMorningDigest)({ seats: Object.keys(SEATS).map((name) => { const q = quotaOf(name); return { name, usage: q.usage ?? null, resetsAt: q.resetsAt }; }),
    ...k, errors: scanLog(tailOf(path.join(DATA, 'server.log'), 2e6), since), sinceLabel, routines: digestRoutines(routines.view(), routinesAt), slot }, now, PHONE);
}
// Each slot (08:00 / 21:00) is sent once; one that passed while the server was off goes out at the next start or tick (dueSlot: only the latest, never one older).
// lastDigestFor / lastEveningFor are saved right after a delivered send, so a restart never sends twice.
// A send that delivered nothing (Telegram down, not linked) is retried at most every 10 min: the 30 s tick wrote ~240 "send failed" lines in the 2 h window.
let digestBusy = false, digestNextTry = 0;
const DIGEST_RETRY_MS = 10 * 60e3;
async function digestTick() {
  const now = Date.now(), slot = digestBusy || now < digestNextTry ? null : dueSlot(state, now); if (!slot) return;
  digestBusy = true;
  try { const d = digestMessage(now, slot.kind, slot), m = await tg.send(d.text, d.rows); if (m) { state[slot.kind === 'evening' ? 'lastEveningFor' : 'lastDigestFor'] = slot.ymd; saveState(); console.log(`[digest] ${slot.kind} sent for ${slot.ymd}${slot.late ? ' (late)' : ''} message_id=${m.message_id}`); } else digestNextTry = now + DIGEST_RETRY_MS; }
  catch (e) { digestNextTry = now + DIGEST_RETRY_MS; console.log('[digest] failed: ' + (e?.message || e)); } finally { digestBusy = false; }
}
// ---- log retention (retention.mjs): at start and daily at 04:00 Vienna ----
let retentionRunning = null;   // the start run and the 04:00 run must never compress the same files at once
const retentionRun = () => (retentionRunning ??= retentionPass().finally(() => { retentionRunning = null; }));
async function retentionPass() {
  const rep = await runRetention({ data: DATA, state, testDataDir: ISOLATED ? null : path.join(HERE, 'test-data'), log: (l) => console.log(l),
    busy: (c) => { const r = R(c); return !!(r.proc || r.starting || r.stopping || r.silent || r.perms.size || ['working', 'waiting', 'interrupted'].includes(r.status)); },
    onCompressed: (seat, id, from) => { const c = convOf(id); if (c && from.endsWith('.jsonl')) R(c).fromGz = true; } });
  state.lastRetentionFor = viennaYmd(Date.now()); saveState();
  // "left for later", not "skipped": the digest counts error words in server.log, and this daily line must not read as one (each real skip logs its own line).
  console.log(`[retention] ${rep.compressed.length} files compressed (saved ${rep.saved} bytes), ${rep.skipped.length} left for later, ${rep.orphanUploads.length} orphan upload folders and ${rep.testData.length} test-data entries removed`);
  return rep;
}

// ---- http ----
const body = (req) => new Promise((ok, no) => {
  let n = 0; const chunks = [];
  req.on('data', (x) => { n += x.length; if (n > 1e6) { no(new Error('body too large')); req.destroy(); } else chunks.push(x); });
  req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { no(e); } });
});
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
// Same, gzipped when the browser accepts it and the body is worth it (a phone over Tailscale pays per byte).
function sendZ(req, res, code, type, body) {
  const buf = Buffer.from(body), head = { 'Content-Type': type, 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  if (buf.length < 1024 || !/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { head['Content-Length'] = buf.length; res.writeHead(code, head); return res.end(buf); }
  zlib.gzip(buf, { level: 5 }, (e, z) => { if (e) { res.writeHead(500); return res.end(); } head['Content-Encoding'] = 'gzip'; head['Content-Length'] = z.length; res.writeHead(code, head); res.end(z); });
}
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/paths.js': ['paths.js', 'text/javascript; charset=utf-8'],
  // installable app (PWA): the manifest, its icons and the service worker must be same-origin for Chrome/Edge "Install app"
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'], '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/icon-192.png': ['icon-192.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'], '/icon-maskable-512.png': ['icon-maskable-512.png', 'image/png'], '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'] };
// ---- file previews: GET /api/file streams a file the UI found named in a message ----
const PROJECTS = DEFAULT_CWD;
const MIME = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', pdf: 'application/pdf', html: 'text/html; charset=utf-8', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', srt: 'text/plain; charset=utf-8', json: 'application/json; charset=utf-8' };
// This server's own folder holds token.txt and every chat log; the name filter catches secrets kept inside a project.
// The rules (allowed roots, whole directory names, loose file names) are in hardening.mjs: resolveIn / isDeniedPath. The Telegram file sender uses the same ones.
const FILE_RULES = { projects: PROJECTS, here: HERE, data: DATA, defaultCwd: DEFAULT_CWD, mime: MIME };
// An upload is served only through its own conversation's id; the name is matched against a strict pattern, never joined raw.
function uploadFile(name, c) {
  if (!c || !(/^\d+-\d+\.(?:png|jpg|gif|webp)$/.test(name || '') || (/^\d+-\d+-[^\\/]+$/.test(name) && safeName(fileLabel(name)) === fileLabel(name)))) return null;
  const f = path.join(UPLOADS, c.id, name); return fs.existsSync(f) ? f : null;
}
// A file named in a REMOTE conversation is fetched over ssh (rhost.remoteFile: under the conversation's folder after the remote realpath, at most 25 MB) and served
// from memory; the same name rules as here apply to the asked and to the real path (no denied names, no .claude, preview types only).
const okRemoteName = (f) => !isDeniedPath(f) && !/\.claude/i.test(f) && !!MIME[path.posix.extname(f).slice(1).toLowerCase()];
async function remoteFileOf(c, p) {
  if (!p || !okRemoteName(path.posix.resolve(c.cwd, p))) return 'forbidden';
  const got = await rhost.remoteFile(ctlOf(c), c.cwd, p);
  return got && typeof got === 'object' && !okRemoteName(got.real) ? 'forbidden' : got;
}
async function serveFile(req, res, url) {
  const conv = convOf(url.searchParams.get('conv'));
  let real, buf;
  if (conv?.remote && !url.searchParams.has('upload')) {
    let got; try { got = await remoteFileOf(conv, url.searchParams.get('path')); } catch (e) { return json(res, 502, { error: e.message }); }
    if (got === 'too large') return json(res, 413, { error: 'over 25 MB: open it on the server' });
    if (got && typeof got === 'object') ({ real, buf } = got); else real = got;
  } else real = url.searchParams.has('upload') ? uploadFile(url.searchParams.get('upload'), conv) : resolveIn(url.searchParams.get('path'), conv, FILE_RULES);
  if (real === 'forbidden') return json(res, 403, { error: 'not allowed' });
  if (!real) return json(res, 404, { error: 'no such file' });
  const size = buf ? buf.length : fs.statSync(real).size, type = MIME[path.extname(real).slice(1).toLowerCase()] || 'application/octet-stream';   // only an attached file can be of another type: it downloads
  const head = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  // An attached file of an unknown type, or an attached html/svg (it would run script inline), downloads instead of opening. RFC 5987: '()* encoded too.
  if (type === 'application/octet-stream' || (url.searchParams.has('upload') && /html|svg/.test(type))) head['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(fileLabel(path.basename(real))).replace(/['()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase())}`;
  // html/svg run script: a sandbox CSP without allow-same-origin gives them an opaque origin, so they cannot reach this page's token.
  if (/html|svg/.test(type)) head['Content-Security-Policy'] = 'sandbox allow-scripts';
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0, end = size - 1, code = 200;
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = +m[1]; if (m[2]) end = Math.min(+m[2], size - 1); } else { start = Math.max(0, size - +m[2]); }
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    code = 206; head['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  head['Content-Length'] = size ? end - start + 1 : 0;
  res.writeHead(code, head);
  if (req.method === 'HEAD' || !size) return res.end();
  if (buf) return res.end(buf.subarray(start, end + 1));
  fs.createReadStream(real, { start, end }).on('error', () => res.destroy()).pipe(res);
}
const EVENT_PAGE = 500;
let serveSeen = false;   // the [serve] header-names line is logged once per server start
const seatsView = () => [...Object.keys(SEATS).map((name) => ({ name, email: SEATS[name].email, role: SEATS[name].role, cwd: state.cwds[name] || DEFAULT_CWD,
  usage: state.usage[name] || null, conversations: Object.values(state.conversations).filter((c) => c.seat === name).sort((a, b) => b.updatedAt - a.updatedAt).map(summary) })),
  // remote groups after the seats: read-only runs (no "+ new"); the role line carries "unreachable since HH:MM" while ssh fails.
  // control: true adds "+ new" (`control`) and lists the conversations started there next to the runs (viewSummary tells them apart).
  ...REMOTES.map((r) => ({ name: groupOf(r.name), email: r.target, role: (remoteDown.has(r.name) ? downText(r.name) + ' · ' : '') + (r.control ? 'control' : 'read-only') + (r.seat ? ' · ' + r.seat : ''), remote: true, control: r.control, cwd: null, usage: null,
    conversations: [...Object.values(state.remoteConvs), ...Object.values(state.conversations)].filter((c) => c.remote === r.name).sort((a, b) => b.updatedAt - a.updatedAt).map(viewSummary) }))];

async function handler(req, res) {
  try {
    const origin = req.headers.origin;
    // Host check stops DNS rebinding; Origin check stops other websites posting to localhost. Basic auth for all but this PC itself, incl. loopback via tailscale serve.
    let g = gate(req.socket.remoteAddress, req.headers, { hosts: ALLOWED_HOSTS, origins: ALLOWED_ORIGINS, tsName, auth: AUTH_HEADER });
    // Chrome on the phone fetches the manifest, its icons and the service worker WITHOUT the Basic-auth login when it checks "Install app":
    // a 401 there silently hides the install option (the user approved serving exactly these static files without the login, 2026-10-14).
    // They carry no token and no data; the Host/Origin check above still applies; index.html (it holds the token) and every /api route still need the login.
    if (g === 401 && req.method === 'GET' && PUBLIC_STATIC.has(req.url.split('?')[0])) g = 0;
    // Once per start: the header NAMES (never values) of the first proxied request, so the real `tailscale serve` path can be confirmed in server.log after a deploy.
    if (!serveSeen && viaServe(req.headers, tsName)) { serveSeen = true; console.log(`[serve] first proxied request (${g === 0 ? 'authenticated' : g}): headers ${Object.keys(req.headers).join(', ')}`); }
    if (g === 403) return json(res, 403, { error: 'forbidden origin' });
    if (g === 401) {
      await new Promise((r) => setTimeout(r, 500)); // slows password guessing: one try per half second per connection
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Seat Console"' }); return res.end('Authentication required');
    }
    const url = new URL(req.url, 'http://x');
    // Media elements send no Origin, so a cross-site page embedding /api/file is caught by Sec-Fetch-Site instead.
    const site = req.headers['sec-fetch-site'];
    if (url.pathname === '/api/file' && (req.method === 'GET' || req.method === 'HEAD')) {
      if (site && site !== 'same-origin' && site !== 'none') return json(res, 403, { error: 'cross-site' });
      // Not just "not cross-site": the request must say it comes from this console's own page (Referer or Origin), so a bare script or an <img> from elsewhere gets nothing.
      const from = req.headers.referer || origin || '';
      let fromOrigin = null; try { fromOrigin = new URL(from).origin; } catch {}
      if (!fromOrigin || !ALLOWED_ORIGINS.includes(fromOrigin)) return json(res, 403, { error: 'file previews are served to the console page only' });
      return await serveFile(req, res, url);   // await: a throw inside it still ends in the 500 below
    }
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      const raw = fs.readFileSync(path.join(HERE, 'public', file));
      let body = type.startsWith('image/') ? raw : raw.toString('utf8');   // PNG icons stay bytes: a utf8 round trip corrupts them
      if (file === 'index.html') body = body.replace('__TOKEN__', TOKEN);
      return sendZ(req, res, 200, type, body);
    }
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ready: true });
    if (req.method === 'GET' && url.pathname === '/api/seats') return sendZ(req, res, 200, 'application/json; charset=utf-8', JSON.stringify(seatsView()));
    if (req.method === 'GET' && url.pathname === '/api/routines') return json(res, 200, routines.view());
    if (req.method === 'GET' && url.pathname === '/api/digest') return json(res, 200, digestMessage(Date.now(), url.searchParams.get('kind') === 'evening' ? 'evening' : 'morning'));   // the digest text + buttons, nothing is sent
    if (req.method === 'GET' && url.pathname === '/api/conversation') {
      const c = viewOf(url.searchParams.get('id')); if (!c) return json(res, 404, { error: 'no conversation' });
      // The last EVENT_PAGE events (a long conversation would otherwise ship megabytes on every open); ?before=<index> returns the page before that index.
      const pending = [...R(c).perms.keys()], before = url.searchParams.has('before') ? +url.searchParams.get('before') || 0 : null;
      const w = eventWindow(eventsOf(c), pending, before, EVENT_PAGE);
      return sendZ(req, res, 200, 'application/json; charset=utf-8', JSON.stringify({ conv: viewSummary(c), events: slimEvents(w.events, w.from), pending, from: w.from, total: w.total }));
    }
    if (req.method === 'GET' && url.pathname === '/api/tool') {   // full input/output of one tool row, fetched when it is expanded
      const c = viewOf(url.searchParams.get('conv')); if (!c) return json(res, 404, { error: 'no conversation' });
      const d = await toolDetailFull(c, url.searchParams.get('id') || ''); if (!d) return json(res, 404, { error: 'no such tool call' });
      return sendZ(req, res, 200, 'application/json; charset=utf-8', JSON.stringify(d));
    }
    if (req.method === 'GET' && url.pathname === '/api/history') {
      const seat = url.searchParams.get('seat'); if (!hasKey(SEATS, seat)) return json(res, 404, { error: 'no seat' });
      return json(res, 200, seatsView().find((s) => s.name === seat).conversations);
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
      // gzip stream flushed after every write, so a message is never held back waiting for more input
      const out = gz ? zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH }) : res; if (gz) out.pipe(res);
      out.watch = url.searchParams.get('conv') || null;
      out.write(': hi\n\n');
      // Tells the page how many events exist now: one it missed between its snapshot read and this registration shows up as hello.total > snapshot.total (the client resyncs).
      // The log of a conversation not opened since the start is read async (loadLogAsync, like reattachAll): a sync read of a 60 MB log blocked every client.
      // Registered (clients.add) only after the count, as before: an event emitted while it loads is in the total, so the page sees hello.total > snapshot and resyncs.
      const wc = out.watch && viewOf(out.watch), total = wc ? (await loadLogAsync(wc)).length : 0;
      if (req.socket.destroyed || res.destroyed) { if (gz) out.destroy(); return; }   // the page left while the log loaded
      if (wc) out.write(`data: ${JSON.stringify({ hello: true, conv: wc.id, total })}\n\n`);
      if (saveError) out.write('data: {"saveError":true}\n\n'); clients.add(out);
      const ka = setInterval(() => out.write('event: ping\ndata: 1\n\n'), 20000); // a named event, so the page can detect a dead stream
      req.on('close', () => { clearInterval(ka); clients.delete(out); if (gz) out.destroy(); }); return;
    }
    if (req.method === 'POST') {
      if (!same(req.headers['x-seat-token'] || '', TOKEN)) return json(res, 403, { error: 'bad token' });
      if (url.pathname === '/api/upload') {
        // Raw bytes in the body; ?conv= is the conversation (absent for a draft: the file waits in _staged); ?name= the file's name (any file that is not an image).
        if (+req.headers['content-length'] > FILE_MAX) return json(res, 413, { error: 'over 50 MB' });
        const conv = url.searchParams.get('conv'); if (conv && !convOf(conv)) return json(res, 400, { error: 'unknown conversation' });
        const draft = url.searchParams.get('draft'); if (!conv && !/^[0-9a-f]{16}$/.test(draft || '')) return json(res, 400, { error: 'draft id required' });
        const dir = conv || '_staged';
        const buf = await binBody(req, FILE_MAX);
        if (asImage(buf)) return json(res, 200, { ok: true, id: `${dir}/${storeImage(dir, buf, conv ? null : draft)}` });   // magic bytes say image: today's image path
        const stored = storeFile(dir, buf, url.searchParams.get('name'), conv ? null : draft);
        return json(res, 200, { ok: true, file: true, id: `${dir}/${stored}`, name: fileLabel(stored.replace(/^[0-9a-f]{16}-/, '')), size: buf.length });
      }
      const b = await body(req);
      if (url.pathname === '/api/send') {
        if (typeof b.text !== 'string' || !b.text.trim()) return json(res, 400, { error: 'empty text' });
        // "/compact …" and "/context" typed into the composer take the same idle-only path as the meter's buttons (their replies are not chat).
        const sl = convOf(b.conversationId) && /^\/(context|compact)(?:\s+([\s\S]*))?$/i.exec(b.text.trim());
        if (sl) { try { await runSlash(convOf(b.conversationId), sl[1].toLowerCase(), sl[2]); } catch (e) { return json(res, 409, { error: String(e.message || e) }); } return json(res, 200, { ok: true, conversationId: b.conversationId }); }
        const c = await send(b); return json(res, 200, { ok: true, conversationId: c.id, sessionId: c.sessionId });
      }
      if (url.pathname === '/api/retention') {   // test instance only: run the retention pass now (the smoke test checks the archive round trip)
        if (!ISOLATED) return json(res, 403, { error: 'test instance only' });
        return json(res, 200, await retentionRun());
      }
      if (url.pathname === '/api/routine') {
        if (b.action === 'tap') {   // test instance only: drives the Telegram button handler without a phone
          if (!ISOLATED) return json(res, 403, { error: 'test instance only' });
          return json(res, 200, await routines.tap(String(b.data)));
        }
        try { return json(res, 200, await routines.act(String(b.id), String(b.action))); } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
      }
      // "Continue" on a finished run of a control remote: a NEW conversation there that resumes the run's session (--resume <its session_id>) in the run's folder,
      // both read from the run's init event. No process yet: the first message starts it. A read-only remote is refused; a run still writing too (two claudes, one session).
      if (url.pathname === '/api/remote-continue') {
        const rc = remoteOf(b.id), rem = rc && CTL.get(rc.remote);
        if (!rem) return json(res, 400, { error: rc ? 'this remote is read-only ("control": true is not set in remotes.json)' : 'unknown remote run' });
        if (!rc.done && !remoteStale(rc)) return json(res, 409, { error: 'this run is still writing: continue it once it has finished' });
        const init = (await loadLogAsync(rc)).findLast((e) => e.type === 'system' && e.subtype === 'init'), sid = init?.session_id || rc.sessionId, cwd = init?.cwd;
        if (!/^[0-9a-f-]{36}$/.test(sid || '') || typeof cwd !== 'string' || !/^\/[^\0\r\n]*$/.test(cwd)) return json(res, 409, { error: 'the run log names no session id and folder to resume' });
        // a conversation of this console may be running that very session (its claude writes into a followed path): never two claudes on one session
        if (Object.values(state.conversations).some((x) => x.remote === rem.name && x.sessionId === sid && (R(x).proc || R(x).starting || hostInfoOf(x)))) return json(res, 409, { error: 'this session is already running in a conversation here: open that one' });
        const c = newConversation('remote-' + rem.name, { cwd, mode: hasKey(MODE_ARGS, b.mode) ? b.mode : 'auto' });
        Object.assign(c, { remote: rem.name, sessionId: sid, started: true, title: 'continue: ' + rc.title });   // started: the first start resumes instead of creating a session
        saveState(); broadcast({ conv: summary(c) });
        return json(res, 200, { ok: true, conversationId: c.id, sessionId: sid });
      }
      const c = convOf(b.conversationId);
      if (!c) return json(res, 400, { error: 'unknown conversation' });
      if (url.pathname === '/api/stop') { await stopConv(c); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/resume') { await ensureProc(c); setStatus(c, 'idle'); return json(res, 200, { ok: true, sessionId: c.sessionId }); }
      if (url.pathname === '/api/rename') { try { setTitle(c, b.title); } catch (e) { return json(res, 400, { error: e.message }); } saveState(); broadcast({ conv: summary(c) }); return json(res, 200, { ok: true, title: c.title }); }
      if (url.pathname === '/api/pin') {   // manual 📌 on a message (action add, i = its event index) or the ✓ that releases a pin (action done)
        try { if (b.action === 'add') addManualPin(c, { i: b.i, text: b.text }); else if (b.action === 'done') donePin(c, String(b.id)); else throw new Error('unknown action'); } catch (e) { return json(res, 400, { error: e.message }); }
        saveState(); broadcast({ conv: summary(c) }); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/archive') { c.archived = !!b.archived; saveState(); broadcast({ conv: summary(c) }); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/delete') {
        // An idle process is only waiting for input, so it is stopped and removed; a running turn or an open approval refuses.
        if (c.working || c.bg?.length || R(c).perms.size || R(c).starting) return json(res, 409, { error: 'conversation is running: stop it first' });
        await killProc(c);
        if (R(c).proc || R(c).starting) return json(res, 409, { error: 'a message started this conversation again: stop it first' });
        if (c.remote && hostInfoOf(c)) return json(res, 409, { error: `remote ${c.remote} unreachable: its host there could not be stopped, try again when it answers` });   // deleting now would orphan it // a send slipped in while the kill ran: deleting now would orphan its host
        delete state.conversations[c.id]; rt.delete(c.id); saveState();
        fs.rmSync(logFile(c), { force: true }); fs.rmSync(logFile(c) + '.restore', { force: true }); purgeArchive(DATA, c); fs.rmSync(path.join(UPLOADS, c.id), { recursive: true, force: true });
        if (ctlOf(c)) rhost.remoteRmUploads(ctlOf(c), c.id);   // the copies made for its claude there
        for (const x of fs.readdirSync(path.dirname(logFile(c))).filter((n) => n.startsWith(c.id + '.host'))) fs.rmSync(path.join(path.dirname(logFile(c)), x), { force: true }); // host leftovers (log)
        broadcast({ removed: c.id }); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/context' || url.pathname === '/api/compact') {
        try { await runSlash(c, url.pathname.slice(5), b.instructions); } catch (e) { return json(res, 409, { error: String(e.message || e) }); }
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/permission') { decide(c, String(b.requestId), !!b.allow); return json(res, 200, { ok: true }); }
    }
    json(res, 404, { error: 'not found' });
  } catch (e) { json(res, 500, { error: String(e.message || e) }); }
}

// Handlers first: a throw or rejection while conversations are reattached must be logged (and a crash exit recorded), not lost.
process.on('unhandledRejection', (e) => console.log('[unhandledRejection] ' + (e?.stack || e))); // log, never exit: one bad promise must not take every seat down
// A throw nobody caught leaves the process in an unknown state: log it, then exit(1) so the supervisor restarts it (hosts keep their conversations and replay). Only
// "the other end went away" errors (a seat process / socket died mid-write) are survivable.
let uncaughtExit = false;
process.on('uncaughtException', (e) => { console.log('[uncaughtException] ' + (e?.stack || e)); if (!isBenignCrash(e)) { uncaughtExit = true; process.exit(1); } });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(0)); // the exit handler below marks the shutdown clean
process.on('exit', (code) => { state.cleanShutdown = isCleanExit(code, uncaughtExit); if (uncaughtExit) state.lastExit = 'uncaught'; try { saveState(); } catch {} }); // registered only after the bind succeeded, so a second instance never writes state
await reattachAll(); // before the first request is served: statuses are already right when the page loads (the loopback port was bound at the top; requests got 503 until now)
if (ISOLATED && +arg('slow-start')) await new Promise((r) => setTimeout(r, +arg('slow-start')));   // test instance only: smoke.ps1 holds startup open so /health 503 -> 200 is observable
ready = true; console.log(`Seat Console on http://127.0.0.1:${PORT} pid=${process.pid}`);
// Tailscale listener (never 0.0.0.0, never the LAN address): after a boot the interface may not exist yet (EADDRNOTAVAIL), so a failed bind is retried every 10 s.
let tsServer = null, tsBindErr = null;
function bindTailscale() {
  // Under load `tailscale status` can time out after `tailscale ip` worked: the listener binds but tsName stays null, and the phone's
  // https://<tsName> requests (tailscale serve) get 403 forever. Keep re-detecting every tick until the name is known too (2026-10-14).
  if (tsServer) { if (!tsName) detectTailscale(); return; }
  if (!detectTailscale()) return;
  const s = tsServer = http.createServer(handler).on('error', (e) => {
    if (e.message !== tsBindErr) { tsBindErr = e.message; console.log(`[listen] ${tsIp}: ${e.message} (retrying)`); }
    if (tsServer === s) tsServer = null; // the next tick binds again
  });
  s.listen(PORT, tsIp, () => { tsBindErr = null; console.log(`Seat Console on http://${tsIp}:${PORT} pid=${process.pid}`); });
}
bindTailscale(); setInterval(bindTailscale, 10000).unref();
if (!ISOLATED) tg.start();   // a test instance never polls Telegram
if (crashLoopStart && !ISOLATED && crashWarnDue(state, Date.now())) { saveState(); tg.send('⚠️ Seat Console is restarting after an uncaught error (twice within a minute). See server.err.log.').catch(notifyFailed); }
routines.start();
startRemotes();   // after `ready`: an unreachable remote never holds up the start
reattachRemotes();   // same: conversations whose host runs on a remote are reconnected in the background
// After a crash the interrupted conversations are offered on Telegram (one message, buttons) and never resumed without a tap: resuming spends quota.
// The network is often not up right after a boot, so the message is retried until it goes out (or nothing is interrupted any more).
if (crashed && interruptedConvs().length) (async () => {
  for (let i = 0; i < 40 && interruptedConvs().length; i++) {
    const m = await tg.offerRecover(true).catch(() => null);
    if (m) return console.log(`[recover] telegram message sent id=${m.message_id} (${interruptedConvs().length} interrupted)`);
    await new Promise((r) => setTimeout(r, 15000));
  }
})();
sweepStaged(); setInterval(sweepStaged, 3600e3).unref();
// Digest: a test instance has Telegram off and never schedules it (GET /api/digest shows the text). Retention: once shortly after start (after reattach), then at 04:00 Vienna.
if (!ISOLATED) { setInterval(guard('digest', digestTick), 30000).unref(); digestTick(); }
// Usage poll: rate_limit_event only arrives on a console turn, so work done on the same account in another client (desktop app, terminal)
// never moved the meter and it could sit far below the real value. Ask Anthropic for the account's real 5 h window every 3 min.
// Read-only use of the seat's current access token; never refreshes it (that would rotate the CLI's refresh token). Expired token = keep the last value.
async function pollUsage() {
  for (const seat of Object.keys(SEATS)) {
    try {
      const creds = JSON.parse(fs.readFileSync(path.join(HOME, '.claude-seats', seat, '.credentials.json'), 'utf8'));
      const tok = creds.claudeAiOauth?.accessToken; if (!tok) continue;
      const r = await fetch('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: 'Bearer ' + tok, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const w = (await r.json()).five_hour; if (!w || typeof w.utilization !== 'number' || !w.resets_at) continue;
      state.usage[seat] = { windows: { five_hour: { utilization: w.utilization / 100, resetsAt: Math.round(Date.parse(w.resets_at) / 1000) } }, at: Date.now() };
      broadcast({ usage: { seat, ...state.usage[seat] } }); quotaWatch(seat);
    } catch {}   // missing creds (e.g. macOS keychain) / network: the event path still updates the meter
  }
  saveState();
}
if (!ISOLATED) { setInterval(() => pollUsage().catch(() => {}), 180e3).unref(); pollUsage().catch(() => {}); }
setTimeout(() => retentionRun().catch((e) => console.log('[retention] failed: ' + e.message)), 30000).unref();
setInterval(guard('retention', () => { if (viennaHour(Date.now()) === 4 && state.lastRetentionFor !== viennaYmd(Date.now())) retentionRun().catch((e) => console.log('[retention] failed: ' + e.message)); }), 60000).unref();
// Idle processes are stopped after IDLE_REAP_MS (see ensureProc); checked at least once a minute.
setInterval(() => reapIdle().catch((e) => console.log('[idle] ' + e.message)), Math.min(60000, IDLE_REAP_MS / 2)).unref();
// A quiet conversation's host-out file holds only what the jsonl already has: empty it so it does not grow for the life of the conversation.
// Not while a jsonl append failed or a line threw (the file is then the only durable copy); compactFile re-checks that the file really is empty afterwards.
function compactHostOut(c) {
  const r = R(c);
  if (!r.proc || c.remote || !c.hostOff || c.working || c.bg?.length || r.perms.size || r.appendFailed || r.lineFailed || Date.now() - r.lastAt < SETTLE_MS) return;
  const was = { off: c.hostOff, gen: c.hostGen };
  let done = false;
  // The file restarts at byte 0: a new generation, so offsets logged before no longer apply. Persisted BEFORE the truncate (see compactFile); put back if the truncate did not happen.
  try { done = compactFile(hostPaths(hostBase(c)).out, c.hostOff, fs, () => { c.hostOff = 0; c.hostGen = (c.hostGen || 0) + 1; saveState(); }); } catch {}
  if (!done) { if (c.hostGen !== was.gen) { c.hostOff = was.off; c.hostGen = was.gen; saveState(); } return; }
  r.compacted = true; // live lines that still carry offsets of the old file are recognised by lineHandler
}
setInterval(guard('compact', () => { for (const c of Object.values(state.conversations)) compactHostOut(c); }), 30000).unref();
// server.log (stdout, held open by the supervisor's redirect) and supervisor.log grow for ever otherwise: rotated at 5 MB, two old copies kept.
const rotateLogs = () => { for (const f of [path.join(DATA, 'server.log'), ...(ISOLATED ? [] : [path.join(HERE, 'supervisor.log')])]) try { if (rotateLog(f)) console.log('[log] rotated ' + path.basename(f)); } catch (e) { console.log('[log] rotate failed: ' + e.message); } };
rotateLogs(); setInterval(rotateLogs, 600e3).unref();
