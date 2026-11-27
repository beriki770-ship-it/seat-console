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
import { createTelegram, Throttle, sentLine, quotaWarnDue, buildQuotaWarning, esc, escClip, findPermConv } from './telegram.mjs';
import { markInterrupted, isCleanExit, crashLoop, crashWarnDue } from './recovery.mjs';
import { createRoutines } from './routines.mjs';
import { slimEvent, slimEvents, toolDetail, memTrim, memSlim } from './slim.mjs';
import { applyBackground, isActivity, backgroundText } from './background.mjs';
import { convThrottle, retry, rotateLog, turnStart, turnEnd, clearTurns, lastHoff, eventWindow, pickIdle, clipChars, staleTurns, CLAMP_MS, lineHandler, compactFile, failCounter, isBenignCrash, guard, offsetFor, gate, viaServe, resolveIn, outFiles, isDeniedPath } from './hardening.mjs';
import { createLifecycle } from './lifecycle.mjs';
import { guardedKillers, hostNeedle } from './procid.mjs';
import { applyCtx, parseContextReply, ctxLevel, AUTOCOMPACT_BUFFER } from './context.mjs';
import { runRetention, readLogText, restoreLog, gzPath, purgeArchive } from './retention.mjs';
import { createSearch } from './searchidx.mjs';
import { TZ as DIGEST_TZ, viennaHm, viennaYmd, viennaHour, dueSlot, digestRefs, classify, digestRoutines, scanLog, buildMorningDigest, buildEveningDigest } from './digest.mjs';
import { t, tn, hm, fmt, useLanguage, pickLang, LANGS, RTL } from './i18n.mjs';
import { autoArchivable, markTurn, answered, addManualPin, donePin, activePins, setTitle, autoTitle } from './marks.mjs';
import { paths as hostPaths, pidAlive, readJson, readOutFrom, spawnHost, connectHost, stopHost } from './hostlink.mjs';
import { loadRemotes, parseRemotes, followRemote, parseLine, STALE_MS } from './remote.mjs';
import * as rhost from './rhost.mjs';
import { nextTitle, autoHandoffStep, handoffReadyPath, autoHandoffPrompt, continuePrompt, compactInstructions, handoffFileFor, AH_STUCK_MS } from './rollover.mjs';
import { isQuotaStop, resumeAt, RESUME_TEXT, MAX_TRIES as QUOTA_MAX_TRIES } from './quotawait.mjs';
import { allowedDir, convProject, detectProject, gitInfo, handoffHead, newChatCwd } from './project.mjs';
import { byProject, relatedFor } from './touched.mjs';
import { createMulti, loadDisciplines } from './multi.mjs';
import { openIntents, settle as settleIntent, withUnknown, CLI_CMD as JOURNAL_CMD, CLI_PATH as JOURNAL_CLI } from './journal.mjs';
import { readTodos, markTodo, addTodo, parseDue, checkTodos } from './todos.mjs';
import { createIdeas, digestDue } from './ideas.mjs';
import { readCodexAccount, consumeCodexReset, codexModels } from './agents/codex-account.mjs';
import { createVoice, geminiTranscribe, VOICE_PY, VOICE_MODELS, VOICE_LANGS, SMART_MODELS, VOICE_MAX, VOICE_MAX_SEC } from './voice.mjs';
import { createRolling } from './roll.mjs';
import { createDesktop } from './desktop.mjs';
import { listSkills, readSnippets, validateSnippets } from './slash.mjs';
import { createUpdateCheck } from './updatecheck.mjs';
import { readSettings, writeJsonAtomic, validateSettings, onlyGuide, addSeat, removeSeat, checkDisciplines, saveRoutine, addRemote, telegramToken } from './settings.mjs';

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
  first.on('upgrade', (req, socket) => { try { wsUpgrade(req, socket); } catch { socket.destroy(); } });   // /ws/voice (rolling correction); wsUpgrade is defined further down (not yet during startup)
  first.listen(PORT, '127.0.0.1', () => { bound = true; ok(); });
});
fs.mkdirSync(DATA, { recursive: true });
// seats.json (copy seats.example.json): the seats plus `projectsDir`, the default cwd and the root file previews may read from.
// A TEST instance edits copies only: `--seats <file>` / `--remotes <file>` (and --disciplines / --routines below); without them its Settings page cannot write them.
const SEATS_FILE = ISOLATED && arg('seats') ? path.resolve(arg('seats')) : path.join(SEATS_DIR, 'seats.json');
const REMOTES_FILE = ISOLATED && arg('remotes') ? path.resolve(arg('remotes')) : path.join(SEATS_DIR, 'remotes.json');
const CONFIG = JSON.parse(fs.readFileSync(SEATS_FILE, 'utf8').replace(/^﻿/, ''));
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
const DISCIPLINES_FILE = arg('disciplines') ? path.resolve(arg('disciplines')) : path.join(HERE, 'disciplines.json');   // multi-sided projects: discipline -> seat (copy disciplines.example.json)
const ROUTINES_FILE = arg('routines') ? path.resolve(arg('routines')) : path.join(HERE, 'routines.json');   // --routines <file>: the test instance runs a temporary routine from its own file
const AUTH_FILE = path.join(HOME, '.claude', 'secrets', 'seat-console-auth.json');
// settings.json (Settings page): what is turned on. Missing = first run, the page opens Settings. Read on every use (SET()), so a save applies at once.
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const settingsCtx = () => ({ seats: SEATS, disciplines: fs.existsSync(DISCIPLINES_FILE), autoArchiveDays: arg('auto-archive-days') ? +arg('auto-archive-days') : 3, idleReapMinutes: 5 });
let settingsNow = readSettings(SETTINGS_FILE, settingsCtx());
if (settingsNow.error) console.log('[settings] ' + settingsNow.error);
const SET = () => settingsNow.settings;
// Voice input: a warm faster-whisper worker on this machine (voice.mjs). VOICE_PY = a python with faster_whisper (default: console/voice/.venv).
const voice = createVoice({ python: VOICE_PY, script: path.join(HERE, 'voice', 'worker.py'), log: console.log });
// Rolling correction (roll.mjs, /ws/voice): its own worker, so a phrase never waits behind a Smart finish clip; 10 threads (one stream ≈ 10
// cores, measured), unloaded after 10 min without a dictation. The page offers its token as the WebSocket subprotocol.
const rolling = createRolling({
  voice: createVoice({ python: VOICE_PY, script: path.join(HERE, 'voice', 'worker.py'), idleMs: 10 * 60000, env: { VOICE_THREADS: '10' }, log: console.log }),
  auth: (tok) => same(tok, TOKEN) && SET().voice !== false && SET().voiceRolling !== false, loadavg: () => os.loadavg()[0], log: console.log,
});
// Remote desktop (desktop.mjs, /ws/desktop, rail "Desktop"): x11vnc on the xrdp display behind a 0700 unix socket, one folder per console port.
const desktop = createDesktop({ auth: (tok) => same(tok, TOKEN), dir: path.join(process.env.XDG_RUNTIME_DIR || (fs.existsSync(`/run/user/${process.getuid?.()}`) ? `/run/user/${process.getuid()}` : os.tmpdir()), `seat-console-desktop-${PORT}`), log: console.log });
process.on('exit', () => desktop.stop());
// /ws/desktop controls the machine: the same gate as every page request (Host, Basic auth off this PC) AND an Origin that must be present and
// ours (a browser always sends one on a WebSocket; a page on another site cannot open it), then the page token as the subprotocol (desktop.mjs).
function desktopUpgrade(req, socket) {
  const h = req.headers;
  if (!h.origin || !ALLOWED_ORIGINS.includes(h.origin) || gate(req.socket.remoteAddress, h, { hosts: ALLOWED_HOSTS, origins: ALLOWED_ORIGINS, tsName, auth: AUTH_HEADER }) !== 0) {
    return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  }
  const from = [req.socket.remoteAddress, viaServe(h, tsName) && 'via tailscale serve', h['tailscale-user-login'], h['x-forwarded-for'] && 'xff ' + h['x-forwarded-for']].filter(Boolean).join(' ');
  desktop.upgrade(req, socket, from).catch(() => socket.destroy());
}
const wsUpgrade = (req, socket) => { socket.on('error', () => {}); let p = ''; try { p = new URL(req.url, 'http://x').pathname; } catch {} if (ready && p === '/ws/voice') rolling.upgrade(req, socket); else if (ready && p === '/ws/desktop') desktopUpgrade(req, socket); else socket.destroy(); };   // ('GET //' makes URL throw: never a crash)
// Smart finish with Gemini runs the Antigravity CLI on its Google login (voice.mjs geminiTranscribe). A test instance only uses it when SMART_AGY_BIN names one.
const SMART_AGY = ISOLATED ? (process.env.SMART_AGY_BIN || '') : (process.env.AGY_BIN || path.join(HOME, '.local', 'bin', 'agy'));
useLanguage(() => SET().language || 'en');   // the bot speaks the language chosen in Settings, from its next message on (no choice yet: English)
let restartNeeded = false;   // a config file the server reads only at start was changed (seats, remotes, disciplines): the page offers "Restart now"
const canWrite = (argName) => !ISOLATED || !!arg(argName);   // a test instance never edits the real config files
const MAX_PER_SEAT = 5;
// Stream events the UI never shows: they would bloat the log and the browser.
const NOISE = new Set(['hook_started', 'hook_response', 'commands_changed', 'post_turn_summary', 'task_summary']);
const MODE_ARGS = {
  // --allow-dangerously-skip-permissions on every mode only PERMITS a later live switch to bypass (setMode); it does not skip anything by itself.
  auto: ['--permission-mode', 'auto', '--permission-prompt-tool', 'stdio', '--allow-dangerously-skip-permissions'],
  ask: ['--permission-mode', 'manual', '--permission-prompt-tool', 'stdio', '--allow-dangerously-skip-permissions'],
  bypass: ['--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions'],
};

const PUBLIC_STATIC = new Set(['/manifest.webmanifest', '/sw.js', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png']);   // see the gate in the handler
// ---- secrets: CSRF token (every POST) and Basic Auth (every request not from this PC itself, see gate() in hardening.mjs). Never logged. ----
if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(24).toString('hex'));
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
if (!fs.existsSync(AUTH_FILE)) fs.writeFileSync(AUTH_FILE, JSON.stringify({ user: 'seat', password: crypto.randomBytes(24).toString('base64url') }, null, 2));
let AUTH = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
const basic = (a) => 'Basic ' + Buffer.from(`${a.user}:${a.password}`).toString('base64');
let AUTH_HEADER = basic(AUTH);   // replaced live when the Settings page changes the password
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
const REMOTES = loadRemotes(REMOTES_FILE, HOME);
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
  () => { saveError = true; try { broadcast({ saveError: true }); tg.send('⚠️ ' + t('bot.server.saveFailed')).catch(notifyFailed); } catch {} }, // try: at startup broadcast/tg are not defined yet
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
// Action journal (journal.mjs, issue #1): one file per conversation, written by its seat through the journal CLI. Open intents are read
// again only when the file changed (summary() runs on every broadcast).
const JOURNAL_DIR = path.join(DATA, 'journal');
fs.mkdirSync(JOURNAL_DIR, { recursive: true });
const journalOf = (id) => path.join(JOURNAL_DIR, id + '.jsonl');
const openCache = new Map();
function openOf(id) {
  let st; try { st = fs.statSync(journalOf(id)); } catch { openCache.delete(id); return []; }
  const k = st.size + ':' + st.mtimeMs, hit = openCache.get(id); if (hit?.k === k) return hit.list;
  const list = openIntents(journalOf(id)); openCache.set(id, { k, list }); return list;
}
// Open intents of OTHER conversations (the earlier conversations of a project task): each carries its journal file for the record command.
const openElsewhere = (ids) => ids.filter(Boolean).flatMap((id) => openOf(id).map((x) => ({ ...x, file: journalOf(id) })));
const SNIPPETS_FILE = path.join(DATA, 'snippets.json');   // the composer's "@" snippets (slash.mjs), the owner's own text: gitignored like settings.json
// The owner's task board (todos.mjs): seats add what only the owner can do; a seat's add is seen by polling the file's mtime, the page is told to reload.
const TODOS_FILE = path.join(DATA, 'todos.jsonl'), TODOS_CLI = path.join(HERE, 'todos.mjs');
fs.watchFile(TODOS_FILE, { interval: 2000 }, () => { sendAll({ todos: true }); setTimeout(() => todoTick().catch(() => {}), 500); });
function todosView() {
  const all = readTodos(TODOS_FILE).map(({ check, ...x }) => { const c = x.conv && convOf(x.conv); return { ...x, hasCheck: !!check, title: c?.title || null, seat: c?.seat || null }; });   // the check command never leaves the server
  return { open: all.filter((x) => !x.doneAt && !x.dismissedAt), done: all.filter((x) => x.doneAt).slice(0, 30), dismissed: all.filter((x) => x.dismissedAt).slice(0, 30) };
}
// Done / comment from the page or the Telegram ✅ button: recorded, then told to the conversation that asked. told:false = no conversation
// (added by hand, or deleted) or the send failed; the board stays the record either way.
async function todoAct(id, action, text, extra = {}) {   // extra (Telegram only, never the page): { src: 'telegram', imageBuffers, fileBuffers } ride with the message
  const kind = ['done', 'comment', 'dismiss', 'reopen', 'approve', 'reject'].includes(action) ? action : '';
  const x = markTodo(TODOS_FILE, id, kind, text, { src: extra.src });
  sendAll({ todos: true });
  const note = String(text || '').trim(), conv = x.conv && liveOf(convOf(x.conv));
  if (!conv) return { told: false };
  const msg = (kind === 'approve' ? `✅ The user APPROVED: "${x.what}"` : kind === 'reject' ? `❌ The user REJECTED: "${x.what}"` : kind === 'done' ? `✅ The user marked this task as DONE on their task board: "${x.what}"` : kind === 'dismiss' ? `🚫 The user marked the task "${x.what}" as not relevant anymore` : kind === 'reopen' ? `↩️ The user reopened the task "${x.what}" (open again)` : `💬 The user commented on the task "${x.what}" (still open)`) + (note ? `\n${kind === 'dismiss' || kind === 'reject' ? 'Their reason' : kind === 'approve' ? 'Their note' : 'Their comment'}: ${note}` : '') + (kind === 'approve' ? '\nGo ahead with it.' : kind === 'reject' ? '\nDo NOT do it; adjust or stop as their reason says.' : kind === 'done' ? '\nContinue from there.' : kind === 'dismiss' ? '\nDrop it, no need to continue with it.' : '');
  try { await send({ conversationId: conv.id, text: msg, ...(extra.imageBuffers?.length ? { imageBuffers: extra.imageBuffers } : {}), ...(extra.fileBuffers?.length ? { fileBuffers: extra.fileBuffers } : {}) }); } catch (e) { return { told: false, error: String(e.message || e) }; }
  return { told: true };
}
// A Telegram reply to a task card / nag / its 💬 prompt (telegram.mjs deliverTask): a comment on the task, told to the asking chat with the
// photos / files / voice note attached. A voice note is transcribed here (local Whisper, each piece in its own language: he / en / de).
async function tgTodoMessage(id, { text, images = [], files = [], audio = [] }) {
  const x = readTodos(TODOS_FILE).find((k) => k.id === id);
  if (!x) throw new Error(t('bot.todo.gone'));
  if (x.doneAt || x.dismissedAt) throw new Error(t('bot.todo.closed'));
  const conv = x.conv && liveOf(convOf(x.conv));
  if (x.conv && !conv) throw new Error(t('bot.todo.convGone'));   // checked before anything is written: nothing lands half-way
  let heard = '';
  // At most 60 s: the bot handles updates one at a time, a long wait here would hold every other tap. Too slow = sent without a transcript.
  if (audio.length) { try { heard = (await Promise.race([voice.transcribe(audio[0].data, { model: 'small', mode: 'segments' }), new Promise((_, no) => setTimeout(() => no(new Error('took over 60 s')), 60000).unref())])).text.trim(); } catch (e) { console.log('[todos] voice note not transcribed: ' + e.message); } }
  const all = [...images, ...files, ...audio];   // a photo sent "as a file" is still an image
  const note = [text, heard && '🎙 ' + heard, audio.length && !heard && '🎙 (voice note attached, no transcript)', all.length - audio.length > 0 && `📎 ${all.length - audio.length} attachment(s), see this message`].filter(Boolean).join('\n');
  const r = await todoAct(id, 'comment', note, { src: 'telegram', imageBuffers: all.filter((f) => asImage(f.data)).map((f) => f.data), fileBuffers: all.filter((f) => !asImage(f.data)).map((f) => ({ data: f.data, name: f.name })) });
  const said = heard ? `\n🎙 <i>${escClip(heard, 300)}</i>` : '';
  if (!conv) return '📝 ' + t('bot.todo.msgNoConv') + said;
  if (!r.told) return `❌ <b>${t('bot.notSent')}</b> · <code>${escClip(r.error || '', 200)}</code>` + said;   // noted on the task, the chat did not get it
  return '✅ ' + t('bot.todo.msgSent', { seat: `<b>${esc(conv.seat)}</b>`, title: `<i>${esc(String(conv.title || '').slice(0, 60))}</i>` }) + said;
}
// Telegram: every new task once, then once an hour while it is past its due time, never 23:00-07:00 (this machine's
// local time) so it does not wake the owner. state.todoTg[id] = when it was last sent. The ✅ under the message = done (callback v:<id>).
// The message is mapped to the asking conversation, so replying to it in Telegram writes into that chat.
state.todoTg ??= {}; state.todoTgMsg ??= {};   // todoTgMsg[id] = { m: message id, text } so a task closed elsewhere gets its card edited
state.todoTgTask ??= {};   // Telegram message id -> task id (telegram.mjs taskMap): a reply there comments on the task
for (const [id, card] of Object.entries(state.todoTgMsg)) state.todoTgTask[card.m] ??= id;   // cards sent before the map existed
// Machine checks (todos.mjs checkTodos): every 10 min, and with minAge 0 right before a Telegram nag; local seats only (the command runs here).
const todoCheckState = { last: {}, errs: {} };
async function todoChecks(minAgeMs) {
  const skip = (x) => !!(x.conv && convOf(x.conv)?.remote);
  const ids = await checkTodos(TODOS_FILE, todoCheckState, { minAgeMs, skip });
  for (const id of ids) { console.log('[todos] ' + id + ' verified automatically'); await todoNotifyAuto(id).catch(() => {}); }
  if (ids.length) sendAll({ todos: true });
}
async function todoNotifyAuto(id) {
  const x = readTodos(TODOS_FILE).find((k) => k.id === id), conv = x?.conv && liveOf(convOf(x.conv));   // a handed-off conversation: its successor is told (as todoAct)
  if (conv) await send({ conversationId: conv.id, text: `✅ The task "${x.what}" was done — verified automatically` });
}
// A task due days ahead is not announced at once (it read as a nag); Telegram stays quiet until TODO_LEAD_MS before its due time.
// The due day is written out when it is not today ("Mon 30.11 10:30"), never only the hour.
const TODO_LEAD_MS = 2 * 3600000, dueWhen = (ms) => new Date(ms).toDateString() === new Date().toDateString() ? hm(ms) : fmt(ms, { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const TODO_NAG_MS = 3600000, quietHour = (d) => d.getHours() >= 23 || d.getHours() < 7;
async function todoTick(now = Date.now()) {
  if (!tg.readCfg()?.chatId) return;
  await todoChecks(0).catch((e) => console.log('[todos] check failed: ' + e.message));   // a task that is already done must not be nagged
  const view = todosView(), open = view.open; let dirty = false;
  for (const id of Object.keys(state.todoTg)) if (!open.some((x) => x.id === id)) {   // done or gone: forget it, and say so on its card
    const card = state.todoTgMsg[id], y = [...view.done, ...view.dismissed].find((k) => k.id === id);
    if (card && y) await tg.edit(card.m, `${card.text}\n\n${y.dismissedAt ? '🚫 ' + t('bot.todo.closedDismissed') : y.outcome === 'approved' ? '✅ ' + t('bot.todo.closedApproved') : y.outcome === 'rejected' ? '❌ ' + t('bot.todo.closedRejected') : y.auto ? '✅ ' + t('bot.todo.closedAuto') : '✅ ' + t('bot.todo.closedDone')}`, []).catch(() => {});
    delete state.todoTg[id]; delete state.todoTgMsg[id]; dirty = true;
  }
  if (quietHour(new Date(now))) { if (dirty) saveState(); return; }   // night: nothing is sent, a task added now is announced at 07:00
  for (const x of open) {
    const last = state.todoTg[x.id], late = now >= Date.parse(x.due);
    if (!Number.isFinite(Date.parse(x.due)) || (last && (!late || now - last < TODO_NAG_MS)) || (!last && now < Date.parse(x.due) - TODO_LEAD_MS)) continue;   // a hand-edited bad due never blocks the others
    dirty = true;
    const head = last ? '⏰ ' + t('bot.todo.nag', { since: dueWhen(Date.parse(x.due)) }) : '📝 ' + t('bot.todo.new');
    const text = `${head}\n<b>${esc(x.what)}</b>${x.title ? `\n<i>${esc(x.seat || '')} · ${esc(String(x.title).slice(0, 60))}</i>` : ''}${last ? '' : `\n🕒 ${t('bot.todo.due', { time: dueWhen(Date.parse(x.due)) })}`}`;
    state.todoTg[x.id] = now;   // set first: a failed send is not retried every 5 minutes
    const m = await tg.send(text, [[{ text: '✅ ' + t('bot.todo.approveBtn'), callback_data: 'va:' + x.id }, { text: '❌ ' + t('bot.todo.rejectBtn'), callback_data: 'vr:' + x.id }], x.kind === 'approval' ? [{ text: '🚫 ' + t('bot.todo.dismissBtn'), callback_data: 'vx:' + x.id }] : [{ text: '✅ ' + t('bot.todo.doneBtn'), callback_data: 'v:' + x.id }, { text: '🚫 ' + t('bot.todo.dismissBtn'), callback_data: 'vx:' + x.id }], [{ text: '💬 ' + t('bot.todo.msgBtn'), callback_data: 'vm:' + x.id }]]).catch((e) => { notifyFailed(e); return null; });
    if (m && x.conv) state.telegramMsgs[m.message_id] = x.conv;
    tg.rememberTask(m, x.id);
    if (m) state.todoTgMsg[x.id] = { m: m.message_id, text };
  }
  if (dirty) saveState();
}
setInterval(() => todoTick().catch((e) => console.log('[todos] tick failed: ' + e.message)), 60000);
setInterval(() => todoChecks(600000).then(() => {}, (e) => console.log('[todos] check failed: ' + e.message)), 60000);   // each task's own 10-min clock is in checkTodos
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
const unknownOf = (c) => { const u = openOf(c.id); return u.length ? { unknownActions: u.length, unknown: u.slice(0, 20).map(({ id, what, check }) => ({ id, what, check })) } : { unknownActions: 0 }; };
const summary = (c) => { const r = R(c), status = r.shown = effStatus(c), cut = !!c.remote && remoteDown.has(c.remote) && !r.proc; return { id: c.id, seat: c.remote ? groupOf(c.remote) : c.seat /* the page files a conversation under its group */, title: c.title, mode: c.mode, cwd: c.cwd, model: c.model, effort: c.effort, cost: c.cost, status: cut ? 'error' : status, background: cut ? downText(c.remote) : backgroundText(c.bg || []), pending: r.perms.size, needsAnswer: !!c.needsAnswer, pins: activePins(c), suggest: c.suggest || [], archived: !!c.archived, keep: !!c.keep, noAutoHandoff: !!c.noAutoHandoff, project: c.project || null, quotaWait: c.quotaWait?.until || 0, updatedAt: c.updatedAt, sessionId: c.sessionId, ctx: ctxView(c), ...unknownOf(c) }; };
function setStatus(c, status) { R(c).status = status; if (status !== 'interrupted') c.interrupted = false; c.updatedAt = Date.now(); saveState(); broadcast({ conv: summary(c) }); }

const logFile = (c) => path.join(DATA, 'logs', c.seat, c.id + '.jsonl');
const search = createSearch({ data: DATA, logFile, gzPath: (c) => gzPath(DATA, c), root: path.join(HOME, 'Desktop', 'projects') });   // full-text search over titles + chat text, plus the files each one touched (searchidx.mjs)
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
  if (ev.type === 'rate_limit_event') { if (live) accountUsage(REMOTES.find((x) => x.name === c.remote), ev); return; }   // only a remote with "account" feeds a local seat's meter
  if (NOISE.has(ev.subtype) || /^control_/.test(ev.type || '')) return;
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
  else if (ev.type === 'result') console.log(`[done] remote conv=${c.id.slice(0, 10)} notify=skipped (read from byte 0 = history)`);
}
// A finished `claude -p` run can write dozens of result lines at once (seen: 64 results in one second, one Telegram
// message each, some refused with 429). Wait until no further result came for 15 s, then send ONE message for the
// last one, through the same 60 s per-conversation throttle local turns use.
const remoteDoneTimers = new Map();
function remoteDone(c, ev) {
  clearTimeout(remoteDoneTimers.get(c.id));
  remoteDoneTimers.set(c.id, setTimeout(() => {
    remoteDoneTimers.delete(c.id);
    if (!doneThrottle.allow(c.id)) { remoteDoneTimers.set(c.id, setTimeout(() => remoteDone(c, ev), 60000).unref()); console.log(`[done] remote conv=${c.id.slice(0, 10)} notify=deferred (throttle)`); return; }   // the LAST result must not be lost to the 60 s throttle: try again after it
    if (!ev.is_error && quietRepeat(c, ev.result)) { console.log(`[done] remote conv=${c.id.slice(0, 10)} notify=quiet (short repeat)`); return; }
    console.log(`[done] remote conv=${c.id.slice(0, 10)} notify=sent`);
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
  if (ev.type === 'control_response' && ctlPending.has(ev.response?.request_id)) {   // the answer to a request WE sent (ctlRequest)
    const p = ctlPending.get(ev.response.request_id); ctlPending.delete(ev.response.request_id);
    if (ev.response.subtype === 'success') p.resolve(ev.response.response); else p.reject(new Error(ev.response.error || 'refused'));
    return;
  }
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
  if (ev.type === 'rate_limit_event') { const w = ev.rate_limit_info?.unifiedWindows; if (w) { state.usage[c.seat] = { windows: w, at: Date.now() }; saveState(); broadcast({ usage: { seat: c.seat, ...state.usage[c.seat] } }); quotaWatch(c.seat); if (c.remote) accountUsage(ctlOf(c), ev); } return; }
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
    const info = { needsAnswer: !!c.needsAnswer, seat: c.seat, title: c.title, text: ev.result, convId: c.id, files: [...r.turnFiles], unknown: openOf(c.id).length, out: { writes: [...r.turnWrites], named: findPaths(ev.result || '', !WIN), since: r.turnAt ?? Infinity }, ...quotaOf(c.seat), ...ctxNote(c) };   // out: Write targets + files the reply names (the console's preview cards), see outFiles; no turnAt (turn began before a restart) = no named files
    // Usage limit (quotawait.mjs): the conversation is resumed by the console once the limit has reset; the Telegram error says when.
    if (isQuotaStop(ev) && !c.remote && !c.phone) {
      c.unknownDue = true;   // the next message (the automatic resume or the user's) carries the open intents
      const tries = (c.quotaTries || 0) + 1;
      if (tries <= QUOTA_MAX_TRIES) { c.quotaWait = { until: resumeAt(ev, state.usage[c.seat]?.windows, Date.now()), tries }; saveState(); broadcast({ conv: summary(c) }); info.text = `${ev.result}\n\n⏸ resumes by itself at ${new Date(c.quotaWait.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`; console.log(`[quota] conv=${c.id.slice(0, 8)} stopped on the limit, resume at ${new Date(c.quotaWait.until).toISOString()} (try ${tries})`); }
      else { c.quotaTries = 0; info.text = `${ev.result}\n\n⏸ ${QUOTA_MAX_TRIES} resumes in a row hit the limit again; it needs a look`; console.log(`[quota] conv=${c.id.slice(0, 8)} gave up after ${QUOTA_MAX_TRIES} tries`); }
    } else if (!ev.is_error && (c.quotaWait || c.quotaTries)) { c.quotaWait = undefined; c.quotaTries = 0; saveState(); broadcast({ conv: summary(c) }); }   // a turn ended normally (a routine, a background agent after the reset): the work went on, no resume; the next limit counts from 1
    if (!ev.is_error) autoHandoffAtResult(c, ev.result);   // local auto handoff: arm at the crossing / remember HANDOFF-READY (rollover.mjs autoHandoffStep)
    if (ev.is_error) { r.done = null; if (c.multi && !c.quotaWait) multi.settled(c, { error: String(ev.result || 'run ended with an error').slice(0, 300) }); tg.notify('error', info, PHONE).catch(notifyFailed); }
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
    tg.send(m ? `🗜️ <b>${esc(c.seat)}</b> · <i>${esc(clipChars(c.title, 40))}</i> · ${t('bot.compact.done', { from: k(m.pre_tokens), to: k(m.post_tokens) })}${v?.pct != null ? ` (🧠 ${Math.round(v.pct)}%)` : ''}`
      : `⚠️ <b>${esc(c.seat)}</b> · <i>${esc(clipChars(c.title, 40))}</i> · ${t('bot.compact.failedShort')}`).catch(notifyFailed);
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
  // The auto handoff's own reply (HANDOFF-READY) is not news: no ✅, and not held back by the throttle (the switch waits for r.done to clear); the switch itself is announced.
  if (c.autoHandoff?.stage === 'asked' && handoffReadyPath(r.done.info.text)) { r.done = null; console.log(`[done] conv=${c.id.slice(0, 8)} notify=quiet (auto handoff reply)`); return; }
  // Two turns finishing within the throttle window: the later one stays pending (re-checked every second) and goes out when the window has passed, it is never dropped.
  if (!doneThrottle.allow(c.id)) return;
  const { info } = r.done; r.done = null;
  if (c.multi) multi.settled(c, { needsAnswer: !!info.needsAnswer });   // multi-sided project: task done when its .multi/out file exists (multi.mjs)
  if (!info.needsAnswer && quietRepeat(c, info.text)) { console.log(`[done] conv=${c.id.slice(0, 8)} notify=quiet (short repeat)`); return; }
  console.log(`[done] ${new Date().toISOString().slice(11, 19)} conv=${c.id.slice(0, 8)} notify=sent`);
  // The turn's files follow as replies to the done-message, under the same rules as /api/file (outFiles in hardening.mjs).
  tg.notify('done', info, PHONE, info.ctxCompact ? tg.compactButton(c.id) : null).then((m) => { const f = m && !c.remote && outFiles(info.out, c, FILE_RULES);   /* a remote conversation's files are on the remote: never matched against this PC's */ return f?.length ? tg.sendFiles(m.message_id, f) : null; }).catch(notifyFailed);
}
// ---- Auto handoff (rollover.mjs autoHandoffStep, Settings autoHandoff*): a LOCAL conversation past autoHandoffPct writes its HANDOFF.md once
// it is settled, then a fresh conversation continues from that file (or it is compacted). Max AH_MAX_RUNNING handoffs at a time.
const ahCfg = () => { const s = SET(); return { on: s.autoHandoff === true, pct: s.autoHandoffPct ?? 30, minTokens: (s.autoHandoffMinK ?? 120) * 1000, action: s.autoHandoffAction || 'rollover' }; };
const ahFile = (c) => handoffFileFor(c.cwd || HOME, HOME, (f) => fs.existsSync(f), path.join, path.dirname);
const ahRunning = () => Object.values(state.conversations).filter((x) => (x.autoHandoff?.stage === 'asked' && !x.archived) || R(x).ahRolling).length;
function ahView(c, extra = {}) { const v = ctxView(c); return { pct: v?.pct ?? null, used: v?.used ?? 0, agent: !!SEATS[c.seat]?.agent || !!c.multi, ...extra }; }   // project tasks (multi: own projectsFreshAtPct) keep their conversation
function autoHandoffAtResult(c, text) {
  const st = c.autoHandoff?.stage;
  if (st === 'asked') { c.autoHandoff.resAt = Date.now(); const p = handoffReadyPath(text); if (p) c.autoHandoff.ready = path.resolve(c.cwd || HOME, p); saveState(); return; }
  if (st === 'armed') { c.autoHandoff.resAt = Date.now(); return; }
  if (autoHandoffStep(c, ahView(c, { atResult: true }), ahCfg()) !== 'arm') return;
  const v = ctxView(c); c.autoHandoff = { stage: 'armed', pct: v.pct, at: Date.now(), resAt: Date.now() }; saveState();
  console.log(`[autohandoff] conv=${c.id.slice(0, 8)} armed at ${Math.round(v.pct)}% (${Math.round(v.used / 1000)}k)`);
}
function autoHandoffTick(c) {
  const r = R(c), a = c.autoHandoff, now = Date.now();
  if (r.ahRolling) return;
  const settled = r.status === 'idle' && !c.turns && !c.bg?.length && !r.done && !r.slash && !r.starting && now - (a.resAt || 0) >= SETTLE_MS && now - (r.activityAt || 0) >= SETTLE_MS;
  const blocked = !!(r.perms.size || c.needsAnswer || c.quotaWait);
  let fresh = false;
  if (a.ready) { try { fresh = fs.statSync(a.ready).mtimeMs >= (a.askedAt || 0) - 2000; } catch {} }
  const stuck = a.stage === 'asked' && r.status !== 'working' && now - (a.askedAt || now) > AH_STUCK_MS;
  const step = autoHandoffStep(c, ahView(c, { settled, blocked, running: ahRunning(), fresh, stuck }), ahCfg());
  if (!step) return;
  const id = c.id.slice(0, 8);
  if (step === 'rearm' || step === 'disarm' || step === 'cancel') { console.log(`[autohandoff] conv=${id} ${step}`); c.autoHandoff = undefined; saveState(); return; }
  if (step === 'giveup') {
    c.autoHandoff = { ...a, stage: 'gave-up' }; saveState();
    console.log(`[autohandoff] conv=${id}: HANDOFF not updated after ${a.tries} asks, giving up`);
    tg.send('⚠️ ' + t('bot.autoHandoff.noHandoff', { title: `<i>${esc(clipChars(c.title, 40))}</i>`, file: esc(a.file || '') })).catch(notifyFailed);
    return;
  }
  if (step === 'ask' || step === 'retry') {
    const v = ctxView(c), file = a.file || ahFile(c);
    c.autoHandoff = { stage: 'asked', pct: a.pct ?? v?.pct, at: a.at, askedAt: now, resAt: now, tries: (a.tries || 0) + 1, file }; saveState();
    console.log(`[autohandoff] conv=${id} at ${Math.round(v?.pct ?? 0)}%: handoff asked (try ${c.autoHandoff.tries})`);
    send({ conversationId: c.id, text: autoHandoffPrompt(v?.pct ?? a.pct, file), auto: true }).catch((e) => { c.autoHandoff = { ...c.autoHandoff, stage: 'gave-up', error: e.message }; saveState(); console.log(`[autohandoff] conv=${id} handoff send failed, giving up: ${e.message}`); });   // never re-asked every second
    return;
  }
  if (step === 'continue') {
    r.ahRolling = true;
    ahContinue(c, a.ready).catch((e) => {
      if (c.autoHandoff?.stage === 'done') return console.log(`[autohandoff] conv=${id} after the switch: ${e.message}`);   // successor exists and is linked
      c.autoHandoff = { ...c.autoHandoff, stage: 'gave-up', error: e.message }; saveState();
      console.log(`[autohandoff] conv=${id} continue failed: ${e.message}`);
      tg.send('⚠️ ' + t('bot.autoHandoff.failed', { title: `<i>${esc(clipChars(c.title, 40))}</i>`, error: esc(e.message) })).catch(notifyFailed);
    }).finally(() => { r.ahRolling = false; });
  }
}
async function ahContinue(c, file) {
  const a = c.autoHandoff, prev = { id: c.id, title: c.title, pct: a.pct ?? ctxView(c)?.pct ?? 0 }, id = c.id.slice(0, 8);
  if (ahCfg().action === 'compact') {
    await runSlash(c, 'compact', compactInstructions(file), false);
    c.autoHandoff = { stage: 'done', action: 'compact', pct: prev.pct, file, at: Date.now() };
    pushEvent(c, { type: 'console_note', key: 'log.ahCompacted', pct: Math.round(prev.pct), file }); saveState(); broadcast({ conv: summary(c) });
    console.log(`[autohandoff] conv=${id} compacting after the handoff`);
    tg.send(`🧭 <b>${esc(c.seat)}</b> · ` + t('bot.autoHandoff.compacted', { title: `<i>${esc(clipChars(prev.title, 40))}</i>`, pct: Math.round(prev.pct) })).catch(notifyFailed);
    return;
  }
  // Successor first: if it cannot start, the old conversation stays as it was (gave-up, the owner is told).
  const n = await send({ seat: c.seat, cwd: c.cwd, model: c.model, effort: c.effort, mode: c.mode, title: nextTitle(c.title), text: withUnknown(continuePrompt(prev, file), openElsewhere([c.id])), auto: true });   // open intents of this conversation travel with the handoff
  c.autoHandoff = { stage: 'done', action: 'rollover', to: n.id, pct: prev.pct, file, at: Date.now() }; c.archived = true;   // first: nothing below may leave a successor unlinked (a second one later)
  if (c.project) n.project = c.project;
  pushEvent(c, { type: 'console_note', key: 'log.ahHandedOff', pct: Math.round(prev.pct), file, link: { id: n.id, seat: n.seat, title: n.title } });
  pushEvent(n, { type: 'console_note', key: 'log.ahContinues', file, link: { id: c.id, seat: c.seat, title: c.title } });
  saveState(); broadcast({ conv: summary(n) });
  await stopConv(c).catch((e) => console.log(`[autohandoff] conv=${id} stop failed: ${e.message}`));
  broadcast({ conv: summary(c) });
  console.log(`[autohandoff] conv=${id} -> ${n.id.slice(0, 8)}`);
  tg.send(`🧭 <b>${esc(c.seat)}</b> · ` + t('bot.autoHandoff.handedOver', { title: `<i>${esc(clipChars(prev.title, 40))}</i>`, pct: Math.round(prev.pct), next: `<i>${esc(clipChars(n.title, 40))}</i>` })).catch(notifyFailed);
}
// The live end of an auto handoff chain: a task-board answer or a Telegram reply to an archived predecessor goes to its successor.
function liveOf(c) { for (let i = 0; c && i < 20; i++) { const to = c.autoHandoff?.stage === 'done' && c.autoHandoff.to; const n = to && convOf(to); if (!n) return c; c = n; } return c; }
{ const cfg = ahCfg(), over = Object.values(state.conversations).filter((c) => autoHandoffStep(c, ahView(c, { atResult: true }), cfg) === 'arm');
  console.log(`[autohandoff] ${cfg.on ? 'on' : 'off'} at ${cfg.pct}% (floor ${cfg.minTokens / 1000}k, ${cfg.action}): ${over.length} local conversation(s) already past it, each armed only when it finishes a new turn: ${over.map((c) => c.id.slice(0, 8)).join(' ') || '-'}`); }
// Once a second: announce settled conversations, and refresh the page when the 20 s "recent events" window of a conversation runs out.
setInterval(guard('tick', () => { for (const c of Object.values(state.conversations)) { if (staleTurns(c, R(c), Date.now(), CLAMP_MS)) { clearTurns(c); R(c).clampAt = 0; setStatus(c, 'idle'); console.log(`[turns] conv=${c.id.slice(0, 8)}: result seen, nothing since: pending-turn counter cleared`); } settleDone(c); if (c.autoHandoff) try { autoHandoffTick(c); } catch (e) { console.log(`[autohandoff] conv=${c.id.slice(0, 8)} tick: ${e.message}`); } if (effStatus(c) !== R(c).shown) broadcast({ conv: summary(c) }); } }), 1000).unref();
// Usage-limit resume (quotawait.mjs): a conversation that stopped on the limit gets RESUME_TEXT once its time has come.
// Not while it runs (a turn the CLI started by itself), never for an archived, remote or phone one; a send that fails is retried next minute.
const quotaBusy = new Set();
setInterval(guard('quota', () => {
  const now = Date.now();
  for (const c of Object.values(state.conversations)) {
    const w = c.quotaWait; if (!w || now < w.until || quotaBusy.has(c.id)) continue;
    if (c.archived || c.remote || c.phone) { c.quotaWait = undefined; saveState(); broadcast({ conv: summary(c) }); continue; }
    if (R(c).status === 'working' || c.turns > 0 || R(c).perms.size) continue;
    quotaBusy.add(c.id); c.quotaTries = w.tries; c.quotaWait = undefined; saveState();
    console.log(`[quota] conv=${c.id.slice(0, 8)} resuming (try ${w.tries})`);
    send({ conversationId: c.id, text: withUnknown(RESUME_TEXT, openOf(c.id)), auto: true })
      .then(() => { c.unknownDue = undefined; saveState(); })   // the resume carried the open intents; a resume that never got through leaves them for the user's next message
      .catch((e) => {   // retried twice, a minute apart; then it needs a person (a write that failed may already have logged the message)
        const fails = (w.fails || 0) + 1; c.quotaWait = fails < 3 ? { until: Date.now() + 60e3, tries: w.tries, fails } : undefined; saveState();
        console.log(`[quota] conv=${c.id.slice(0, 8)} resume send failed (${fails}/3): ${e.message}`);
        if (fails >= 3) tg.notify('error', { seat: c.seat, title: c.title, text: '⏸ ' + t('bot.server.resumeFailed', { error: e.message }), convId: c.id, files: [] }, PHONE).catch(notifyFailed);
      })
      .finally(() => { quotaBusy.delete(c.id); broadcast({ conv: summary(c) }); });
  }
}), 30000).unref();
// A seat process can die between our check and the write (EPIPE): never throw from here, tell the caller (false) and the page (console_error).
// A control request to the running claude (stream-json), answered by a control_response with the same request_id (handleLine).
const ctlPending = new Map();
function ctlRequest(c, request, ms = 10000) {
  if (!R(c).proc?.stdin?.writable) return Promise.reject(new Error('no running process'));
  const id = 'sc-' + crypto.randomBytes(6).toString('hex');
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ctlPending.delete(id); reject(new Error('no answer from the process')); }, ms);
    ctlPending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    writeProc(c, { type: 'control_request', request_id: id, request });
  });
}
// Permission mode, changeable at any time. A live process is switched in place (set_permission_mode, no restart);
// one that refuses (started before every mode carried --allow-dangerously-skip-permissions) is restarted when idle, refused when busy.
// No process: the next start uses the new mode.
const CLI_MODE = { auto: 'auto', ask: 'default', bypass: 'bypassPermissions' };
async function setMode(c, mode) {
  if (!hasKey(MODE_ARGS, mode)) throw new Error('unknown mode');
  if (mode === c.mode) return 'same';
  let how = 'next';
  if (R(c).proc) {
    try { await ctlRequest(c, { subtype: 'set_permission_mode', mode: CLI_MODE[mode] }); how = 'live'; }
    catch (e) {
      if (c.working || c.bg?.length || R(c).perms.size) throw new Error('The running agent refused the switch (' + e.message + '). Wait for this turn to finish, then change it.');
      await killProc(c);
    }
  }
  c.mode = mode; saveState(); broadcast({ conv: summary(c) });
  console.log(`[mode] conv=${c.id.slice(0, 8)} -> ${mode} (${how})`);
  return how;
}
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
// Other agents (opt-in, seats.json "agent": "codex" | "agy"): an adapter in agents/<name>.mjs speaks claude's stream-json to the console and drives its own CLI.
// Several accounts per AI: an agent seat may name its own login folder ("home"), like each Claude seat has its own CLAUDE_CONFIG_DIR.
// Codex reads it as CODEX_HOME, Antigravity keeps its login under HOME. No "home" = the CLI's default login.
const agentEnv = (seat) => { const a = SEATS[seat]?.agent, h = SEATS[seat]?.home && path.resolve(String(SEATS[seat].home).replace(/^~(?=[\\/]|$)/, HOME));
  return !h ? {} : a === 'codex' ? { CODEX_HOME: h } : a === 'agy' ? { HOME: h } : {}; };
// Two seats of the same agent on ONE login would spend each other's resets: each needs its own "home".
const sharedLogin = (seat) => { const a = SEATS[seat].agent, mine = JSON.stringify(agentEnv(seat)); return Object.keys(SEATS).some((n) => n !== seat && SEATS[n].agent === a && JSON.stringify(agentEnv(n)) === mine); };
const resetBusy = new Set();
const agentScript = (name) => { if (!/^[a-z0-9-]+$/.test(name) || !fs.existsSync(path.join(HERE, 'agents', name + '.mjs'))) throw new Error('unknown agent ' + name); return path.join(HERE, 'agents', name + '.mjs'); };
const AGY_BIN = process.env.AGY_BIN || path.join(HOME, '.local', 'bin', 'agy');
// The model menu of an agent seat, read from its CLI on that seat's own login (cached 10 min): [{ id, name, default }].
const modelCache = new Map();
async function agentModels(seat) {
  const agent = SEATS[seat].agent, hit = modelCache.get(seat); if (hit && Date.now() - hit.at < 600e3) return hit.list;
  let list = [];
  if (agent === 'codex') list = await codexModels({ env: agentEnv(seat) });
  else if (agent === 'agy') list = await new Promise((ok, no) => execFile(AGY_BIN, ['models'], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ...agentEnv(seat) } }, (e, out) => e ? no(e)
    : ok(out.split('\n').map((l) => l.split('\t')).filter((p) => p.length >= 2 && /^[\w.-]+$/.test(p[0].trim())).map(([id, name], i) => ({ id: id.trim(), name: name.trim(), default: i === 0 })))));
  modelCache.set(seat, { at: Date.now(), list }); return list;
}
async function startProc(c) {
  const rem = ctlOf(c);   // a remote conversation: no seat dir to prepare, claude runs there under the remote's own login
  const agent = !rem && SEATS[c.seat]?.agent;   // an agent seat: its own CLI and login, no Claude seat dir to prepare
  if (!rem && !agent) await initSeat(c.seat);
  else if (R(c).remoteKillFailed) throw new Error(`remote ${rem.name} unreachable: the previous host there could not be stopped; send again when it answers`);
  const configDir = rem ? `(remote ${rem.name}: its own login)` : agent ? `(${agent}: its own login)` : path.join(HOME, '.claude-seats', c.seat);
  // Idempotency first, journal second. Not for a remote: its claude runs there and cannot write this machine's journal. The CLI is named by its
  // absolute path (JOURNAL_CMD), so the same command works in bash, cmd and PowerShell; SEAT_JOURNAL (env) tells it which file is this conversation's.
  const JOURNAL_RULE = `Make external actions SAFE TO REPEAT whenever you can: deploy/upload with a sync or deploy script that can simply be re-run (rsync, an idempotent deploy script), and give one-shot publish scripts a guard (a state file that refuses a second post/send). Only for an external action that is NOT safe to repeat (sending an email or chat message, posting or commenting on a site, a payment, creating an issue/ticket, a non-idempotent API write) record it: \`${JOURNAL_CMD} intent "<what>" --check "<how to verify it happened>"\` before (it prints an id), \`${JOURNAL_CMD} done <id> "<result>"\` (or \`fail <id> "<error>"\`) after. Local file edits are not external actions.`;
  const journalEnv = { SEAT_JOURNAL: journalOf(c.id), SEAT_JOURNAL_CLI: JOURNAL_CLI, SEAT_TODOS: TODOS_FILE, SEAT_TODO_CLI: TODOS_CLI, SEAT_CONV: c.id };
  // A step only the user can do gets lost in a long reply: it goes on their task board as well.
  const TODO_RULE = 'When a step needs the user themselves (open or sign up for an account, log in, verify an email or phone, pay, sign, a call, a decision that blocks you), say it in the reply AND put it on their task board: `node "$SEAT_TODO_CLI" add "<what to do, where (URL), why>" --due <+30m | +2h | 2026-11-24T10:00> --check "<shell command>"` (one line, their language; --due = by when it has to be done, default one hour; past it they are reminded on Telegram every hour). Give --check when the result is machine-checkable (exit 0 = done, e.g. a `claude auth status` that shows the email, a curl that returns HTTP 200, `test -f <file>`): the console runs it every ~10 minutes and closes the task by itself. When you need a yes/no from the user BEFORE an irreversible or outward step (sending, publishing, paying, deleting), add the task with `--approve` (`node "$SEAT_TODO_CLI" add "<what to approve, with the exact item or link>" --approve`) and wait for the APPROVED / REJECTED message instead of asking in chat; do not do the step before APPROVED arrives. When they tick it or comment, you get a message in this conversation; continue from there. When you later see the step was done (they tell you, or you verify it), close it yourself: `node "$SEAT_TODO_CLI" done <id> "<evidence>"` (`dismiss <id> "<why>"` if it no longer matters).'.replaceAll('node "$SEAT_TODO_CLI"', `node "${TODOS_CLI}"`);   // the absolute path: the same command in bash, cmd and PowerShell (as JOURNAL_RULE)
  const ending = 'End every final reply with one last line that starts with "Summary:" — at most 3 short sentences: what was done, the result, and what (if anything) is needed from the user.';
  const role = rem ? `You are a Claude session on the remote machine '${rem.name}', driven from the user's Seat Console. ${ending}`
    : `You are the '${c.seat}' seat (${SEATS[c.seat].email}) in the user's multi-seat setup. Your area: ${SEATS[c.seat].role}. Prefer work in that area, but a task the user sends you explicitly is always yours to do. ${JOURNAL_RULE} ${TODO_RULE} ${ending}`;
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
    : agent ? await spawnHost({ base: hostBase(c), script: HOST_JS, exe: process.execPath, args: [agentScript(agent), ...args], cwd: c.cwd, env: { ...cleanEnv(), AGENT_STATE: path.join(DATA, 'agent-state'), AGY_BIN, ...agentEnv(c.seat), ...journalEnv }   /* AGY_BIN: absolute, because a seat "home" changes HOME */, token: crypto.randomBytes(24).toString('hex') })
    : await spawnHost({ base: hostBase(c), script: HOST_JS, exe: CLAUDE_CMD[0], args: [...CLAUDE_CMD.slice(1), ...args], cwd: c.cwd, env: { ...cleanEnv(), CLAUDE_CONFIG_DIR: configDir, ...journalEnv }, token: crypto.randomBytes(24).toString('hex') });
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
  if (c.working) { c.unknownDue = true; clearTurns(c); const text = `process exited (${code}) ${String(err).trim()}`; pushEvent(c, { type: 'console_error', text }); setStatus(c, 'error'); tg.notify('error', { seat: c.seat, title: c.title, text, convId: c.id, unknown: openOf(c.id).length }, PHONE).catch(notifyFailed); }
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
    if (!R(c).proc || isBusy(c) || Date.now() - R(c).lastAt < (+arg('reap-ms') || SET().idleReapMinutes * 60000)) continue;
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
    req.on('error', no); req.on('aborted', () => no(new Error('upload aborted')));   // a client that leaves mid-upload must not leave the handler hanging
  });
}

async function send(b) {
  let c = b.conversationId && convOf(b.conversationId);
  if (b.conversationId && !c) throw new Error('unknown conversation');
  const rem = c ? ctlOf(c) : ctlByGroup(b.seat);   // a new conversation on a control remote: the page sends its group name ("remote: <name>")
  const seat = c ? c.seat : rem ? 'remote-' + rem.name : b.seat;
  if (!rem && !hasKey(SEATS, seat)) throw new Error('unknown seat');
  if (b.mode && !hasKey(MODE_ARGS, b.mode)) throw new Error('unknown mode');
  // A new chat opens in the folder picked for it, else in the one project its first message names, else in the neutral projects root:
  // never in whatever folder this seat's previous chat used (a chat about one project opened in another's folder).
  const cwd = c ? b.cwd || c.cwd : rem ? b.cwd || state.cwds[seat] || await rhost.remoteHome(rem) : newChatCwd({ picked: b.cwd, text: b.text, folders: projectFolders(), root: DEFAULT_CWD });
  // A remote folder only has to be an absolute path here: it is checked THERE, a missing one fails the host start with claude's own error.
  if (rem ? !/^\/[^\0\r\n]*$/.test(cwd) : !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('cwd does not exist: ' + cwd);
  if (c && R(c).slash && Date.now() - R(c).slash.at < 600000) throw new Error('/' + R(c).slash.kind + ' is running on this conversation: send again when it has finished.');
  const created = !c;
  const due = !!c && !b.auto && (c.unknownDue || R(c).status === 'interrupted');   // the user's first message after an interruption, a crash, a Stop or a usage-limit stop carries the open intents (once)
  if (due && !c.unknownDue) { c.unknownDue = true; saveState(); }   // kept until the message really reaches the seat: a failed start or write must not lose the note
  if (c?.archived) c.archived = false;   // writing to it again = in use: back to the live list
  if (!c) { c = newConversation(seat, { cwd, model: b.model || (!rem && SET().models[seat]) || undefined, effort: b.effort, mode: b.mode }); if (rem) c.remote = rem.name; }   // "default model" = the seat's default from Settings, if one is set
  // Anything below failing (spawn, bad image id, dead stdin) must not leave a ghost conversation behind that THIS call created.
  try {
  // cwd, model and effort are fixed per process: changing one restarts it on the same session (--resume keeps the conversation). Mode: setMode (live switch).
  if (!created && b.mode && b.mode !== c.mode) await setMode(c, b.mode);
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
  if (!b.auto && (c.quotaWait || c.quotaTries)) { c.quotaWait = undefined; c.quotaTries = 0; }   // the user took over: no automatic resume
  if (!b.auto) { answered(c); c.noAutoArchive = false; if (c.autoHandoff?.stage === 'asked') { c.autoHandoff.owner = true; console.log(`[autohandoff] conv=${c.id.slice(0, 8)}: the user wrote during the handoff, no switch now`); } }   // the user wrote: the needs-answer mark goes, the automatic pins made before this message are released. b.auto = an automated sender (recover, routine, send.ps1): not an answer
  const bt = due ? withUnknown(b.text, openOf(c.id)) : b.text;
  pushEvent(c, { type: 'console_user', text: bt, ...(images.length ? { images } : {}), ...(files.length ? { files: files.map((f) => ({ name: f.stored, label: f.label, size: f.size })) } : {}) });
  const r = R(c); if (!c.turns) { r.turnFiles.clear(); r.turnWrites.clear(); r.turnAsks = []; r.turnAt = Date.now() - 2000; } // a second message mid-turn keeps the files the running turn already wrote; turnAt (2 s mtime slack): reply-named files count from here
  r.clampAt = 0; turnStart(c); setStatus(c, r.perms.size ? 'waiting' : 'working'); // clampAt of the previous result must not clamp this new turn before its first event
  const text = (c.effort === 'ultracode' ? 'ultracode\n\n' + bt : bt) + files.map((f) => `\nAttached file: ${f.path} (${f.label}, ${sizeText(f.size)})`).join('');
  if (!writeProc(c, { type: 'user', message: { role: 'user', content: images.length ? [{ type: 'text', text }, ...images.map((n) => imageBlock(c, n))] : text } })) {
    turnEnd(c); setStatus(c, c.turns ? 'working' : 'error'); throw new Error('seat process is not accepting input, try again');
  }
  if (due) { c.unknownDue = undefined; saveState(); }
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
// An agent waiting out a quota reset can wake itself every minute and end each turn with "Waiting." — one notification per minute.
// A short reply right after another short one in the same conversation is a status ping, not news: at most one per REPEAT_QUIET_MS.
// A long reply (the real report) or a question always goes out.
const SHORT_CHARS = 160, REPEAT_QUIET_MS = 30 * 60000, lastDone = new Map();
const WAIT_RE = /(wait(ing)?|still (running|working)|reset|limit)|מחכה|ממתין|ממתינה|איפוס|מגבלה/i;
function quietRepeat(c, text, now = Date.now()) {
  const short = String(text || '').trim().length < SHORT_CHARS, p = lastDone.get(c.id);
  if (short && WAIT_RE.test(String(text || ''))) return true;   // a pure waiting status (quota reset, background agents) never pings
  if (short && p?.short && now - p.at < REPEAT_QUIET_MS) return true;
  lastDone.set(c.id, { at: now, short }); return false;
}
async function tgDecision(convShort, requestId, allow) {
  const c = findPermConv(state.conversations, convShort, requestId, (x, id) => !!rt.get(x.id)?.perms?.has(id));
  decide(c, requestId, allow);
  return allow ? 'Allowed' : 'Denied';
}
async function tgReply(convId, { text, images, files = [] }) {
  const c = liveOf(convOf(convId)); if (!c) throw new Error('that conversation was deleted');   // a reply to a handed-off conversation goes to its successor
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
// 90 % warning, ONE per seat per window. It never names another seat: each seat has its own limit, work is never moved to dodge it.
function quotaWatch(seat) {
  const q = fiveHour(seat); if (!SET().quotaWarning || !q || q.expired || !quotaWarnDue(state.quotaWarned, seat, q.util, q.resetsAt / 1000)) return;
  saveState();
  tg.send(buildQuotaWarning({ seat, util: q.util, resetsAt: q.resetsAt })).catch(notifyFailed);
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
    try { await send({ conversationId: c.id, text: withUnknown(text, openOf(c.id)), auto: true }); c.unknownDue = undefined; saveState(); out.resumed.push({ seat: c.seat, title: c.title }); } catch (e) { out.failed.push({ seat: c.seat, title: c.title, error: e.message }); }
  }
  return out;
}
const tgFind = (short) => { const c = Object.values(state.conversations).find((x) => x.id.startsWith(short)); return c && { id: c.id, seat: c.seat, title: c.title }; };
const notifyFailed = (e) => console.log('telegram notify failed: ' + (e?.message || e));
const tg = createTelegram({ cfgFile: TELEGRAM_FILE, linkCodeFile: path.join(DATA, 'telegram-link-code.txt'), onNewTask: tgNewTask, onList: tgList, onStatus: tgStatus, onDigest: async (kind) => digestMessage(Date.now(), kind), onUsage: tgUsage, onRecoverList: tgRecoverList, onRecover: tgRecover, onRoutineTap: (d) => routines.tap(d), onRoutineList: () => routines.listMessage(), onMulti: async ({ name, dir, brief }) => multiOn().create({ name, dir, brief }), onTodoDone: async (id) => { const r = await todoAct(id, 'done', ''); return '✅ ' + t('bot.todo.doneToast') + (r.told ? '' : ' (' + t('bot.todo.notTold') + ')'); }, onTodoApprove: async (id) => { const r = await todoAct(id, 'approve', ''); return '✅ ' + t('bot.todo.approveToast') + (r.told ? '' : ' (' + t('bot.todo.notTold') + ')'); }, onTodoReject: async (id) => { const r = await todoAct(id, 'reject', ''); return '❌ ' + t('bot.todo.rejectToast') + (r.told ? '' : ' (' + t('bot.todo.notTold') + ')'); }, onTodoMessage: tgTodoMessage, todoWhat: (id) => { const x = readTodos(TODOS_FILE).find((k) => k.id === id); return x && !x.doneAt && !x.dismissedAt ? x.what : null; }, taskMap: state.todoTgTask, apiBase: (ISOLATED && process.env.SEAT_TG_API) || undefined, onTodoDismiss: async (id) => { const r = await todoAct(id, 'dismiss', ''); return '🚫 ' + t('bot.todo.dismissToast') + (r.told ? '' : ' (' + t('bot.todo.notTold') + ')'); }, onIdea: (x) => ideaFromTelegram(x), ideaCapture: () => SET().ideasTelegram !== false, onMultiApprove: async (short) => { const p = multiOn().find(short); if (!p) throw new Error('unknown project'); multi.approve(p.id); return `▶️ ${p.name}: ${tn('bot.multi.starting', p.tasks.length)}`; }, findConv: tgFind, seats: Object.keys(SEATS), phoneBase: () => PHONE, onDecision: tgDecision, onReply: tgReply, onCompact: tgCompact, msgMap: state.telegramMsgs, onMapChange: saveState, getOffset: () => offsetFor(state, tg.readCfg()?.botToken), setOffset: (o) => { offsetFor(state, tg.readCfg()?.botToken); state.tgOffset = o; saveState(); } }); // offsetFor first: it records which bot this offset belongs to

// The Projects page lists project folders to start from: a folder under projectsDir (2 levels deep) that has one of these markers. Read at most once a minute.
const PROJECT_MARKERS = ['.git', 'package.json', 'CLAUDE.md', 'BRIEF.md', 'PLAN.md', 'HANDOFF.md', path.join('docs', 'HANDOFF.md')];
let foldersCache = { at: 0, list: [] };
function projectFolders() {
  if (Date.now() - foldersCache.at < 60e3) return foldersCache.list;
  const root = DEFAULT_CWD, list = [];
  const dirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !/^[._]|^node_modules$/.test(e.name)).map((e) => path.join(d, e.name)); } catch { return []; } };
  for (const d1 of dirs(root)) for (const d of [d1, ...dirs(d1)]) {
    const hit = PROJECT_MARKERS.find((m) => fs.existsSync(path.join(d, m))); if (!hit) continue;
    let mtime = 0; try { mtime = fs.statSync(path.join(d, hit)).mtimeMs; } catch {}
    list.push({ name: path.relative(root, d), dir: d, mtime });
  }
  foldersCache = { at: Date.now(), list: list.sort((a, b) => b.mtime - a.mtime) };
  return foldersCache.list;
}

// Conversations of a project folder, for the Projects page: the ones moved there by hand, plus those running inside it (cwd = dir or below);
// one that sits in a nested project folder belongs to the deepest one only (project.mjs convProject).
const convHits = (dir, dirs) => {
  return Object.values(state.conversations).filter((c) => convProject(c, dirs) === dir).sort((a, b) => !!a.archived - !!b.archived || b.updatedAt - a.updatedAt);   // live ones first, archived after
};
// What waits on the user in a conversation (its summary v): the "Needs you" queue of a project page and the counts of the Projects page.
const needOf = (v) => [v.pending && 'perms', v.needsAnswer && 'answer', v.quotaWait && 'quota', v.status === 'error' && 'error'].filter(Boolean);
// Related conversations (touched.mjs): dir -> [{ c, w, r }] for every listed folder a conversation worked in without being opened there
// (by cwd or Move to project), minus the folders the user marked "Not related" for it (c.notRelated). Per conversation the split of its touched
// files over the folders is kept until the folder list or its touched files change (paths.ver, bumped by searchidx; a rebuilt log gets a new map).
const relMemo = new WeakMap();
// The touched files of logs that grew since (incremental), for /api/project and /api/multi; at most every 5 s (the page asks on every
// multi broadcast), and during the first build only what is in so far.
let touchedAt = 0;
const freshTouched = async () => { if (Date.now() - touchedAt < 5000) return; touchedAt = Date.now(); await search.refresh(Object.values(state.conversations), { wait: false }); };
function relatedIndex(dirs) {
  const key = dirs.join('\0'), out = new Map();
  for (const c of Object.values(state.conversations)) {
    const paths = search.touched(c.id); if (!paths?.size) continue;
    let m = relMemo.get(paths); if (!m || m.key !== key || m.ver !== paths.ver) relMemo.set(paths, m = { key, ver: paths.ver, ...byProject(paths, dirs) });
    for (const [d, n] of relatedFor(m, convProject(c, dirs), c.notRelated)) (out.get(d) || out.set(d, []).get(d)).push({ c, ...n });
  }
  return out;
}
// One compact row of the Projects page: counts over the live conversations opened in the folder (opened: dir -> live ones, one pass
// over the conversations for all folders) and those related to it.
function folderBrief(dir, opened, rel) {
  const own = opened.get(dir) || [], related = (rel.get(dir) || []).map((x) => x.c).filter((c) => !c.archived), all = [...own, ...related];
  const vs = all.map(summary);
  return { live: own.length, related: related.length, working: vs.filter((v) => ['working', 'waiting'].includes(v.status)).length, need: vs.filter((v) => needOf(v).length).length, last: Math.max(0, ...all.map((c) => c.updatedAt || 0)) };
}

// ---- multi-sided projects (multi.mjs): discipline -> its FIXED seat (console/disciplines.json); a seat at its limit makes its tasks wait, never another seat ----
// No disciplines.json (or one naming an unknown seat): the console runs as usual, only multi-sided projects are off and say why.
let DISC; try { DISC = loadDisciplines(DISCIPLINES_FILE, SEATS); } catch (e) { DISC = { map: {}, owner: Object.keys(SEATS)[0], off: e.code === 'ENOENT' ? 'copy console/disciplines.example.json to console/disciplines.json to turn multi-sided projects on' : e.message }; console.log('[multi] off: ' + DISC.off); }
// ---- Ideas inbox (ideas.mjs): captures from the page and Telegram, transcribed by the local Whisper worker, briefed by a cheap claude -p run on
// the "Ideas processor" seat (Settings > Ideas, default: the first Claude seat), listed on #ideas. Private data: ideas.jsonl + ideas-media/ (gitignored). ----
const IDEAS_FILE = path.join(DATA, 'ideas.jsonl'), IDEAS_MEDIA = path.join(DATA, 'ideas-media'), IDEAS_STAGED = path.join(IDEAS_MEDIA, '_staged');
const IDEAS_MODEL = 'claude-haiku-5-5', IDEAS_VOICE_MODEL = 'large-v3-turbo';   // no one waits for a voice note: the slower model that spells Hebrew better
// The cheapest call that does the job: Haiku, low effort, no tools, no MCP, no settings/hooks/CLAUDE.md, nothing saved (measured: ~550 tokens of overhead).
// A seat at its limit (5-hour or weekly window full) is not asked: the idea waits for the reset; a limit hit mid-call waits the same way.
async function ideasLlm(prompt) {
  const seat = SET().ideasSeat || Object.keys(SEATS).find((n) => !SEATS[n].agent);
  if (!hasKey(SEATS, seat) || SEATS[seat].agent) throw new Error(`Ideas processor seat "${seat}" is not a Claude seat (Settings > Ideas)`);
  const full = Object.values(state.usage[seat]?.windows || {}).find((w) => w.utilization >= 1 && w.resetsAt * 1000 > Date.now());
  if (full) throw Object.assign(new Error(`${seat} is at its usage limit`), { quota: true, until: full.resetsAt * 1000 + 60000 });
  await initSeat(seat);
  const args = [...CLAUDE_CMD.slice(1), '-p', '--output-format', 'json', '--model', IDEAS_MODEL, '--effort', 'low', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--system-prompt', 'You turn a captured idea into a work brief. Output exactly one JSON object, nothing else.'];
  const out = await new Promise((ok, no) => { const p = execFile(CLAUDE_CMD[0], args, { cwd: os.tmpdir(), env: { ...cleanEnv(), CLAUDE_CONFIG_DIR: path.join(HOME, '.claude-seats', seat) }, timeout: 180000, maxBuffer: 8e6 }, (e, so, se) => (e && !so ? no(new Error('claude -p failed: ' + String(se || e.message).slice(0, 300))) : ok(so))); p.stdin.on('error', () => {}); p.stdin.end(prompt); });
  let j; try { j = JSON.parse(out); } catch { throw new Error('claude -p gave no JSON result'); }
  if (j.is_error) { const m = String(j.result || j.subtype || 'error'); throw Object.assign(new Error(m.slice(0, 300)), /limit|quota|rate/i.test(m) ? { quota: true, until: Date.now() + 30 * 60000 } : {}); }
  console.log(`[ideas] brief made on ${seat}: ${j.usage?.input_tokens ?? '?'}+${j.usage?.cache_creation_input_tokens ?? 0}+${j.usage?.cache_read_input_tokens ?? 0} in, ${j.usage?.output_tokens ?? '?'} out, $${(j.total_cost_usd ?? 0).toFixed(4)}`);
  return String(j.result || '');
}
async function ideasTranscribe(file) {
  try { return (await voice.transcribe(fs.readFileSync(file), { model: IDEAS_VOICE_MODEL, lang: SET().voiceLang })).text; }
  catch (e) { if (e.code === 'BUSY') throw Object.assign(new Error('voice worker busy'), { quota: true, until: Date.now() + 60000 }); throw e; }   // the mic is using it: try again in a minute
}
async function ideasRelated(keywords) {   // earlier conversations about the same thing: the sidebar search index, one keyword at a time
  const all = [...Object.values(state.conversations), ...Object.values(state.remoteConvs)]; await search.refresh(all, { wait: false });
  const seen = new Map();
  for (const k of keywords) for (const h of search.query(k, all, 5)) if (!seen.has(h.id)) { const c = viewOf(h.id), v = c && viewSummary(c); if (v) seen.set(h.id, { id: h.id, title: v.title, seat: v.seat }); }
  return [...seen.values()];
}
const ideaUrl = (id) => `${PHONE}/#ideas/${id}`;
const ideas = createIdeas({ file: IDEAS_FILE, mediaDir: IDEAS_MEDIA, transcribe: ideasTranscribe, llm: ideasLlm, related: ideasRelated, folders: () => projectFolders(), disciplines: () => DISC, log: console.log,
  onChange: () => sendAll({ ideas: true }),
  onReady: async (x) => {   // a Telegram capture: its "💡 Saved" message gets the title and an Open button
    if (!x.tgMsg) return;
    await tg.edit(x.tgMsg, `💡 ${t('bot.idea.savedTitle')} <b>${esc(x.brief.title)}</b>${x.brief.projectName ? ` · <i>${esc(x.brief.projectName)}</i>` : ''}`, [[{ text: '↗ ' + t('bot.idea.open'), url: ideaUrl(x.id) }]]).catch((e) => console.log('[ideas] telegram edit failed: ' + e.message));
  } });
setTimeout(() => ideas.kick(), 5000);   // what was captured or half done before a restart
const ideaFromTelegram = ({ text, audio, photos, tgMsg }) => ideas.capture({ src: 'telegram', text, audio, photos, tgMsg });
// Once a day (Settings > Ideas: time, how old), never 23:00-07:00: the ready ideas nobody looked at, one Open button each.
async function ideasDigestTick(now = Date.now()) {
  if (!tg.readCfg()?.chatId) return;
  const due = digestDue({ now, last: state.ideasDigestAt || 0, at: SET().ideasDigestAt, staleH: SET().ideasStaleH, ideas: ideas.list() }); if (!due) return;
  state.ideasDigestAt = now; saveState();   // first: a failed send is not repeated every minute
  const list = due.slice(0, 8);
  await tg.send(`💡 <b>${t('bot.idea.digest', { n: due.length })}</b>\n` + list.map((x) => `• ${esc(x.brief?.title || '')}${x.brief?.projectName ? ` · <i>${esc(x.brief.projectName)}</i>` : ''}`).join('\n'),
    list.map((x) => [{ text: '↗ ' + String(x.brief?.title || x.id).slice(0, 40), url: ideaUrl(x.id) }])).catch(notifyFailed);
}
setInterval(() => ideasDigestTick().catch((e) => console.log('[ideas] digest failed: ' + e.message)), 60000);
const multiOff = () => (!SET().multiProjects ? 'turned off in Settings' : DISC.off);
const multiOn = () => { if (multiOff()) throw new Error('multi-sided projects are off: ' + multiOff()); return multi; };
// The Claude models a task may name: the main list of the page's model menu (keep in step with public/index.html select#model).
const CLAUDE_MODELS = [{ id: 'claude-opus-5-5', name: 'Opus 5.5 (strongest)' }, { id: 'claude-fable-5-2', name: 'Fable 5.2' }, { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5 (balanced)' }, { id: 'claude-haiku-5-5', name: 'Haiku 5.5 (fast, cheap)' }];
let modelsSnap = {};
const multi = createMulti({ state, save: saveState, broadcast: () => broadcast({ multi: true }), deps: {
  map: DISC.map, owner: DISC.owner, seats: SEATS, root: DEFAULT_CWD, windows: (seat) => state.usage[seat]?.windows, log: console.log,
  send: (b) => send({ ...b, auto: true }).then((c) => { if (c.unknownDue && /UNKNOWN OUTCOME/.test(b.text)) { c.unknownDue = undefined; saveState(); } return c; }),   // a task message that carried the open intents: the user's next one need not repeat them
  models: () => modelsSnap,   // per seat, what the planner may pick from for each task (refreshModels below)
  unknown: (convId, prev) => [...(convId ? openOf(convId) : []), ...openElsewhere(prev)],   // a task's open intents (journal.mjs): its own conversation's + those of the earlier ones it replaced
  unknownCount: (ids) => ids.filter(Boolean).reduce((n, id) => n + openOf(id).length, 0),
  ctxPct: (id) => { const c = convOf(id); return c ? ctxView(c)?.pct ?? null : null; },   // token economy: how full a task's context window is
  freshAtPct: () => SET().projectsFreshAtPct ?? 40,
  idle: (id) => { const c = convOf(id); return !!c && !c.working && !c.turns && R(c).status !== 'working' && !R(c).perms.size; },
  notify: (p, kind) => {
    const head = { 'plan-ready': '🧩 ' + t('bot.multi.planReady'), integrating: '🧩 ' + t('bot.multi.integrating'), done: '✅ ' + t('bot.multi.done'), 'integrate-error': '⚠️ ' + t('bot.multi.integrateError') }[kind] || kind;
    const lines = [`<b>${head}</b> · <i>${esc(p.name)}</i>`, `<code>${esc(p.dir)}</code>`, ...p.tasks.map((t) => `• ${esc(t.id)} → <b>${esc(t.seat)}</b> (${esc(t.discipline)})${t.deps.length ? ' ⟵ ' + esc(t.deps.join(', ')) : ''}`), `${PHONE}/#multi-${p.id}`];
    tg.send(lines.join('\n'), kind === 'plan-ready' ? [[{ text: '✅ ' + t('bot.multi.approve'), callback_data: `x:${p.id}` }]] : null).catch(notifyFailed);
  },
} });

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
  const evening = kind === 'evening', { since, routinesAt } = digestRefs(kind, now, slot), sinceLabel = hm(since, DIGEST_TZ);
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
  const now = Date.now(), slot = digestBusy || now < digestNextTry || !SET().digests ? null : dueSlot(state, now); if (!slot) return;
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
// Build id shown on the page (Guide footer) and sent on every event stream: the page compares it with its own and offers a reload after a restart
// with new code. Commit short hash + a hash of the page files, so uncommitted page edits count as a new build too.
const BUILD = (() => { let g = 'nogit'; try { g = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: HERE, encoding: 'utf8', timeout: 5000 }).trim(); } catch {}
  const h = crypto.createHash('sha1'); for (const f of ['index.html', 'app.js', 'app.css', 'tour.js', 'smartfinish.js', 'rolling.js', 'desktop.js']) try { h.update(fs.readFileSync(path.join(HERE, 'public', f))); } catch {}
  return `${g}.${h.digest('hex').slice(0, 4)}`; })();
// Optional diagnostics (the page side is OFF by default, DIAG_UNTIL = 0 in app.js): what a phone's composer receives, one JSON line per event,
// no message text. data/client-log.jsonl keeps the newest 500 lines. Remove with the page's DIAG block once the question is answered.
const CLIENT_LOG = path.join(DATA, 'data', 'client-log.jsonl');
function clientLog(b, req) {
  const evs = (Array.isArray(b.events) ? b.events : []).slice(0, 50).map((e) => JSON.stringify({ at: Date.now(), ua: String(req.headers['user-agent'] || '').slice(0, 200), ...e }).slice(0, 4000));
  if (!evs.length) return 0;
  fs.mkdirSync(path.dirname(CLIENT_LOG), { recursive: true });
  let old = []; try { old = fs.readFileSync(CLIENT_LOG, 'utf8').split('\n').filter(Boolean); } catch {}
  fs.writeFileSync(CLIENT_LOG, old.concat(evs).slice(-500).join('\n') + '\n'); return evs.length;
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
// Same, gzipped when the browser accepts it and the body is worth it (a phone over Tailscale pays per byte).
function sendZ(req, res, code, type, body) {
  const buf = Buffer.from(body), head = { 'Content-Type': type, 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  if (buf.length < 1024 || !/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { head['Content-Length'] = buf.length; res.writeHead(code, head); return res.end(buf); }
  zlib.gzip(buf, { level: 5 }, (e, z) => { if (e) { res.writeHead(500); return res.end(); } head['Content-Encoding'] = 'gzip'; head['Content-Length'] = z.length; res.writeHead(code, head); res.end(z); });
}
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/paths.js': ['paths.js', 'text/javascript; charset=utf-8'], '/smartfinish.js': ['smartfinish.js', 'text/javascript; charset=utf-8'], '/rolling.js': ['rolling.js', 'text/javascript; charset=utf-8'], '/imgedit.js': ['imgedit.js', 'text/javascript; charset=utf-8'], '/tour.js': ['tour.js', 'text/javascript; charset=utf-8'], '/desktop.js': ['desktop.js', 'text/javascript; charset=utf-8'],
  // installable app (PWA): the manifest, its icons and the service worker must be same-origin for Chrome/Edge "Install app"
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'], '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/icon-192.png': ['icon-192.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'], '/icon-maskable-512.png': ['icon-maskable-512.png', 'image/png'], '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'] };
for (const c of Object.keys(LANGS)) STATIC[`/locales/${c}.json`] = [`locales/${c}.json`, 'application/json; charset=utf-8'];   // the page's strings (i18n.mjs)
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

// ---- "Tell me when a new version is out" (updatecheck.mjs, Settings > Start): the first look 30 s after the start, then every 24 h; the page hears of it by SSE ----
const updater = createUpdateCheck({ cwd: path.resolve(HERE, '..'), enabled: () => !!SET().updateCheck, log: (m) => console.log(m), onChange: (v) => sendAll({ update: v }) });
setTimeout(() => updater.check(), 30e3).unref(); setInterval(() => updater.check(), 864e5).unref();
// ---- Settings page (settings.mjs): what is turned on, what this machine has, and the config edits. Detection is cached 60 s and never reads a credential's content. ----
const readJsonFile = (f, empty) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch (e) { if (e.code === 'ENOENT') return empty; throw new Error(`${path.basename(f)} cannot be read: ${e.message}`); } };
const runOut = (bin, args, env) => new Promise((ok) => { const js = /\.m?js$/.test(bin);   // a .mjs CODEX_BIN (test fake) runs under this node
  execFile(js ? process.execPath : bin, js ? [bin, ...args] : args, { encoding: 'utf8', timeout: 15000, windowsHide: true, shell: WIN && !js, env: { ...process.env, ...env } },   /* shell on Windows: npm's codex.cmd (fixed arguments only) */ (e, out) => ok(e ? null : String(out).trim() || 'ok')); });
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const seatDir = (n) => path.join(HOME, '.claude-seats', n);
// Signed in = the seat's credentials file exists, or (macOS: the login sits in the Keychain) its .claude.json names an account. Only presence is checked.
const claudeLogin = (n) => fs.existsSync(path.join(seatDir(n), '.credentials.json')) || (() => { try { return !!JSON.parse(fs.readFileSync(path.join(seatDir(n), '.claude.json'), 'utf8')).oauthAccount; } catch { return false; } })();
const agyLogin = (env) => fs.existsSync(path.join(env.HOME || HOME, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'));
const homeOf = (h) => h && path.resolve(String(h).replace(/^~(?=[\\/]|$)/, HOME));
const loginCmd = (name, seat) => !seat.agent ? (WIN ? `powershell -ExecutionPolicy Bypass -File .\\seat.ps1 ${name} -Login` : `./seat.sh ${name} --login`)
  : !WIN ? `console/agents/login.sh ${name}` : seat.agent === 'codex' ? `${seat.home ? `$env:CODEX_HOME="${homeOf(seat.home)}"; ` : ''}codex login --device-auth` : 'agy';
let detectCache = null;
async function detect() {
  if (detectCache && Date.now() - detectCache.at < 60e3) return detectCache.v;
  const cfg = readJsonFile(SEATS_FILE, { seats: {} }), seats = cfg.seats || {};
  const codexVer = await runOut(CODEX_BIN, ['--version']);
  const env = (s) => (!s.home ? {} : s.agent === 'codex' ? { CODEX_HOME: homeOf(s.home) } : { HOME: homeOf(s.home) });
  const signedIn = async (s) => (s.agent === 'codex' ? !!codexVer && (await runOut(CODEX_BIN, ['login', 'status'], env(s))) !== null : s.agent === 'agy' ? agyLogin(env(s)) : false);
  const list = await Promise.all(Object.entries(seats).map(async ([name, s]) => ({ name, email: s.email || '', role: s.role || '', agent: s.agent || null, home: s.home || null, active: hasKey(SEATS, name),
    signedIn: s.agent ? await signedIn(s) : claudeLogin(name), login: loginCmd(name, s), conversations: Object.values(state.conversations).filter((c) => c.seat === name).length })));
  const v = { seats: list, codex: { installed: codexVer, signedIn: !!codexVer && (await runOut(CODEX_BIN, ['login', 'status'])) !== null, login: 'codex login --device-auth' },
    agy: { installed: fs.existsSync(AGY_BIN), signedIn: agyLogin({}), login: 'agy' },
    disciplines: fs.existsSync(DISCIPLINES_FILE), supervisor: !!process.env.SEAT_CONSOLE_SUPERVISOR };
  detectCache = { at: Date.now(), v }; return v;
}
let botName = null;   // { token, name }: the bot's @username from getMe, asked once per token
async function telegramView() {
  const cfg = tg.readCfg();
  if (cfg && botName?.token !== cfg.botToken) {
    botName = { token: cfg.botToken, name: null };
    try { const r = await fetch(`https://api.telegram.org/bot${cfg.botToken}/getMe`, { signal: AbortSignal.timeout(10000) }); botName.name = (await r.json())?.result?.username || null; } catch {}
  }
  let code = null; try { code = fs.readFileSync(path.join(DATA, 'telegram-link-code.txt'), 'utf8').trim(); } catch {}
  return { configured: !!cfg, linked: !!cfg?.chatId, bot: cfg ? botName.name : null, linkCode: cfg && !cfg.chatId ? code : null, polling: !ISOLATED };
}
async function settingsView() {
  const problems = [settingsNow.error], safe = (fn, empty) => { try { return fn(); } catch (e) { problems.push(e.message); return empty; } };   // a broken config file is shown, never a broken page
  const disc = safe(() => readJsonFile(DISCIPLINES_FILE, null), null), rr = safe(() => readJsonFile(ROUTINES_FILE, []), []), rlist = Array.isArray(rr) ? rr : rr?.routines || [];
  const rem = safe(() => readJsonFile(REMOTES_FILE, { remotes: [] }), {})?.remotes;
  return { settings: SET(), firstRun: settingsNow.firstRun, restartNeeded, update: updater.view(), detected: await detect(), telegram: await telegramView(),
    access: { user: AUTH.user, phone: PHONE, tailscale: { ip: tsIp, name: tsName, warn: tsWarn }, test: ISOLATED },
    disciplines: disc ? { owner: disc.owner, disciplines: disc.disciplines || {}, off: DISC.off || null } : null,
    routines: routines.view().map((r) => ({ ...r, prompt: rlist.find((x) => x?.id === r.id)?.prompt ?? null })),
    remotes: (Array.isArray(rem) ? rem : []).map((r) => ({ ...r, active: REMOTES.some((x) => x.name === r.name), down: remoteDown.has(r.name) })),
    models: Object.fromEntries(Object.keys(SEATS).map((n) => [n, modelsSnap[n] || []])), languages: LANGS, error: problems.filter(Boolean).join(' · ') || null };
}
// The request must come from this console's own page (Referer or Origin): /api/file and /api/restart.
const fromPage = (req) => { let o = null; try { o = new URL(req.headers.referer || req.headers.origin || '').origin; } catch {} return !!o && ALLOWED_ORIGINS.includes(o); };
const changed = (r) => { restartNeeded = true; detectCache = null; return r; };
async function settingsPost(p, b) {
  const need = (a) => { if (!canWrite(a)) throw new Error(`test instance: start it with --${a} <a copy> to edit this file`); };
  if (p === '/api/settings') {
    const v = validateSettings(b.settings, SEATS), next = { ...SET(), ...v }, guideFirst = settingsNow.firstRun && onlyGuide(v);   // the tour answer alone is not a first save
    writeJsonAtomic(SETTINGS_FILE, guideFirst ? { ...readJsonFile(SETTINGS_FILE, {}), ...v } : next); settingsNow = { settings: next, firstRun: guideFirst, error: null };   // first run: only guideOffered goes to disk, so a restart still sees a first run
    console.log('[settings] saved: ' + Object.keys(v).join(', '));
    if ('updateCheck' in v) updater.check();   // switched on: look now; off: the notice goes away
    return { ok: true, restartNeeded };
  }
  if (p === '/api/settings/add-seat') {
    need('seats'); const name = String(b.name || ''), cfg = addSeat(readJsonFile(SEATS_FILE, { seats: {} }), { agent: b.agent === 'claude' ? '' : String(b.agent || ''), name, email: String(b.email || ''), role: String(b.role || '') });
    writeJsonAtomic(SEATS_FILE, cfg); console.log(`[settings] seat ${name} added`);
    return changed({ ok: true, restartNeeded: true, login: loginCmd(name, cfg.seats[name]), home: cfg.seats[name].home || null });
  }
  if (p === '/api/settings/remove-seat') {
    need('seats'); const name = String(b.name || ''), disc = readJsonFile(DISCIPLINES_FILE, null), rts = readJsonFile(ROUTINES_FILE, []);
    const n = Object.values(state.conversations).filter((c) => c.seat === name).length, blockers = [
      ...(n ? [`${n} conversation${n > 1 ? 's' : ''} (delete them first; archived ones count too)`] : []),
      ...(disc && (disc.owner === name || Object.values(disc.disciplines || {}).includes(name)) ? ['multi-sided projects (disciplines)'] : []),
      ...((Array.isArray(rts) ? rts : rts.routines || []).some((r) => r.seat === name) ? ['a routine'] : []),
      ...((readJsonFile(REMOTES_FILE, { remotes: [] }).remotes || []).some((r) => r.account === name) ? ['a remote uses its account'] : [])];
    writeJsonAtomic(SEATS_FILE, removeSeat(readJsonFile(SEATS_FILE, { seats: {} }), name, blockers)); console.log(`[settings] seat ${name} removed`);
    return changed({ ok: true, restartNeeded: true });
  }
  if (p === '/api/settings/disciplines') {
    need('disciplines'); const old = readJsonFile(DISCIPLINES_FILE, {});
    writeJsonAtomic(DISCIPLINES_FILE, { ...old, ...checkDisciplines({ owner: String(b.owner || ''), disciplines: b.disciplines }, SEATS) });
    return changed({ ok: true, restartNeeded: true });
  }
  if (p === '/api/settings/routine') {   // add or edit; the scheduler re-reads routines.json on its next tick (no restart)
    need('routines'); const raw = readJsonFile(ROUTINES_FILE, []), list = Array.isArray(raw) ? raw : raw.routines || [];
    const next = saveRoutine(list, { id: String(b.id || ''), seat: String(b.seat || ''), cron: String(b.cron || ''), cwd: String(b.cwd || ''), prompt: typeof b.prompt === 'string' ? b.prompt : '', mode: String(b.mode || '') }, SEATS);
    writeJsonAtomic(ROUTINES_FILE, Array.isArray(raw) ? next : { ...raw, routines: next });   // a wrapped file keeps its wrapper
    return { ok: true, restartNeeded };
  }
  if (p === '/api/settings/remote') {
    const raw = readJsonFile(REMOTES_FILE, { remotes: [] }), list = raw.remotes || [];
    if (b.action === 'test') {   // one `ssh <target> echo ok` with the console's own ssh options (BatchMode: never a password prompt)
      const r = parseRemotes({ remotes: list.filter((x) => x.name === b.name) }, HOME, () => {})[0]; if (!r) throw new Error('unknown or invalid remote');
      const x = await rhost.sshRun(r, 'echo ok', { timeout: 20000, max: 4096 });
      return { ok: x.code === 0, text: x.code === 0 ? 'ssh works' : `ssh failed (exit ${x.code}): ${String(x.err || '').slice(-300)}` };
    }
    need('remotes');
    if (b.action === 'add') writeJsonAtomic(REMOTES_FILE, { ...raw, remotes: addRemote(list, { name: String(b.name || ''), target: String(b.target || ''), identity: String(b.identity || ''), control: !!b.control, account: b.account ? String(b.account) : '',
      paths: String(b.paths || '').split(/[\s,]+/).filter(Boolean) }, SEATS, HOME) });
    else if (b.action === 'remove') { if (!list.some((x) => x.name === b.name)) throw new Error('unknown remote'); writeJsonAtomic(REMOTES_FILE, { ...raw, remotes: list.filter((x) => x.name !== b.name) }); }
    else throw new Error('unknown action');
    return changed({ ok: true, restartNeeded: true });
  }
  if (p === '/api/settings/telegram') {
    if (b.action === 'test') { const m = await tg.send('✅ ' + t('bot.server.testMessage')); if (!m) throw new Error(tg.readCfg() ? 'the chat is not linked yet' : 'no bot token yet'); return { ok: true }; }
    if (ISOLATED) throw new Error('test instance: Telegram is off here');
    const cfg = telegramToken(readJsonFile(TELEGRAM_FILE, {}), String(b.token || '').trim());
    fs.mkdirSync(path.dirname(TELEGRAM_FILE), { recursive: true }); writeJsonAtomic(TELEGRAM_FILE, cfg, 0o600); console.log('[settings] telegram bot token saved');
    return { ok: true };
  }
  if (p === '/api/settings/password') {
    if (ISOLATED) throw new Error('test instance: the page login is the real one, change it there');
    if (!same(String(b.current || ''), AUTH.password)) throw new Error('the current password is wrong');
    const next = String(b.next || ''); if (next.length < 12 || next.length > 200 || /[:\s]/.test(next)) throw new Error('new password: 12-200 characters, no spaces or ":"');
    writeJsonAtomic(AUTH_FILE, { ...AUTH, password: next }, 0o600); AUTH = { ...AUTH, password: next }; AUTH_HEADER = basic(AUTH);
    console.log('[settings] page password changed'); return { ok: true };
  }
  return null;
}
const EVENT_PAGE = 500;
let serveSeen = false;   // the [serve] header-names line is logged once per server start
// Free limit resets a seat's own account holds: count + each one's title and expiry (ids are only echoed back on a tap).
const resetsOn = (seat) => (SEATS[seat]?.agent === 'codex' ? SET().codexResets : !SEATS[seat]?.agent && SET().claudeResets);   // Settings: no reset UI for a kind that is off
const resetsView = (seat) => { const r = resetsOn(seat) && state.resets?.[seat]; return r ? { available: r.available, nextExpiry: r.credits?.[0]?.expiresAt || null, title: r.credits?.[0]?.title || null, list: (r.credits || []).map((c) => ({ id: c.id, title: c.title, label: c.label || null, expiresAt: c.expiresAt, usableNow: c.usableNow !== false })), usable: SEATS[seat]?.agent === 'codex' || (!SEATS[seat]?.agent && !!r.credits?.some((c) => c.usableNow)) } : null; };
const seatsView = () => [...Object.keys(SEATS).map((name) => ({ name, email: SEATS[name].email, role: SEATS[name].role, agent: SEATS[name].agent || null, resets: resetsView(name), cwd: state.cwds[name] || DEFAULT_CWD,
  usage: state.usage[name] || null, conversations: Object.values(state.conversations).filter((c) => c.seat === name).sort((a, b) => b.updatedAt - a.updatedAt).map(summary) })),
  // remote groups after the seats: read-only runs (no "+ new"); the role line carries "unreachable since HH:MM" while ssh fails.
  // control: true adds "+ new" (`control`) and lists the conversations started there next to the runs (viewSummary tells them apart).
  ...REMOTES.map((r) => ({ name: groupOf(r.name), email: r.target, role: (remoteDown.has(r.name) ? downText(r.name) + ' · ' : '') + (r.control ? 'control' : 'read-only') + (r.seat ? ' · ' + r.seat : ''), remote: true, control: r.control, cwd: null, account: r.account, usage: (r.account && state.usage[r.account]) || null,   /* a remote with 'account' shows that seat's meter */
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
      if (!fromPage(req)) return json(res, 403, { error: 'file previews are served to the console page only' });
      return await serveFile(req, res, url);   // await: a throw inside it still ends in the 500 below
    }
    if (url.pathname === '/api/idea-media' && req.method === 'GET') {   // an idea's voice note / photo: to the console page only, like /api/file
      if ((site && site !== 'same-origin' && site !== 'none') || !fromPage(req)) return json(res, 403, { error: 'served to the console page only' });
      const f = ideas.media(url.searchParams.get('id') || '', url.searchParams.get('f') || ''); if (!f) return json(res, 404, { error: 'no such file' });
      const ext = path.extname(f).slice(1).toLowerCase(), type = { webm: 'audio/webm', ogg: 'audio/ogg', oga: 'audio/ogg', mp4: 'audio/mp4', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav' }[ext] || MIME[ext] || 'application/octet-stream';
      const size = fs.statSync(f).size, r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || ''), head = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      if (!size) { res.writeHead(200, { ...head, 'Content-Length': 0 }); return void res.end(); }   // an empty Telegram file: createReadStream(end -1) would throw
      let a = 0, z = size - 1; if (r && (r[1] || r[2])) { a = r[1] ? +r[1] : Math.max(0, size - +r[2]); z = r[1] && r[2] ? Math.min(+r[2], size - 1) : size - 1; if (a > z) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return void res.end(); } }   // phone players seek with Range
      res.writeHead(r && (r[1] || r[2]) ? 206 : 200, { ...head, 'Content-Length': z - a + 1, ...(r && (r[1] || r[2]) ? { 'Content-Range': `bytes ${a}-${z}/${size}` } : {}) });
      return void fs.createReadStream(f, { start: a, end: z }).on('error', () => res.destroy()).pipe(res);
    }
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      const raw = fs.readFileSync(path.join(HERE, 'public', file));
      let body = type.startsWith('image/') ? raw : raw.toString('utf8');   // PNG icons stay bytes: a utf8 round trip corrupts them
      if (file === 'index.html') {   // the language: Settings' choice, else the browser's (Accept-Language), else English; he/ar right-to-left
        const lg = SET().language || pickLang(req.headers['accept-language']);
        body = body.replace('__TOKEN__', TOKEN).replace('__BUILD__', BUILD).replace('__HTTPS__', tsName ? `https://${tsName}` : '').replace('<html lang="en">', `<html lang="${lg}" dir="${RTL.has(lg) ? 'rtl' : 'ltr'}">`);
      }
      return sendZ(req, res, 200, type, body);
    }
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ready: true });
    if (req.method === 'GET' && url.pathname === '/api/desktop') return json(res, 200, desktop.status());   // the Desktop page: is there an xrdp session to show
    // noVNC (the Desktop page's viewer, MPL-2.0, Debian package novnc 1.3.0) served from the system copy: its core/ and vendor/ ES modules only
    if (req.method === 'GET' && /^\/novnc\/(core|vendor)\/[\w./-]+\.js$/.test(url.pathname) && !url.pathname.includes('..')) {
      let js; try { js = fs.readFileSync(path.join('/usr/share/novnc', url.pathname.slice(7))); } catch { return json(res, 404, { error: 'not found' }); }
      return sendZ(req, res, 200, 'text/javascript; charset=utf-8', js);
    }
    if (req.method === 'GET' && url.pathname === '/api/seats') return sendZ(req, res, 200, 'application/json; charset=utf-8', JSON.stringify(seatsView()));
    if (req.method === 'GET' && url.pathname === '/api/routines') return json(res, 200, routines.view());
    if (req.method === 'GET' && url.pathname === '/api/todos') { todoChecks(60000).catch(() => {}); return json(res, 200, todosView()); }   // checks run behind the page load; a close reloads it by SSE
    if (req.method === 'GET' && url.pathname === '/api/skills') {   // the composer's "/" list for one seat; conv = the open chat (its folder's .claude/), cwd = a new chat's folder
      const seat = url.searchParams.get('seat') || '', c = convOf(url.searchParams.get('conv') || '');
      if (!hasKey(SEATS, seat)) return json(res, 200, { skills: [], none: 'remote' });   // a remote group: its claude reads the other machine's folders
      if (SEATS[seat].agent) return json(res, 200, { skills: [], none: SEATS[seat].agent });   // codex / agy adapters pass text through: no slash commands of their own (agents/*.mjs)
      return json(res, 200, { skills: listSkills({ configDir: path.join(HOME, '.claude-seats', seat), shared: path.join(HOME, '.claude'), cwd: c?.cwd || url.searchParams.get('cwd') || '', home: HOME }) });
    }
    if (req.method === 'GET' && url.pathname === '/api/snippets') return json(res, 200, { snippets: readSnippets(SNIPPETS_FILE) });
    if (req.method === 'GET' && url.pathname === '/api/ideas') return json(res, 200, { ideas: ideas.list() });
    if (req.method === 'GET' && url.pathname === '/api/models') {   // the model menu of an agent seat: what THAT CLI offers on its own login (null = the page's Claude list)
      const seat = url.searchParams.get('seat') || '';
      if (!hasKey(SEATS, seat) || !SEATS[seat].agent) return json(res, 200, { models: null });
      try { return json(res, 200, { models: await agentModels(seat) }); } catch (e) { return json(res, 200, { models: [], error: String(e.message || e) }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/detect-project') {   // the composer's project chip: which folder a new chat with this first message opens in (same rule as send())
      const dir = detectProject(url.searchParams.get('text') || '', projectFolders()), f = dir && projectFolders().find((x) => path.resolve(x.dir) === dir);
      return json(res, 200, { dir, name: f ? f.name : null });
    }
    if (req.method === 'GET' && url.pathname === '/api/project') {   // one project's page: conversations, runs, git, HANDOFF head. Only folders the Projects page lists.
      const folders = projectFolders(), projects = multi.view(), dirs = [...new Set([...folders.map((f) => path.resolve(f.dir)), ...projects.map((p) => path.resolve(p.dir))])];
      const dir = allowedDir(url.searchParams.get('dir'), dirs); if (!dir) return json(res, 404, { error: 'not a project folder' });
      const hits = convHits(dir, dirs), live = hits.filter((c) => !c.archived), arch = hits.filter((c) => c.archived), f = folders.find((x) => path.resolve(x.dir) === dir);
      const view = (c) => { const v = summary(c); return { id: v.id, title: v.title, seat: v.seat, status: v.status, cost: v.cost, updatedAt: v.updatedAt, archived: v.archived, need: needOf(v) }; };
      await freshTouched();
      const rel = (relatedIndex(dirs).get(dir) || []).sort((x, y) => y.w - x.w || y.c.updatedAt - x.c.updatedAt);   // most edits first, then the most recent
      return json(res, 200, { name: f?.name || path.basename(dir), dir, mtime: f?.mtime || 0, git: await gitInfo(dir), convs: live.map(view), archived: arch.slice(0, 50).map(view), archivedCount: arch.length, related: rel.slice(0, 40).map((x) => ({ ...view(x.c), w: x.w, r: x.r })), relatedCount: rel.length, runs: projects.filter((p) => path.resolve(p.dir) === dir), handoff: handoffHead(dir) });
    }
    if (req.method === 'GET' && url.pathname === '/api/multi') {   // off in Settings: the sidebar entry hides once nothing is left running
      const projects = multi.view(), folders = projectFolders(), dirs = [...new Set([...folders.map((f) => path.resolve(f.dir)), ...projects.map((p) => path.resolve(p.dir))])];
      await freshTouched(); const rel = relatedIndex(dirs), opened = new Map();
      for (const c of Object.values(state.conversations)) { const d = !c.archived && convProject(c, dirs); if (d) (opened.get(d) || opened.set(d, []).get(d)).push(c); }
      return json(res, 200, { projects: projects.map((p) => ({ ...p, ...folderBrief(path.resolve(p.dir), opened, rel) })), disciplines: DISC.map, owner: DISC.owner, off: multiOff() || null, hidden: !SET().multiProjects, folders: folders.map((f) => ({ ...f, ...folderBrief(path.resolve(f.dir), opened, rel) })) });
    }
    if (req.method === 'GET' && url.pathname === '/api/settings') return json(res, 200, await settingsView());
    if (req.method === 'GET' && url.pathname === '/api/digest') return json(res, 200, digestMessage(Date.now(), url.searchParams.get('kind') === 'evening' ? 'evening' : 'morning'));   // the digest text + buttons, nothing is sent
    if (req.method === 'GET' && url.pathname === '/api/conversation') {
      const c = viewOf(url.searchParams.get('id')); if (!c) return json(res, 404, { error: 'no conversation' });
      // The last EVENT_PAGE events (a long conversation would otherwise ship megabytes on every open); ?before=<index> returns the page before that index.
      const pending = [...R(c).perms.keys()], before = url.searchParams.has('before') ? +url.searchParams.get('before') || 0 : null;
      const w = eventWindow(eventsOf(c), pending, before, EVENT_PAGE, (e) => slimEvent(e, 0) !== null);
      return sendZ(req, res, 200, 'application/json; charset=utf-8', JSON.stringify({ conv: viewSummary(c), events: slimEvents(w.events, w.from), pending, from: w.from, total: w.total }));
    }
    if (req.method === 'GET' && url.pathname === '/api/tool') {   // full input/output of one tool row, fetched when it is expanded
      const c = viewOf(url.searchParams.get('conv')); if (!c) return json(res, 404, { error: 'no conversation' });
      const d = await toolDetailFull(c, url.searchParams.get('id') || ''); if (!d) return json(res, 404, { error: 'no such tool call' });
      return sendZ(req, res, 200, 'application/json; charset=utf-8', JSON.stringify(d));
    }
    if (req.method === 'GET' && url.pathname === '/api/search') {   // ?q=words: every word in the title or the chat text, archived ones included
      const all = [...Object.values(state.conversations), ...Object.values(state.remoteConvs)];
      const partial = !(await search.refresh(all, { wait: false })) || search.building();
      const hits = search.query(url.searchParams.get('q') || '', all).map((h) => { const c = viewOf(h.id), v = c && viewSummary(c); return v && { ...h, seat: v.seat, title: v.title, archived: !!v.archived, status: v.status, keep: !!v.keep }; }).filter(Boolean);
      return json(res, 200, { hits, partial });
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
      out.write(': hi\n\n'); out.write(`data: ${JSON.stringify({ build: BUILD })}\n\n`);   // the page offers a reload when this differs from its own
      // Tells the page how many events exist now: one it missed between its snapshot read and this registration shows up as hello.total > snapshot.total (the client resyncs).
      // The log of a conversation not opened since the start is read async (loadLogAsync, like reattachAll): a sync read of a 60 MB log blocked every client.
      // Registered (clients.add) only after the count, as before: an event emitted while it loads is in the total, so the page sees hello.total > snapshot and resyncs.
      const wc = out.watch && viewOf(out.watch), total = wc ? (await loadLogAsync(wc)).length : 0;
      if (req.socket.destroyed || res.destroyed) { if (gz) out.destroy(); return; }   // the page left while the log loaded
      if (wc) out.write(`data: ${JSON.stringify({ hello: true, conv: wc.id, total })}\n\n`);
      if (saveError) out.write('data: {"saveError":true}\n\n');
      if (updater.view().update) out.write(`data: ${JSON.stringify({ update: updater.view() })}\n\n`); clients.add(out);
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
      if (url.pathname === '/api/transcribe') {   // the mic button: raw recorded audio in the body -> { text, lang, ms }. Logs sizes and times only, never the audio or the text.
        if (SET().voice === false) return json(res, 403, { error: 'voice input is off in Settings', code: 'off' });
        if (+req.headers['content-length'] > VOICE_MAX) return json(res, 413, { error: 'recording over 25 MB', code: 'big' });
        let audio; try { audio = await binBody(req, VOICE_MAX); } catch { return json(res, 413, { error: 'recording over 25 MB', code: 'big' }); }
        if (!audio.length) return json(res, 422, { error: 'empty recording', code: 'empty' });
        // ?smart=1: Smart finish (the live dictation's recording, checked after it stops) uses its own model; ?lang=auto lets Whisper detect the language
        const smart = url.searchParams.get('smart') === '1', ql = url.searchParams.get('lang'), from = Math.min(VOICE_MAX_SEC, Math.max(0, +url.searchParams.get('from') || 0) / 1000);   // ?from=ms: only the tail rolling correction left (Smart finish)
        const q = url.searchParams.get('model'), model = VOICE_MODELS.includes(q) ? q : smart ? (SET().voiceSmartModel || SMART_MODELS[0]) : SET().voiceModel;   // ?model= only for the test (small loads fastest)
        const lang = ql === 'auto' ? '' : ql && VOICE_LANGS.includes(ql) ? ql : SET().voiceLang;
        // Smart finish asks Gemini first (Settings > Voice > Smart finish engine); no agy, quota, no capacity, an error or 20 s without an answer = Whisper below
        let fellBack = null;
        // ?engine=whisper (tests) can only keep audio here, never send it to Google against Settings; a tiny clip is left to Whisper's own empty check
        if (smart && url.searchParams.get('engine') !== 'whisper' && SET().voiceSmartEngine === 'gemini' && audio.length >= 2048) {
          try {
            const g = await geminiTranscribe(audio, { agy: SMART_AGY, model: SET().voiceGeminiModel, from });
            console.log(`[voice] ${audio.length} bytes, ${g.ms} ms, ${g.model} smart langs=${g.langs.join('+') || '-'}`);
            return json(res, 200, { text: g.text, lang: g.lang, langs: g.langs, prob: null, engine: 'gemini', ms: g.ms });
          } catch (e) { fellBack = e.code === 'NOAGY' ? 'noagy' : e.code === 'QUOTA' ? 'quota' : e.code === 'BUSY' ? 'busy' : e.code === 'TIMEOUT' ? 'timeout' : e.code === 'EMPTY' ? 'empty' : e.code === 'BLOCKED' ? 'blocked' : 'error'; console.log(`[voice] Gemini failed (${fellBack}): ${String(e.message || e).slice(0, 120)}${url.searchParams.get('engine') === 'gemini' ? '' : ', Whisper instead'}`); }
        }
        // ?engine=gemini: Gemini or nothing (rolling correction already settled this dictation with Whisper; reading it again with Whisper adds nothing)
        if (smart && url.searchParams.get('engine') === 'gemini') return json(res, 503, { error: 'Gemini not available', code: 'nogemini', fallback: fellBack || (SET().voiceSmartEngine === 'gemini' ? 'small' : 'off') });
        try {
          const r = await voice.transcribe(audio, { model, lang, mode: smart && !lang ? 'segments' : '', from });   // Smart finish: each piece of speech in its own language
          console.log(`[voice] ${audio.length} bytes, ${(r.audioMs / 1000).toFixed(1)} s audio, ${r.ms} ms, ${model}${smart ? ' smart' : ''}${lang ? '' : ' auto=' + (r.langs ? r.langs.join('+') || '-' : r.lang)}${r.segments ? ` segs=${r.segments.length}` : ''}`);
          return json(res, 200, { text: r.text, lang: r.lang, prob: r.prob, first: r.first, segments: r.segments, langs: r.langs, engine: 'whisper', fallback: fellBack, ms: r.ms });
        } catch (e) {
          const code = e.code === 'BUSY' ? 'busy' : e.code === 'EMPTY' ? 'empty' : e.code === 'BADAUDIO' ? 'badaudio' : 'failed';
          if (code === 'failed') console.log('[voice] failed: ' + String(e.message || e).slice(0, 200));
          return json(res, code === 'busy' ? 503 : code === 'failed' ? 500 : 422, { error: String(e.message || e), code });
        }
      }
      if (url.pathname === '/api/idea-file') {   // a voice note or photo for an idea being captured on the page: staged here, claimed by /api/idea capture
        const kind = url.searchParams.get('kind') === 'audio' ? 'audio' : 'photo';
        if (+req.headers['content-length'] > VOICE_MAX) return json(res, 413, { error: 'over 25 MB' });
        let buf; try { buf = await binBody(req, VOICE_MAX); } catch { return json(res, 413, { error: 'over 25 MB' }); }
        if (!buf.length) return json(res, 422, { error: 'empty file' });
        fs.mkdirSync(IDEAS_STAGED, { recursive: true, mode: 0o700 });
        for (const n of fs.readdirSync(IDEAS_STAGED)) { try { if (Date.now() - fs.statSync(path.join(IDEAS_STAGED, n)).mtimeMs > 86400000) fs.rmSync(path.join(IDEAS_STAGED, n)); } catch {} }   // abandoned captures
        const e = (/\.([a-z0-9]{1,5})$/i.exec(url.searchParams.get('name') || '') || [])[1]?.toLowerCase(), ext = /^(webm|ogg|oga|opus|m4a|mp4|mp3|wav|jpe?g|png|gif|webp|heic)$/.test(e || '') ? e : kind === 'audio' ? 'webm' : 'jpg';
        const id = `${crypto.randomBytes(8).toString('hex')}-${kind}.${ext}`; fs.writeFileSync(path.join(IDEAS_STAGED, id), buf, { mode: 0o600 });
        return json(res, 200, { ok: true, id });
      }
      const b = await body(req);
      if (url.pathname === '/api/client-log') return json(res, 200, { ok: true, n: clientLog(b, req) });   // optional diagnostics, see clientLog
      if (url.pathname === '/api/restart') {   // Settings "Restart now": the supervisor (run-server.sh / .ps1) starts it again; conversations live in their hosts and are reattached
        if (!fromPage(req)) return json(res, 403, { error: 'only from the console page' });
        console.log('[settings] restart requested from the page'); json(res, 200, { ok: true, supervisor: !!process.env.SEAT_CONSOLE_SUPERVISOR });
        setTimeout(() => process.exit(0), 300); return;
      }
      if (url.pathname.startsWith('/api/settings')) { try { const r = await settingsPost(url.pathname, b); if (r) return json(res, 200, r); } catch (e) { return json(res, 400, { error: String(e.message || e) }); } }
      if (url.pathname === '/api/send') {
        if (typeof b.text !== 'string' || !b.text.trim()) return json(res, 400, { error: 'empty text' });
        // "/compact …" and "/context" typed into the composer take the same idle-only path as the meter's buttons (their replies are not chat).
        const sl = convOf(b.conversationId) && /^\/(context|compact)(?:\s+([\s\S]*))?$/i.exec(b.text.trim());
        if (sl) { try { await runSlash(convOf(b.conversationId), sl[1].toLowerCase(), sl[2]); } catch (e) { return json(res, 409, { error: String(e.message || e) }); } return json(res, 200, { ok: true, conversationId: b.conversationId }); }
        const c = await send(b); return json(res, 200, { ok: true, conversationId: c.id, sessionId: c.sessionId });
      }
      if (url.pathname === '/api/snippets') {   // Settings > Snippets saves the whole list (add, edit, delete, reorder)
        try { const snippets = validateSnippets(b.snippets, Object.keys(SEATS)); writeJsonAtomic(SNIPPETS_FILE, { snippets }, 0o600); return json(res, 200, { ok: true, snippets }); } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
      }
      if (url.pathname === '/api/todo') {   // the owner ticks a task (done, optional comment) or sends a comment on the page
        try { return json(res, 200, { ok: true, ...await todoAct(String(b.id || ''), b.action, b.text) }); } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (url.pathname === '/api/idea') {   // the Ideas page: capture (text + staged files), edit, retry, start a chat, make a task, archive, delete
        try {
          const id = String(b.id || '');
          if (b.action === 'capture') {
            const audio = [], photos = [], used = [], files = b.files ?? [];
            if (!Array.isArray(files) || files.length > 12) throw new Error('files: at most 12 staged ids');
            for (const f of files) {
              const m = /^[0-9a-f]{16}-(audio|photo)\.[a-z0-9]{1,5}$/.exec(String(f)); if (!m) throw new Error('bad file id');
              const p = path.join(IDEAS_STAGED, m[0]); (m[1] === 'audio' ? audio : photos).push({ data: fs.readFileSync(p), name: m[0] }); used.push(p);
            }
            const x = ideas.capture({ src: 'console', text: b.text, audio, photos });
            for (const p of used) fs.rm(p, { force: true }, () => {});   // claimed: never fails the capture
            return json(res, 200, { ok: true, idea: x });
          }
          if (b.action === 'update') return json(res, 200, { ok: true, idea: ideas.update(id, { brief: b.brief, status: b.status, chat: b.chat }) });
          if (b.action === 'retry') return json(res, 200, { ok: true, idea: ideas.retry(id) });
          if (b.action === 'delete') { ideas.del(id); return json(res, 200, { ok: true }); }
          if (b.action === 'start') return json(res, 200, { ok: true, idea: ideas.update(id, { status: 'done', chat: b.chat }) });   // the chat opened from it was sent: done, linked to that chat
          if (b.action === 'todo') {   // "Make task": on My tasks, due in a day (not the hourly nag of a seat's urgent step)
            const x = ideas.get(id); if (!x?.brief) throw new Error('idea not ready');
            const tid = addTodo(TODOS_FILE, null, `💡 ${x.brief.title}${x.brief.prep?.goal ? ': ' + x.brief.prep.goal : ''}`, parseDue('+1d'));
            sendAll({ todos: true }); return json(res, 200, { ok: true, idea: ideas.update(id, { status: 'done', todo: tid }) });
          }
          return json(res, 400, { error: 'unknown action' });
        } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
      }
      if (url.pathname === '/api/retention') {   // test instance only: run the retention pass now (the smoke test checks the archive round trip)
        if (!ISOLATED) return json(res, 403, { error: 'test instance only' });
        return json(res, 200, await retentionRun());
      }
      if (url.pathname === '/api/import') {   // a Claude Code session run outside the console (terminal, SDK) becomes a conversation here: its chat is copied into the log, the next send resumes it
        let file; try { file = fs.realpathSync(String(b.file || '')); } catch { return json(res, 404, { error: 'no such file' }); }
        const root = fs.realpathSync(path.join(HOME, '.claude', 'projects'));
        if (!file.startsWith(root + path.sep) || !file.endsWith('.jsonl')) return json(res, 400, { error: 'not a session transcript' });
        const sid = path.basename(file, '.jsonl'), seat = String(b.seat || '');
        if (!hasKey(SEATS, seat)) return json(res, 400, { error: 'unknown seat' });
        if ([...Object.values(state.conversations), ...Object.values(state.remoteConvs)].some((x) => x.sessionId === sid)) return json(res, 409, { error: 'already in the console' });
        const out = []; let cwd = '', first = '', last = 0;
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          let j; try { j = JSON.parse(line); } catch { continue; }
          if (j.isSidechain || j.isMeta) continue;
          const ts = Date.parse(j.timestamp) || 0; if (ts) last = ts; if (!cwd && j.cwd) cwd = j.cwd;
          const m = j.message, txt = typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) && m.content.every((x) => x.type === 'text') ? m.content.map((x) => x.text).join('\n') : null;
          if (j.type === 'user' && txt != null) { if (/^<(command|local-command)/.test(txt)) continue; first ||= txt; out.push({ type: 'console_user', text: txt, ts }); }
          else if (j.type === 'user' && m) out.push({ type: 'user', message: m, session_id: sid });
          else if (j.type === 'assistant' && m) out.push({ type: 'assistant', message: m, session_id: sid });
        }
        if (!first) return json(res, 400, { error: 'no user message in it' });
        const c = newConversation(seat, { cwd: cwd && fs.existsSync(cwd) ? cwd : DEFAULT_CWD, mode: 'auto' });
        delete state.conversations[c.id]; c.id = sid; c.sessionId = sid; c.started = true; c.imported = file; c.updatedAt = last || fs.statSync(file).mtimeMs;
        fs.mkdirSync(path.dirname(logFile(c)), { recursive: true }); fs.writeFileSync(logFile(c), out.map((e) => JSON.stringify(e)).join('\n') + '\n');
        state.conversations[c.id] = c; R(c).status = 'stopped'; try { setTitle(c, String(b.title || first).replace(/\s+/g, ' ').trim().slice(0, 60)); } catch { c.title = 'Imported session'; }
        saveState(); broadcast({ conv: summary(c) });
        return json(res, 200, { ok: true, conversationId: c.id, events: out.length });
      }
      if (url.pathname === '/api/reset') {   // the user taps "Use" on a seat card: one free limit reset of THAT seat's own account (never another seat's)
        const seat = String(b.seat || ''), creditId = b.creditId ? String(b.creditId) : null;
        if (!hasKey(SEATS, seat) || (SEATS[seat].agent && SEATS[seat].agent !== 'codex')) return json(res, 400, { error: 'this seat has no usable resets' });
        if (!resetsOn(seat)) return json(res, 400, { error: 'limit resets are turned off in Settings' });
        if (creditId && !state.resets?.[seat]?.credits?.some((c) => c.id === creditId)) return json(res, 400, { error: 'that reset is not on this seat' });
        if (SEATS[seat].agent && sharedLogin(seat)) return json(res, 409, { error: `${seat} shares its login with another seat: give each one its own "home" in seats.json first` });
        if (resetBusy.has(seat)) return json(res, 409, { error: 'a reset is already running for this seat' });
        resetBusy.add(seat);   // one claim at a time per seat: a double tap or a second tab cannot spend two
        try {
        if (!SEATS[seat].agent) {   // a Claude seat: claim, then read its usage again so the meter and the count are fresh
          const before = state.resets?.[seat]?.available ?? 0;
          try {
            const j = await claimClaudeReset(seat, creditId || undefined); console.log(`[reset] ${seat}: claude limit reset -> ${j.result}${j.reason ? ' (' + j.reason + ')' : ''}`);
            await pollUsage();   // always re-read after a 2xx: the count on the card is the truth, whatever word `result` uses
            const after = state.resets?.[seat]?.available ?? 0;
            if (after >= before) return json(res, 409, { error: `the reset was not used (${j.result || 'no result'}${j.reason ? ' - ' + j.reason : ''})`, resets: resetsView(seat) });
            return json(res, 200, { ok: true, resets: resetsView(seat), windows: state.usage[seat]?.windows });
          } catch (e) { return json(res, 502, { error: String(e.message || e) }); }
        }
        try {
          await consumeCodexReset(creditId || state.resets?.[seat]?.credits?.[0]?.id, { env: agentEnv(seat), key: seat });
          console.log(`[reset] ${seat}: one limit reset used`);
          const a = await readCodexAccount({ env: agentEnv(seat) }); state.usage[seat] = { windows: a.windows, at: Date.now() }; (state.resets ||= {})[seat] = { ...a.resets, at: Date.now() }; saveState();
          broadcast({ usage: { seat, ...state.usage[seat] } }); broadcast({ resets: { seat, ...resetsView(seat) } });
          return json(res, 200, { ok: true, resets: resetsView(seat), windows: a.windows });
        } catch (e) { return json(res, 502, { error: String(e.message || e) }); }
        } finally { resetBusy.delete(seat); }
      }
      if (url.pathname === '/api/multi') {   // multi-sided project: create (name, brief, dir, owner) | approve (id) | retry (id, task)
        try {
          const p = b.action === 'create' ? multiOn().create({ name: b.name, brief: b.brief, dir: b.dir, owner: b.owner || undefined })
            : b.action === 'approve' ? multi.approve(String(b.id)) : b.action === 'cancel' ? multi.cancel(String(b.id)) : b.action === 'retry' ? multi.retry(String(b.id), b.task ? String(b.task) : undefined) : null;
          if (!p) return json(res, 400, { error: 'unknown action' });
          return json(res, 200, { ok: true, id: p.id });
        } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
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
      if (url.pathname === '/api/journal') {   // the user settles an unknown action on the page: "Done" / "Didn't happen" (journal.mjs, by: user)
        try { settleIntent(journalOf(c.id), String(b.id || ''), b.outcome === 'done' ? 'done' : b.outcome === 'failed' ? 'failed' : '', { by: 'user' }); } catch (e) { return json(res, 400, { error: e.message }); }
        broadcast({ conv: summary(c) }); sendAll({ multi: true }); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/stop') { if (c.working || c.turns > 0) { c.unknownDue = true; saveState(); } await stopConv(c); return json(res, 200, { ok: true }); }   // a turn cut off by Stop: the next message carries the open intents
      if (url.pathname === '/api/mode') { try { return json(res, 200, { ok: true, how: await setMode(c, String(b.mode)) }); } catch (e) { return json(res, 409, { error: e.message }); } }
      if (url.pathname === '/api/resume') {
        if (R(c).status === 'interrupted') c.unknownDue = true;   // setStatus clears the interruption: the next message still carries the open intents
        await ensureProc(c); setStatus(c, 'idle'); return json(res, 200, { ok: true, sessionId: c.sessionId });
      }
      if (url.pathname === '/api/rename') { try { setTitle(c, b.title); } catch (e) { return json(res, 400, { error: e.message }); } saveState(); broadcast({ conv: summary(c) }); return json(res, 200, { ok: true, title: c.title }); }
      if (url.pathname === '/api/pin') {   // manual 📌 on a message (action add, i = its event index) or the ✓ that releases a pin (action done)
        try { if (b.action === 'add') addManualPin(c, { i: b.i, text: b.text }); else if (b.action === 'done') donePin(c, String(b.id)); else throw new Error('unknown action'); } catch (e) { return json(res, 400, { error: e.message }); }
        saveState(); broadcast({ conv: summary(c) }); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/dismiss') { answered(c); saveState(); broadcast({ conv: summary(c) }); return json(res, 200, { ok: true }); }   // ✕ on "waiting for your answer": cleared as if the user had answered, without sending a message
      if (url.pathname === '/api/quotawait') { c.quotaWait = undefined; c.quotaTries = 0; saveState(); broadcast({ conv: summary(c) }); return json(res, 200, { ok: true }); }   // ✕ on "resumes at": no automatic resume for this stop
      if (url.pathname === '/api/conv-project') {   // ⋯ Move to project: list it under another project folder (same guard as /api/project); dir null = by its folder again
        let dir = null;
        if (b.dir != null) { const dirs = [...new Set([...projectFolders().map((f) => path.resolve(f.dir)), ...multi.view().map((p) => path.resolve(p.dir))])]; dir = allowedDir(b.dir, dirs); if (!dir) return json(res, 404, { error: 'not a project folder' }); }
        if (dir) c.project = dir; else delete c.project;
        saveState(); broadcast({ conv: summary(c) }); return json(res, 200, { ok: true, project: dir });
      }
      if (url.pathname === '/api/not-related') {   // "Not related" on a project page: this conversation is no longer listed as related to that folder
        const dirs = [...new Set([...projectFolders().map((f) => path.resolve(f.dir)), ...multi.view().map((p) => path.resolve(p.dir))])], dir = allowedDir(b.dir, dirs);
        if (!dir) return json(res, 404, { error: 'not a project folder' });
        c.notRelated = [...new Set([...(c.notRelated || []), dir])]; saveState(); broadcast({ multi: true }); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/conv-cwd') {   // tools/move-conv-cwd.sh: the conversation's real working folder, once its CLI history was copied to the new folder's project dir
        // Only a quiet Claude conversation (nothing running, nothing waiting, untouched 10 min) and only when the copy is complete: the
        // session file under the new folder must have the same size as the one under the old (the CLI resumes a session by its cwd).
        const cwd = typeof b.cwd === 'string' && path.isAbsolute(b.cwd) ? path.resolve(b.cwd) : null;
        if (!cwd || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) return json(res, 400, { error: 'cwd must be an existing absolute folder' });
        if (c.remote || SEATS[c.seat]?.agent) return json(res, 409, { error: 'only a local Claude conversation' });
        if (c.working || c.turns || c.bg?.length || R(c).perms.size || R(c).starting || effStatus(c) === 'working' || Date.now() - c.updatedAt < 10 * 60e3) return json(res, 409, { error: 'busy or touched in the last 10 minutes: try later' });
        const enc = (d) => d.replace(/[^A-Za-z0-9]/g, '-'), base = path.join(HOME, '.claude-seats', c.seat, 'projects'), sid = c.sessionId || c.id;
        const size = (d) => fs.statSync(path.join(base, enc(d), sid + '.jsonl'), { throwIfNoEntry: false })?.size;
        if (size(cwd) == null || (size(c.cwd) != null && size(c.cwd) !== size(cwd))) return json(res, 409, { error: 'the session file is not copied to the new folder (or differs in size)' });
        if (R(c).proc) await killProc(c);   // an idle process keeps its old cwd: the next message starts it again in the new one
        if (c.working || c.turns || R(c).starting || R(c).proc) return json(res, 409, { error: 'a message arrived meanwhile: try later' });   // started again during the await: leave its cwd alone
        const was = c.cwd; c.cwd = cwd; saveState(); broadcast({ conv: summary(c) });
        console.log(`[cwd] conv=${c.id.slice(0, 8)} ${was} -> ${cwd}`); return json(res, 200, { ok: true, from: was, cwd });
      }
      if (url.pathname === '/api/noautohandoff') { c.noAutoHandoff = !!b.off; if (c.noAutoHandoff && ['armed', 'asked'].includes(c.autoHandoff?.stage)) c.autoHandoff = undefined; saveState(); broadcast({ conv: summary(c) }); return json(res, 200, { ok: true }); }   // ⋯ "Don't auto-handoff" for this conversation
      if (url.pathname === '/api/keep') { c.keep = !!b.keep; saveState(); broadcast({ conv: summary(c) }); return json(res, 200, { ok: true }); }   // ⋯ "Keep shown": the row stays when its seat is folded (all devices)
      if (url.pathname === '/api/archive') { c.archived = !!b.archived; if (!c.archived) c.noAutoArchive = true;   /* brought back: not archived on its own again until the user writes */ saveState(); broadcast({ conv: summary(c) }); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/delete') {
        // An idle process is only waiting for input, so it is stopped and removed; a running turn or an open approval refuses.
        if (c.working || c.bg?.length || R(c).perms.size || R(c).starting) return json(res, 409, { error: 'conversation is running: stop it first' });
        await killProc(c);
        if (R(c).proc || R(c).starting) return json(res, 409, { error: 'a message started this conversation again: stop it first' });
        if (c.remote && hostInfoOf(c)) return json(res, 409, { error: `remote ${c.remote} unreachable: its host there could not be stopped, try again when it answers` });   // deleting now would orphan it // a send slipped in while the kill ran: deleting now would orphan its host
        delete state.conversations[c.id]; rt.delete(c.id); saveState();
        if (!openOf(c.id).length) fs.rmSync(journalOf(c.id), { force: true }); openCache.delete(c.id);   // a journal with open intents is kept (their outcome is still unknown)
        fs.rmSync(logFile(c), { force: true }); fs.rmSync(logFile(c) + '.restore', { force: true }); purgeArchive(DATA, c); fs.rmSync(path.join(UPLOADS, c.id), { recursive: true, force: true }); search.forget(c.id);
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
  const s = tsServer = http.createServer(handler).on('upgrade', wsUpgrade).on('error', (e) => {
    if (e.message !== tsBindErr) { tsBindErr = e.message; console.log(`[listen] ${tsIp}: ${e.message} (retrying)`); }
    if (tsServer === s) tsServer = null; // the next tick binds again
  });
  s.listen(PORT, tsIp, () => { tsBindErr = null; console.log(`Seat Console on http://${tsIp}:${PORT} pid=${process.pid}`); });
}
bindTailscale(); setInterval(bindTailscale, 10000).unref();
if (!ISOLATED || process.env.SEAT_TG_API) tg.start();   // a test instance never polls Telegram, unless a test hands it a fake Bot API (test-todos)
if (crashLoopStart && !ISOLATED && crashWarnDue(state, Date.now())) { saveState(); tg.send('⚠️ ' + t('bot.server.crashLoop')).catch(notifyFailed); }
routines.start();
setInterval(guard('multi', () => multi.tick()), 30000).unref();   // after reattachAll: never sends into a conversation still being reattached
// Model lists for the planner: Claude seats share the main list, agent seats ask their own CLI (cached 10 min in agentModels).
async function refreshModels() {
  const snap = {};
  for (const seat of Object.keys(SEATS)) {
    if (!SEATS[seat].agent) snap[seat] = CLAUDE_MODELS;
    else { try { snap[seat] = (await agentModels(seat)).map(({ id, name }) => ({ id, name })); } catch { snap[seat] = []; } }
  }
  modelsSnap = snap;
}
refreshModels().catch(() => {}); setInterval(() => refreshModels().catch(() => {}), 10 * 60e3).unref();
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
// A remote whose claude is logged in to a local seat's account (remotes.json "account") reports that account's quota:
// it goes on the seat's meter. That seat's own PC token may sit expired for days when all its work runs on the remote.
function accountUsage(rem, ev) {
  const seat = rem?.account, w = ev.rate_limit_info?.unifiedWindows; if (!seat || !hasKey(SEATS, seat) || !w) return;
  state.usage[seat] = { windows: w, at: Date.now() }; saveState(); broadcast({ usage: { seat, ...state.usage[seat] } }); quotaWatch(seat);
}
// Usage poll: rate_limit_event only arrives on a console turn, so work done on the same account in another client (desktop app, terminal)
// never moved the meter and it could sit far below the real value. Ask Anthropic for the account's real 5 h window every 3 min.
// Read-only use of the seat's current access token; never refreshes it (that would rotate the CLI's refresh token). Expired token = keep the last value.
// The same two calls, run ON a remote whose claude is logged in to the seat's account: the token never leaves that machine, only the numbers come back.
const REMOTE_USAGE_JS = `const o=require(require('os').homedir()+'/.claude/.credentials.json').claudeAiOauth;const h={Authorization:'Bearer '+o.accessToken,'anthropic-beta':'oauth-2025-04-20'};
Promise.all(['profile','usage'].map((p)=>fetch('https://api.anthropic.com/api/oauth/'+p,{headers:h}).then((r)=>r.json()))).then(([p,u])=>console.log(JSON.stringify({email:p.account&&p.account.email,five_hour:u.five_hour||null,seven_day:u.seven_day||null})))`;
// Seat -> its usage windows (five_hour, seven_day). The PC token first; expired (a seat whose work all runs on a remote) -> the remote with "account": seat.
// The remote's answer counts only if its account email is the seat's own: a remote whose default login is another account never lands on this meter.
// The usage endpoint answers the limit-reset block (cedar_ember) only to the Claude CLI's own User-Agent. Its version is read once from `claude --version`.
let cliUa = null;
const CLI_UA = () => cliUa ||= new Promise((ok) => execFile(CLAUDE_EXE, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true, env: cleanEnv() },
  (e, out) => ok(`claude-cli/${(!e && String(out).trim().split(/\s/)[0]) || '2.1.321'} (external, cli)`)));
// Spend one Claude limit reset of THIS seat's account: the request the CLI's /limit-reset sends (undocumented, may change). Only on the user's tap + confirm.
async function claimClaudeReset(seat, creditId) {
  const dir = path.join(HOME, '.claude-seats', seat), o = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8')).claudeAiOauth;
  if (!(o?.accessToken && o.expiresAt > Date.now())) throw new Error(`${seat}: its login token has expired; open the seat once so its CLI refreshes it`);
  const org = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')).oauthAccount?.organizationUuid; if (!org) throw new Error(`${seat}: no organization id`);
  const grant = state.resets?.[seat]?.credits?.find((c) => c.usableNow && c.id && (!creditId || c.id === creditId)); if (!grant) throw new Error('that reset is not available');
  const r = await fetch(`https://api.anthropic.com/api/organizations/${org}/reset_rate_limits`, { method: 'POST', signal: AbortSignal.timeout(25000),
    headers: { Authorization: 'Bearer ' + o.accessToken, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': await CLI_UA(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ program: 'cedar_ember', grant_id: grant.id, request_id: crypto.createHash('sha256').update(`${seat}:${grant.id}`).digest('hex').slice(0, 32) }) });   // same seat + grant = same request id: a repeat is not a second claim
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`reset refused (${r.status}): ${j?.error?.message || j?.reason || 'no detail'}`);
  return j;   // { result, reason, resets_left, cleared, weekly_resets_at }
}
async function seatUsage(seat) {
  const o = JSON.parse(fs.readFileSync(path.join(HOME, '.claude-seats', seat, '.credentials.json'), 'utf8')).claudeAiOauth;
  if (o?.accessToken && o.expiresAt > Date.now()) {   // expired: only the seat's own CLI refreshes it; the console never writes credentials
    // Settings "Claude limit resets" on: ?cedar_ember=1 adds the limit resets the account holds (read the way the CLI's /limit-reset reads them, CLI User-Agent); skip_spend=1: no spend block.
    // Off (the default): the plain usage request, no CLI User-Agent.
    const r = SET().claudeResets
      ? await fetch('https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1', { headers: { Authorization: 'Bearer ' + o.accessToken, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': await CLI_UA() }, signal: AbortSignal.timeout(15000) })
      : await fetch('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: 'Bearer ' + o.accessToken, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(15000) });
    return r.ok ? await r.json() : undefined;   // { five_hour, seven_day, ... }
  }
  const rem = REMOTES.find((x) => x.account === seat && !remoteDown.has(x.name)); if (!rem || !SEATS[seat].email) return undefined;
  const x = await rhost.sshRun(rem, rem.node + ' -', { input: REMOTE_USAGE_JS, timeout: 30000, max: 65536 });
  const j = x.code === 0 ? parseLine(x.out.toString().trim().split('\n').pop()) : null;
  return j && j.email === SEATS[seat].email ? j : undefined;
}
async function pollUsage() {
  for (const seat of Object.keys(SEATS)) {
    if (SEATS[seat].agent === 'codex') {   // Codex: its windows + free limit resets from its own account (agents/codex-account.mjs); each half only when Settings has it on
      if (!SET().usageMeters && !SET().codexResets) continue;
      try { const a = await readCodexAccount({ env: agentEnv(seat) }); if (SET().codexResets) { (state.resets ||= {})[seat] = { ...a.resets, at: Date.now() }; broadcast({ resets: { seat, ...resetsView(seat) } }); } if (SET().usageMeters) { state.usage[seat] = { windows: a.windows, at: Date.now() }; broadcast({ usage: { seat, ...state.usage[seat] } }); quotaWatch(seat); } }
      catch (e) { console.log(`[usage] ${seat}: ${e.message}`); }
      continue;
    }
    if (SEATS[seat].agent || !SET().usageMeters) continue;   // another agent seat: no Claude account to poll; meters off in Settings: no request at all
    try {
      const u = await seatUsage(seat), w = u?.five_hour; if (!w || typeof w.utilization !== 'number') continue;
      // resets_at null = no 5 h window open (nothing used since the last reset): 0 %, shown as reset
      const windows = { five_hour: { utilization: w.utilization / 100, resetsAt: w.resets_at ? Math.round(Date.parse(w.resets_at) / 1000) : Math.floor(Date.now() / 1000) } };
      // Limit resets the Claude account holds (cedar_ember.grants: id, label, resets_left, ends_at, usable_now). Only answered to a CLI User-Agent.
      const grants = (Array.isArray(u.cedar_ember?.grants) ? u.cedar_ember.grants : []).filter((g) => (g.resets_left ?? 1) > 0 && !g.paused);
      if (SET().claudeResets) (state.resets ||= {})[seat] = { available: grants.reduce((n, g) => n + (Number(g.resets_left ?? 1) || 0), 0),
        credits: grants.map((g) => ({ id: g.id, title: /fable/i.test(g.id + ' ' + (g.label || '')) ? 'Fable reset' : g.type === 'full' ? 'Full reset' : (g.label || 'Limit reset'), label: g.label || null, expiresAt: g.ends_at ? Math.round(Date.parse(g.ends_at) / 1000) : null, usableNow: g.usable_now !== false })).sort((a, b) => (a.expiresAt || Infinity) - (b.expiresAt || Infinity)), at: Date.now() };
      broadcast({ resets: { seat, ...resetsView(seat) } });
      const wk = u.seven_day;   // the weekly window: every seat shows its exact reset day + time
      if (wk && typeof wk.utilization === 'number' && wk.resets_at) windows.seven_day = { utilization: wk.utilization / 100, resetsAt: Math.round(Date.parse(wk.resets_at) / 1000) };
      state.usage[seat] = { windows, at: Date.now() };
      broadcast({ usage: { seat, ...state.usage[seat] } }); quotaWatch(seat);
    } catch {}   // missing creds / network / ssh: the event path still updates the meter
  }
  saveState();
}
if (!ISOLATED) { setInterval(() => pollUsage().catch(() => {}), 180e3).unref(); pollUsage().catch(() => {}); }
setTimeout(() => retentionRun().catch((e) => console.log('[retention] failed: ' + e.message)), 30000).unref();
setInterval(guard('retention', () => { if (viennaHour(Date.now()) === 4 && state.lastRetentionFor !== viennaYmd(Date.now())) retentionRun().catch((e) => console.log('[retention] failed: ' + e.message)); }), 60000).unref();
// Idle processes are stopped after IDLE_REAP_MS (see ensureProc); checked at least once a minute.
// Auto-archive: a conversation untouched for autoArchiveDays (Settings) moves to the archive, unless it is marked ★ Keep (⋯ menu)
// or still has something going on. Nothing is deleted; search finds archived ones, and sending to one brings it back.
function autoArchive() {
  if (!SET().autoArchiveDays) return;   // 0 = never
  const cut = Date.now() - SET().autoArchiveDays * 864e5;
  for (const c of Object.values(state.conversations)) {
    if (c.archived || c.keep || (c.updatedAt || 0) > cut) continue;
    const r = R(c);
    if (c.working || c.bg?.length || r.perms.size || c.needsAnswer || c.quotaWait || c.interrupted || r.status === 'working') continue;
    c.archived = true; saveState(); broadcast({ conv: summary(c) });
    console.log(`[auto-archive] conv=${c.id.slice(0, 8)} "${String(c.title).slice(0, 40)}": idle ${Math.floor((Date.now() - c.updatedAt) / 864e5)} d`);
  }
}
// Finished-work archive: quiet for autoArchiveDoneMin (Settings, 0 = off), nothing asked of the user (marks.mjs autoArchivable). Same archive step as /api/archive.
function autoArchiveDone() {
  const graceMs = (SET().autoArchiveDoneMin || 0) * 60000; if (!graceMs) return;
  const open = new Set([...clients].map((o) => o.watch)), run = new Set(multi.view().filter((p) => !['done', 'cancelled'].includes(p.status)).flatMap((p) => [p.planConv, p.integrateConv, ...p.tasks.map((k) => k.conv)]));
  for (const c of Object.values(state.conversations)) {
    if (!autoArchivable(c, { status: effStatus(c), perms: R(c).perms.size, unknown: openOf(c.id).length, held: open.has(c.id) || run.has(c.id), graceMs })) continue;
    c.archived = true; saveState(); broadcast({ conv: summary(c) });
    console.log(`[auto-archive] conv=${c.id.slice(0, 8)} "${String(c.title).slice(0, 40)}": finished, quiet ${Math.floor((Date.now() - c.updatedAt) / 60000)} min`);
  }
}
if (!ISOLATED) { setInterval(guard('auto-archive', autoArchive), 10 * 60000).unref(); setInterval(guard('auto-archive-done', autoArchiveDone), 5 * 60000).unref(); setTimeout(guard('auto-archive-done', autoArchiveDone), 40000).unref(); setTimeout(guard('auto-archive', autoArchive), 30000).unref(); }
// Build the search index in the background after start (the first build reads every log once); later passes only read what was appended.
const hwm = () => { try { return +/VmHWM:\s+(\d+)/.exec(fs.readFileSync('/proc/self/status', 'utf8'))[1] * 1024; } catch { return process.memoryUsage().rss; } };   // peak RSS (Linux), else the current one
setTimeout(() => { const t0 = Date.now(); search.refresh([...Object.values(state.conversations), ...Object.values(state.remoteConvs)]).then(() => console.log(`[search] index ready in ${Math.round((Date.now() - t0) / 1000)} s, peak rss ${Math.round(hwm() / 1048576)} MB`)).catch((e) => console.log('[search] ' + e.message)); }, 5000).unref();
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
