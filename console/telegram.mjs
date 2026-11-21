// Telegram notifications + Allow/Deny buttons for Seat Console, via its own dedicated bot.
// Secrets file { botToken, chatId } is re-read on every use, so pasting the token (or linking the chat)
// lights this up without a server restart. The token is never printed or logged.
// Every message is parse_mode HTML. All dynamic text (titles, summaries, tool input, file names) comes from agents,
// so it goes through esc() / escClip() before it touches a tag. If Telegram still rejects the markup, send() retries as plain text.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { t, tn, hm, num, pct, lang } from './i18n.mjs';

const PLACEHOLDER = /^PASTE/i;
// Counted and cut in characters (code points), never in UTF-16 units: slicing through the middle of an emoji leaves a lone surrogate that Telegram rejects.
export const clip = (s, n) => { const a = Array.from(String(s ?? '').replace(/\s+$/, '')); return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join(''); };
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
// Clip the RAW text first, then escape; shrink further if escaping ("&" -> "&amp;") would blow the budget, so a tag is never cut in half.
export const escClip = (s, n) => { let r = clip(s, n); while (r.length > 1 && esc(r).length > n * 1.5) r = Array.from(r).slice(0, Math.ceil(Array.from(r).length * 0.7)).join('') + '…'; return esc(r); };
// Plain-text twin of an HTML message, for the one-shot fallback when Telegram says "can't parse entities".
export const toPlain = (h) => String(h).replace(/<a href="([^"]*)">([^<]*)<\/a>/g, '$2 $1').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

// Usage window as a 10-cell bar, with a colour hint: 🟢 <50, 🟡 50-80, 🔴 >80.
export const bar = (u) => { const p = Math.max(0, Math.min(1, +u || 0)), n = Math.round(p * 10); return `${p < 0.5 ? '🟢' : p <= 0.8 ? '🟡' : '🔴'} ${'▰'.repeat(n)}${'▱'.repeat(10 - n)} ${pct(p)}`; };
// Reset time of the 5 h window (resetsAt = epoch ms, local clock). A reset already in the past reads "reset": the usage is 0 until a new event arrives.
export const clock = (ms) => hm(ms);
export const resetTag = (resetsAt, now = Date.now()) => (resetsAt == null ? '' : resetsAt <= now ? '🔁 ' + t('bot.reset') : '🔁 ' + t('bot.resetsAt', { time: clock(resetsAt) }));
// From 50 % a seat is marked in the picker; from 80 % the console warns before you pick it.
export const seatMark = (u) => (u == null || u < 0.5 ? '' : u < 0.8 ? '🟡' : '🔴');
// At most ONE warning per seat per 5 h window: warned[seat] holds the resetsAt (seconds) of the window already warned about.
// Two events of one window may differ by a few seconds, so "same window" = within 10 minutes.
export function quotaWarnDue(warned, seat, util, resetsAtSec) {
  if (!(util >= 0.9) || (Object.hasOwn(warned, seat) && Math.abs(warned[seat] - resetsAtSec) < 600)) return false;
  warned[seat] = resetsAtSec; return true;
}
// No "another seat has quota left" line: each seat's limit is its own, and the console never moves work to another seat to dodge it.
export const buildQuotaWarning = ({ seat, util, resetsAt }, now = Date.now()) => [
  '🔴 ' + t('bot.quotaWarning', { seat: `<b>${esc(seat)}</b>`, pct: pct(util) }), resetTag(resetsAt, now)].filter(Boolean).join('\n');
export const SEAT_EMOJI = { studio: '🎨', dev: '🧑‍💻', render: '🎬', info: '💼', ops: '⚙️' };
const quote = (h, expandable) => `<blockquote${expandable ? ' expandable' : ''}>${h}</blockquote>`;
const link = (url) => `<a href="${escAttr(url)}">${t('bot.openInConsole')} ↗</a>`;
const errLine = (what, m) => `❌ <b>${what}</b> · <code>${escClip(m, 200)}</code>`;

// Allow approves the WHOLE input, so the approval message must show all of it (never a clipped preview).
// A lone command shows as-is, anything else as pretty JSON. Longer than PERM_MAX (measured AFTER escaping) does not fit one Telegram message safely: no buttons then.
export const PERM_MAX = 3500;
export const fullInput = (o) => (o && typeof o === 'object' && typeof o.command === 'string' && Object.keys(o).length === 1 ? o.command : typeof o === 'string' ? o : JSON.stringify(o ?? '', null, 2));
export const permTooLong = (input) => esc(fullInput(input)).length > PERM_MAX;

// Seats are told to end every reply with a "Summary:" line (the Hebrew "סיכום:" is accepted too); the notification shows it instead of the raw start of the text.
export const extractSummary = (text) => { const m = String(text || '').split('\n').map((l) => l.trim()).filter((l) => /^(?:סיכום|Summary):/i.test(l)); return m.length ? m[m.length - 1] : null; };
export const summaryText = (text) => { const l = extractSummary(text); return l && l.replace(/^(?:סיכום|Summary):\s*/i, ''); };
// Message HTML for one event. kind: done | error | perm. files = names the turn wrote or edited. usage = 0..1 five-hour window of the seat, or null. needsAnswer = the turn asks the user something.
export function buildMessage(kind, { seat, title, text, tool, input, convId, files, usage, resetsAt, ctxPct, needsAnswer, unknown }, base) {
  const head = (e) => `${e} <b>${esc(seat)}</b> · <i>${esc(clip(title, 40))}</i>`;
  const foot = ['', link(`${base}/#${convId}`)];
  if (kind === 'perm') {
    const full = fullInput(input), ask = t('bot.perm.asks', { tool: `<b>${esc(tool)}</b>` });
    if (permTooLong(input)) return [head('⏳'), '', ask, `<pre>${escClip(full, 500)}</pre>`, t('bot.perm.tooLong'), ...foot].join('\n');
    return [head('⏳'), '', ask, `<pre>${esc(full)}</pre>`, ...foot].join('\n');
  }
  const tx = String(text || '').trim(), sum = summaryText(tx);
  const body = sum ? quote(escClip(sum, 400)) : kind === 'error' ? `<code>${escClip(tx, 300)}</code>` : quote(escClip(tx, 300));
  const more = sum ? tx !== extractSummary(tx) : tx.length > 300;   // the full text hides in an expandable quote so nothing is lost
  const fl = files && files.length ? `📄 ${files.slice(0, 5).map((f) => `<code>${esc(f)}</code>`).join(' ')}${files.length > 5 ? ` +${files.length - 5}` : ''}` : null;
  // needsAnswer: the turn ended with a question / decision for the user (marks.mjs), shown right under the summary
  return [head(kind === 'error' ? '❌' : '✅'), body, needsAnswer && kind === 'done' ? `❓ <b>${t('bot.waitingAnswer')}</b>` : null, unknown > 0 ? `⚠️ <b>${t('bot.unknownActions', { n: num(unknown) })}</b>` : null, fl, more ? quote(escClip(tx, 1800), true) : null, usage != null ? [`${bar(usage)} · ${t('bot.fiveHours')}`, resetTag(resetsAt)].filter(Boolean).join(' · ') : null, ctxPct != null ? `🧠 ${pct(ctxPct / 100)}` : null, ...foot].filter((x) => x !== null).join('\n');
}
// ---- files of a finished turn (sendFiles below): Bot API limits are 10 MB for a photo and 50 MB for any other upload ----
export const FILES_MAX = 5, PHOTO_MAX = 10 * 1024 * 1024, UPLOAD_MAX = 50 * 1024 * 1024;
const mb = (n) => num(n / 1048576, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + ' MB';
// files = [{ path, name, size }] -> { send: [{ method, field, file }], lines: [plain text] }. Photos show inline (svg/gif/large images go as documents), mp4 plays inline,
// anything over 50 MB is a text line; at most FILES_MAX files are handled, the rest are counted.
export function planFiles(files) {
  const send = [], lines = [];
  for (const f of files.slice(0, FILES_MAX)) {
    const ext = path.extname(f.name).slice(1).toLowerCase();
    if (f.size > UPLOAD_MAX) lines.push('📎 ' + t('bot.files.tooBig', { name: f.name, size: mb(f.size) }));
    else if (/^(png|jpe?g|webp)$/.test(ext) && f.size <= PHOTO_MAX) send.push({ method: 'sendPhoto', field: 'photo', file: f });
    else if (ext === 'mp4') send.push({ method: 'sendVideo', field: 'video', file: f });
    else send.push({ method: 'sendDocument', field: 'document', file: f });
  }
  if (files.length > FILES_MAX) lines.push(t('bot.files.more', { n: files.length - FILES_MAX }));
  return { send, lines };
}
// One-line confirmation after a reply was delivered.
export const sentLine = (seat, title) => '↪️ ' + t('bot.sentTo', { seat: `<b>${esc(seat)}</b>` }) + ` · <i>${esc(clip(title, 40))}</i>`;

// At most one message per key per window (used for "finished", one per conversation per 60 s).
export class Throttle {
  constructor(ms) { this.ms = ms; this.last = new Map(); }
  allow(key, now = Date.now()) {
    if (now - (this.last.get(key) ?? -Infinity) < this.ms) return false;
    this.last.set(key, now); return true;
  }
}

// callback_data is "p:<conversation id prefix>:<request id>:1|0" (Telegram caps it at 64 bytes).
export const callbackData = (convId, requestId, allow) => `p:${convId.slice(0, 8)}:${requestId}:${allow ? 1 : 0}`;
export function parseCallback(data) {
  const m = /^p:([0-9a-f]{8}):(.+):([01])$/.exec(String(data || ''));
  return m ? { convShort: m[1], requestId: m[2], allow: m[3] === '1' } : null;
}
// Which conversation an approval button applies to: the one it names (archived ones included, they stay in state), else a rollover successor
// down the c.rollover.to chain that holds the request. Missing conversation or request -> a plain sentence, never a bare "not found" (2026-11-21).
export const CONFLICT_TEXT = '⚠️ <b>Seat Console</b>: another copy of this bot is reading its updates (Telegram 409 Conflict), so Allow/Deny taps and replies go to that copy and fail there. Stop the Telegram bot on the other machine: one console per bot.';
export const PERM_GONE = 'this request was already answered or has expired, open it in the console';
export function findPermConv(convs, convShort, requestId, hasPerm) {
  const start = Object.values(convs).find((x) => x.id.startsWith(convShort));
  if (!start) throw new Error(PERM_GONE + ' (this console does not know that conversation)');
  for (let c = start, seen = new Set(); c && !seen.has(c.id); seen.add(c.id), c = convs[c.rollover?.to]) if (hasPerm(c, requestId)) return c;
  throw new Error(PERM_GONE);
}

// ---- status digest: answers "what's new" from server state only (no model call, zero cost) ----
// Short plain messages that mean "tell me what is going on" instead of "start a task". Lowercased + trimmed, exact match.
export const STATUS_PHRASES = ['מה חדש', 'מה קורה', 'מה המצב', 'סטטוס', 'עדכון', 'מה נעשה', 'status', "what's new", 'whats new', 'update'];
export const isStatusRequest = (t) => { const s = String(t || '').trim().toLowerCase(); return s.length <= 30 && (STATUS_PHRASES.includes(s) || /^\/status(@\w+)?$/.test(s)); };
const DIGEST_MAX = 8, DAY = 24 * 3600 * 1000;
// ---- crash recovery: conversations the server found interrupted. Buttons are r:all, r:<8-hex conversation prefix>, r:no ----
// list = [{ id, seat, title, updatedAt }]. crash = true for the message sent after a restart, false for /recover. Resuming spends quota, so only a tap does it.
export function buildRecover(list, now, crash) {
  if (!list.length) return { text: '✅ ' + t('bot.recover.none'), rows: null };
  const shown = list.slice(0, DIGEST_MAX);
  const head = crash ? `🔄 <b>${t('bot.recover.crashed')}</b> — ${tn('bot.recover.cutOff', list.length)}` : `🔄 <b>${t('bot.recover.title')}</b> — ${num(list.length)}`;
  const lines = shown.map((c) => `${SEAT_EMOJI[c.seat] || '🔹'} <b>${esc(c.seat)}</b> · <i>${esc(clip(c.title, 40))}</i> · ${age(now - c.updatedAt)}`);
  if (list.length > shown.length) lines.push(`<i>${t('bot.more', { n: list.length - shown.length })}</i>`);
  return { text: [head, '', ...lines].join('\n'), rows: [[{ text: '▶️ ' + t('bot.recover.all'), callback_data: 'r:all' }], ...shown.map((c) => [{ text: `▶️ ${c.seat} · ${clip(c.title, 24)}`, callback_data: `r:${c.id.slice(0, 8)}` }]), [{ text: '✖️ ' + t('bot.recover.notNow'), callback_data: 'r:no' }]] };
}
const EMOJI = { working: '⚙️', waiting: '⏳', idle: '✅', error: '❌' };   // anything else (stopped, interrupted, unknown) is ⏸
const age = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 1 ? t('bot.age.now') : m < 60 ? tn('bot.age.min', m) : tn('bot.age.h', Math.round(m / 60)); };
// data = { seats: [{ name, usage: 0..1 | null, convs: [{ id, title, status, updatedAt, result }] }] } -> { text (HTML), rows } (rows = inline keyboard, one open-button per conversation)
export function buildDigest(data, now, base) {
  const title = `<b>📊 ${t('bot.status.title')}</b> · <i>${t('bot.status.last24')}</i>`;
  const recent = [];
  for (const s of data.seats) for (const c of s.convs) if (now - c.updatedAt < DAY) recent.push({ ...c, seat: s.name });
  if (!recent.length) return { text: `${title}\n\n😴 ${t('bot.status.noActivity')}`, rows: null };
  recent.sort((a, b) => b.updatedAt - a.updatedAt);
  const shown = recent.slice(0, DIGEST_MAX), waiting = recent.filter((c) => c.status === 'waiting').length;
  const blocks = [], rows = [];
  for (const s of [...new Set(shown.map((c) => c.seat))].map((name) => data.seats.find((x) => x.name === name))) {   // seat with the newest conversation first
    const lines = [`<b>${SEAT_EMOJI[s.name] || '🔹'} ${esc(s.name)}</b>${s.usage == null ? '' : `  ${bar(s.usage)}${s.resetsAt == null ? '' : ' · ' + resetTag(s.resetsAt, now)}`}`];
    for (const c of shown.filter((x) => x.seat === s.name)) {
      const e = EMOJI[c.status] || '⏸', sum = summaryText(c.result);
      lines.push(`${e} <b>${esc(clip(c.title, 40))}</b> · <i>${age(now - c.updatedAt)}</i>${c.bg ? ' · ' + tn('bot.status.background', c.bg) : ''}${c.ctxPct != null ? ` · 🧠 ${pct(c.ctxPct / 100)}` : ''}`);
      if (sum) lines.push(quote(escClip(sum, 160)));
      rows.push([{ text: `${e} ${clip(c.title, 28)}`, url: `${base}/#${c.id}` }]);
    }
    blocks.push(lines.join('\n'));
  }
  const tail = [];
  if (recent.length > shown.length) tail.push(`<i>${t('bot.more', { n: recent.length - shown.length })}</i>`);
  if (waiting) tail.push('⏳ ' + t('bot.status.waiting', { n: `<b>${num(waiting)}</b>` }));
  const quiet = data.seats.filter((s) => !recent.some((c) => c.seat === s.name)).map((s) => esc(s.name));
  if (quiet.length) tail.push('😴 ' + t('bot.status.quiet', { seats: quiet.join(', ') }));
  return { text: [title, '', blocks.join('\n\n'), ...(tail.length ? ['', ...tail] : [])].join('\n'), rows };
}

// onDecision(convShort, requestId, allow) -> Promise<string> outcome text, throws when already answered.
// msgMap (persisted by the caller) maps each sent message_id -> conversation id, so a Telegram REPLY finds its conversation.
// onReply(convId, { text, images:[{data:Buffer}], files:[{data:Buffer, name}] }) -> Promise<string> confirmation line (HTML, see sentLine).
// onNewTask({seat, model, mode, text}) starts the conversation (throws if it cannot); onList() -> [{id, seat, title, status}]; findConv(idPrefix) -> {id, seat, title}|null; seats = seat names; phoneBase = console URL for "open" buttons.
// Uploads of every conversation share ONE serial queue (see sendFiles).
let fileQueue = Promise.resolve();
export const TG_FILE_MAX = 20 * 1024 * 1024;   // Telegram's own limit for a bot's getFile download
export function createTelegram({ cfgFile, onDecision, onReply, onCompact = async () => { throw new Error(t('bot.compact.unavailable')); }, onNewTask, onList, onStatus, onDigest = null, onUsage = async () => ({}), onRecoverList = async () => [], onRecover = async () => ({ resumed: [], failed: [] }), onRoutineTap = async () => ({ toast: t('bot.routines.off') }), onRoutineList = null, onMulti = null, onMultiApprove = null, findConv, seats = [], phoneBase = '',  msgMap = {}, onMapChange = () => {}, getOffset = () => 0, setOffset = () => {}, linkCodeFile = null, apiBase = 'https://api.telegram.org', log = console.log, idleMs = 10000, retryMs = 30000 }) {
  let warned = false;
  const base = () => (typeof phoneBase === 'function' ? phoneBase() : phoneBase); // a function when the console URL can change after start (Tailscale coming up late)
  const readCfg = () => {
    try {
      const c = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^﻿/, ''));
      return c.botToken && !PLACEHOLDER.test(c.botToken) ? c : null;
    } catch { return null; }
  };
  const call = async (cfg, method, body, timeoutMs = 15000) => {
    try {
      // A FormData body is a file upload (multipart, fetch sets the boundary); everything else is JSON.
      const r = await fetch(`${apiBase}/bot${cfg.botToken}/${method}`, { method: 'POST', ...(body instanceof FormData ? { body } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }), signal: AbortSignal.timeout(timeoutMs) });
      const j = await r.json();
      if (!j.ok) throw Object.assign(new Error(`${method}: ${j.error_code} ${j.description}`), { retryAfter: j.parameters?.retry_after });
      return j.result;
    } catch (e) { throw Object.assign(new Error(String(e.message).split(cfg.botToken).join('<token>')), { retryAfter: e.retryAfter }); } // an error text must never carry the token; a 429 keeps its wait
  };
  // Every text-carrying call is HTML; a markup rejection resends the same text once as plain so a notification is never lost.
  const callH = async (cfg, method, body) => {
    try { return await call(cfg, method, { parse_mode: 'HTML', ...body }); }
    catch (e) {
      if (!/can't parse entities/i.test(e.message)) throw e;
      log('telegram: HTML rejected, resent as plain text (' + e.message.slice(0, 120) + ')');
      return call(cfg, method, { ...body, text: toPlain(body.text) });
    }
  };

  // Send to the linked chat; silently nothing while off or not yet linked.
  const remember = (m, convId) => {
    if (!m || !convId) return;
    msgMap[m.message_id] = convId;
    const keys = Object.keys(msgMap); if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete msgMap[k];
    try { onMapChange(); } catch (e) { log('telegram map save failed: ' + e.message); } // a failed state save must not break the notification path
  };
  async function send(text, rows) {
    const cfg = readCfg();
    if (!cfg) { if (!warned) { warned = true; log('telegram: not configured'); } return null; }
    if (!cfg.chatId) return null;
    try {
      return await callH(cfg, 'sendMessage', { chat_id: cfg.chatId, text, disable_web_page_preview: true, ...(rows ? { reply_markup: { inline_keyboard: rows } } : {}) });
    } catch (e) { log('telegram send failed: ' + e.message); return null; }
  }
  // An approval too long to review in Telegram goes out WITHOUT Allow/Deny, so a phone tap can never approve text nobody saw.
  // Resolves to the sent message (null when off), so the done-message's files can reply to it.
  const notify = async (kind, info, base, buttons) => { const m = await send(buildMessage(kind, info, base), buttons && !(kind === 'perm' && permTooLong(info.input)) ? [buttons] : null); remember(m, info.convId); return m; };
  // The files a finished turn produced (files = [{ path, name, size }], already filtered by the caller), as replies to its done-message (planFiles picks the method).
  // One upload at a time across ALL conversations (one queue per bot, fileQueue below), so two turns finishing together never race the bot's rate limit.
  // Each file stands alone: a failure is logged and the next file still goes; a photo Telegram refuses (width+height > 10000, aspect > 20: full-page screenshots) is resent as a document.
  // A 429 waits its retry_after (max 60 s) once. Never throws: a notification path must not crash the server.
  const upload = async (cfg, it, replyTo, method = it.method, field = it.field) => {
    const form = new FormData();
    form.append('chat_id', String(cfg.chatId)); form.append('reply_to_message_id', String(replyTo)); form.append('allow_sending_without_reply', 'true');
    form.append('caption', clip(it.file.name, 200));   // plain text, no parse_mode: the name comes from an agent
    form.append(field, await fs.openAsBlob(it.file.path), it.file.name);
    return call(cfg, method, form, 180000);   // 50 MB over a slow uplink
  };
  const once429 = async (fn) => { try { return await fn(); } catch (e) { if (!(e.retryAfter > 0)) throw e; await new Promise((r) => setTimeout(r, Math.min(e.retryAfter, 60) * 1000)); return fn(); } };
  async function sendFilesNow(replyTo, files) {
    const cfg = readCfg(); if (!cfg?.chatId || !files?.length) return;
    const { send: items, lines } = planFiles(files);
    for (const it of items) {
      try { await once429(() => upload(cfg, it, replyTo)); continue; }
      catch (e) { if (it.method !== 'sendPhoto') { log(`telegram file failed (${it.file.name}): ${e.message}`); continue; } }
      try { await once429(() => upload(cfg, it, replyTo, 'sendDocument', 'document')); }   // a photo Telegram refused: the same file as a document
      catch (e) { log(`telegram file failed (${it.file.name}): ${e.message}`); }
    }
    if (lines.length) await once429(() => call(cfg, 'sendMessage', { chat_id: cfg.chatId, text: lines.join('\n'), disable_web_page_preview: true, reply_to_message_id: replyTo, allow_sending_without_reply: true }))
      .catch((e) => log('telegram file note failed: ' + e.message));
  }
  const sendFiles = (replyTo, files) => (fileQueue = fileQueue.then(() => sendFilesNow(replyTo, files)).catch((e) => log('telegram files failed: ' + e.message)));
  const compactButton = (convId) => [{ text: '🗜️ ' + t('bot.compact.button'), callback_data: `k:${convId.slice(0, 8)}` }];
  const permButtons = (convId, requestId) => [{ text: '✅ ' + t('bot.perm.allow'), callback_data: callbackData(convId, requestId, true) }, { text: '🚫 ' + t('bot.perm.deny'), callback_data: callbackData(convId, requestId, false) }];

  // ---- starting work from the bot: a plain message opens seat -> model -> mode keyboards (mode never offers bypass), or /<seat> text skips them ----
  const MODELS = [['Opus 5.5', 'claude-opus-5-5'], ['Fable 5.1', 'claude-fable-5-1'], ['Sonnet 5.5', 'claude-sonnet-5-5'], ['Haiku 5.5', 'claude-haiku-5-5'], [null, null]];   // null name = the seat's default model
  const modelName = (m) => m?.[0] ?? t('bot.pick.defaultModel');
  const PICKER_TTL = 15 * 60 * 1000;
  const pickers = new Map();           // short id -> { text, seat, model, at }; text stays here because callback_data holds 64 bytes
  let cont = null;                     // { convId, label, at }: set by "continue" in /list, taken by the next plain message
  const live = (x) => x && Date.now() - x.at < PICKER_TTL;
  const kb = (rows) => ({ inline_keyboard: rows });
  // u = { seat: 0..1 }: a seat at 50 % or more is marked with its percentage, so the picker shows where the quota is left.
  const seatKb = (pid, u = {}) => kb(seats.map((s) => [{ text: `${seatMark(u[s]) ? seatMark(u[s]) + ' ' : ''}${SEAT_EMOJI[s] || '🔹'} ${s}${seatMark(u[s]) ? ' ' + Math.round(u[s] * 100) + '%' : ''}`, callback_data: `s:${pid}:${s}` }]));
  const modelKb = (pid) => kb(MODELS.map((m, i) => [{ text: modelName(m), callback_data: `m:${pid}:${i}` }]));
  const modeKb = (pid) => kb([[{ text: t('mode.auto'), callback_data: `d:${pid}:auto` }, { text: t('mode.ask'), callback_data: `d:${pid}:ask` }]]);
  const startedLine = (seat, model, mode) => `🚀 <b>${esc(seat)}</b> · ${esc(modelName(MODELS.find((m) => m[1] === model)))} · ${t('mode.' + mode)} — ${t('bot.pick.started')}`;
  const taskQuote = (t) => quote(escClip(t, 120));

  async function handleMessage(cfg, msg) {
    const say = (text, extra) => callH(cfg, 'sendMessage', { chat_id: cfg.chatId, text, reply_to_message_id: msg.message_id, allow_sending_without_reply: true, disable_web_page_preview: true, ...extra }).catch(() => {});
    const text = (msg.text || msg.caption || '').trim();
    // A file sent as a document / video / audio / voice note: the same reply routing as a photo. The bot API downloads at most TG_FILE_MAX.
    const doc = msg.document || msg.video || msg.audio || msg.voice;
    const reqs = async () => {
      const att = msg.photo?.length ? msg.photo[msg.photo.length - 1] : doc; if (!att) return [];
      if (att.file_size > TG_FILE_MAX) throw Object.assign(new Error('too big'), { tooBig: true });
      let f; try { f = await call(cfg, 'getFile', { file_id: att.file_id }); } catch (e) { throw /too big/i.test(e.message) ? Object.assign(e, { tooBig: true }) : e; }
      const r = await fetch(`${apiBase}/file/bot${cfg.botToken}/${f.file_path}`, { signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error('download ' + r.status);
      return [{ data: Buffer.from(await r.arrayBuffer()), name: att.file_name || String(f.file_path).split('/').pop() }];
    };
    // 1. a reply to one of our notifications goes into THAT conversation
    const convId = msg.reply_to_message && Object.hasOwn(msgMap, msg.reply_to_message.message_id) ? msgMap[msg.reply_to_message.message_id] : undefined;
    // 🖥️ messages come from desktop-app sessions (the telegram-app-notify hook, same bot): the console cannot drive those, so say so instead of "unknown conversation".
    if (msg.reply_to_message && !convId && String(msg.reply_to_message.text || msg.reply_to_message.caption || '').trimStart().startsWith('🖥️')) return void (await say('🖥️ ' + t('bot.desktopSession')));
    if (msg.reply_to_message && !convId) return void (await say('🤷 ' + t('bot.unknownConversation')));
    // "/compact [what to keep]" as a reply shrinks THAT conversation's context (idle only); it is never delivered as a chat message.
    const cm = convId && /^\/compact(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text);
    if (cm) { let out; try { await onCompact(convId, cm[1]); out = '🗜️ ' + t('bot.compact.running'); } catch (e) { out = errLine(t('bot.compact.failed'), e.message); } return void (await say(out)); }
    if (convId) return void (await deliver(convId, text, msg, say, reqs));
    // 2. commands
    if (/^\/(start|help)\b/i.test(text)) return void (await say([
      '<b>🤖 Seat Console</b>', '',
      '✍️ ' + t('bot.help.plain'),
      '⚡ ' + t('bot.help.direct', { cmd: `<code>/${esc(seats[0] || 'seat')} ${t('bot.help.text')}</code>`, seats: seats.map((s) => '/' + esc(s)).join(' ') }),
      '📊 /status: ' + t('bot.cmd.status'), '☀️ /digest: ' + t('bot.help.digest', { time: hm(new Date(2000, 0, 1, 8).getTime()) }), '🌆 /evening: ' + t('bot.help.evening', { time: hm(new Date(2000, 0, 1, 21).getTime()) }), '🧩 /multi: ' + t('bot.cmd.multi'), '🗂 /list: ' + t('bot.cmd.list'), '🔄 /recover: ' + t('bot.cmd.recover'), '⏰ /routines: ' + t('bot.cmd.routines'), '↩️ ' + t('bot.help.reply'), '🗜️ ' + t('bot.help.compact', { cmd: '<code>/compact</code>' })].join('\n')));
    if (isStatusRequest(text)) { const d = buildDigest(await onStatus(), Date.now(), base()); return void (await say(d.text, d.rows ? { reply_markup: kb(d.rows) } : {})); }
    if (/^\/digest(@\w+)?$/i.test(text) && onDigest) { const d = await onDigest('morning'); return void (await say(d.text, d.rows ? { reply_markup: kb(d.rows) } : {})); }   // the morning digest on demand
    if (/^\/(evening(@\w+)?|digest(@\w+)?\s+evening)$/i.test(text) && onDigest) { const d = await onDigest('evening'); return void (await say(d.text, d.rows ? { reply_markup: kb(d.rows) } : {})); }   // the evening digest on demand
    if (/^\/list\b/i.test(text)) {
      const rows = (await onList()).slice(0, 8);
      if (!rows.length) return void (await say('🗂 ' + t('bot.list.none')));
      return void (await say([`<b>🗂 ${t('bot.list.title')}</b>`, '', ...rows.map((c, i) => `${i + 1}. ${EMOJI[c.status] || '⏸'} <b>${esc(c.seat)}</b> · <i>${esc(clip(c.title, 40))}</i>`)].join('\n'),
        { reply_markup: kb(rows.map((c, i) => [{ text: '↪️ ' + t('bot.list.continue', { n: i + 1 }), callback_data: `c:${c.id.slice(0, 8)}` }, { text: '↗ ' + t('bot.list.open', { n: i + 1 }), url: `${base()}/#${c.id}` }])) }));
    }
    if (/^\/recover(@\w+)?$/i.test(text)) { const d = buildRecover(await onRecoverList(), Date.now(), false); return void (await say(d.text, d.rows ? { reply_markup: kb(d.rows) } : {})); }
    if (/^\/routines(@\w+)?$/i.test(text) && onRoutineList) { const d = onRoutineList(); return void (await say(d.text, { reply_markup: kb(d.rows) })); }
    const sc = new RegExp(`^/(${seats.join('|')})(?:@\\w+)?\\s+([\\s\\S]+)`, 'i').exec(text);
    if (sc) { let out; try { const seat = sc[1].toLowerCase(); await onNewTask({ seat, model: null, mode: 'auto', text: sc[2].trim() }); out = startedLine(seat, null, 'auto'); } catch (e) { out = errLine(t('bot.notStarted'), e.message); } return void (await say(out)); }
    const mp = /^\/multi(?:@\w+)?(?:[ \t]+([^\n]*))?(?:\n([\s\S]*))?$/i.exec(text);   // /multi Name | /folder (optional) + the brief on the next lines
    if (mp && onMulti) {
      const [name, dir] = String(mp[1] || '').split('|').map((x) => x.trim()), brief = String(mp[2] || '').trim();
      if (!name || !brief) return void (await say(`🧩 <code>/multi ${t('bot.multi.usageName')} | /${t('bot.multi.usageFolder')}</code>\n${t('bot.multi.usageBrief')}`));
      let out; try { const p = await onMulti({ name, dir, brief }); out = `🧩 <b>${esc(p.name)}</b>: ${t('bot.multi.planning', { seat: `<b>${esc(p.owner)}</b>` })} · <code>${esc(p.dir)}</code>\n${t('bot.multi.planReadyNote')}`; } catch (e) { out = errLine(t('bot.notStarted'), e.message); }
      return void (await say(out));
    }
    if (text.startsWith('/')) return void (await say('🤷 ' + t('bot.unknownCommand', { help: '<code>/help</code>' })));
    // 3. a plain message: continues the conversation picked with "continue", else becomes a new task
    if (live(cont)) { const c = cont; cont = null; return void (await deliver(c.convId, text, msg, say, reqs)); }
    if (msg.photo?.length || doc) return void (await say('📎 ' + t('bot.filesReply')));
    if (!text) return;
    const pid = Math.random().toString(16).slice(2, 8);
    for (const [k, v] of pickers) if (!live(v)) pickers.delete(k);
    pickers.set(pid, { text, at: Date.now() });
    await say(`${taskQuote(text)}\n${t('bot.pick.seat')}`, { reply_markup: seatKb(pid, await onUsage().catch(() => ({}))) });
  }
  async function deliver(convId, text, msg, say, reqs) {
    let images = [], files = [];
    const isDoc = !msg.photo?.length && !!(msg.document || msg.video || msg.audio || msg.voice);
    if (msg.photo?.length || isDoc) {
      if (!onReply.acceptsImages) return void (await say('📷 ' + t('bot.photosConsoleOnly')));
      let got; try { got = await reqs(); } catch (e) { return void (await say(e.tooBig ? `📎 <b>${t('bot.file.tooBigTitle')}</b> · ${t('bot.file.tooBig')}` : `❌ <b>${t(isDoc ? 'bot.file.downloadFailed' : 'bot.photo.downloadFailed')}</b>`)); }
      if (isDoc) files = got; else images = got;
    }
    if (!text && !images.length && !files.length) return void (await say('✍️ ' + t(onReply.acceptsImages ? 'bot.nothingToSendMedia' : 'bot.nothingToSend')));
    let out; try { out = await onReply(convId, { text: text || (files.length ? 'See the attached file.' : 'See the attached image.'), images, files }); } catch (e) { out = errLine(t('bot.notSent'), e.message); }
    await say(out);
  }

  // Picker / continue buttons. Returns the toast text; the picker message itself is edited in place (HTML).
  async function pickerStep(cfg, cb) {
    const [kind, a, b] = cb.data.split(':');
    if (kind === 'r') {
      if (a !== 'no' && a !== 'all' && !/^[0-9a-f]{8}$/.test(a)) return t('bot.toast.unknownButton');
      const left = async () => { const d = buildRecover(await onRecoverList(), Date.now(), true); return d.rows || []; };
      const setKb = async (rows) => call(cfg, 'editMessageReplyMarkup', { chat_id: cfg.chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: rows } }).catch(() => {});
      if (a === 'no') { await setKb([]); return t('bot.toast.notNow'); }
      const res = await onRecover(a);
      await setKb(await left());   // buttons of conversations already resumed disappear, so a second tap has nothing to press
      const lines = [...res.resumed.map((c) => `▶️ <b>${esc(c.seat)}</b> · <i>${esc(clip(c.title, 40))}</i>`), ...res.failed.map((c) => `⚠️ <b>${esc(c.seat)}</b> · <i>${esc(clip(c.title, 40))}</i> · <code>${escClip(c.error, 120)}</code>`)];
      if (lines.length) await callH(cfg, 'sendMessage', { chat_id: cfg.chatId, text: [`<b>${t('bot.recover.resumed', { n: num(res.resumed.length) })}</b>`, ...lines].join('\n'), reply_to_message_id: cb.message.message_id, allow_sending_without_reply: true }).catch(() => {});
      return res.resumed.length ? t('bot.toast.resumed', { n: num(res.resumed.length) }) : res.failed.length ? t('bot.toast.failedSee') : t('bot.toast.alreadyResumed');
    }
    const edit =(text, markup) => callH(cfg, 'editMessageText', { chat_id: cfg.chatId, message_id: cb.message.message_id, text, ...(markup ? { reply_markup: markup } : {}) }).catch(() => {});
    if (kind === 'q') {   // routine ask / run-now buttons: routines.mjs decides, we only show its answer
      const out = await onRoutineTap(cb.data);
      if (out.edit) await edit(out.edit.text, out.edit.rows ? kb(out.edit.rows) : undefined);
      return out.toast;
    }
    if (kind === 'x' && onMultiApprove) {   // "approve and dispatch" under a multi-sided plan; the button goes, one tap
      if (!/^[0-9a-f]{8}$/.test(a)) return t('bot.toast.unknownButton');
      let out; try { out = await onMultiApprove(a); } catch (e) { return String(e.message || e).slice(0, 190); }
      await call(cfg, 'editMessageReplyMarkup', { chat_id: cfg.chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return out;
    }
    if (kind === 'k') {   // "Compact" button on a finished-message
      if (!/^[0-9a-f]{8}$/.test(a)) return t('bot.toast.unknownButton');
      await onCompact(a);
      await call(cfg, 'editMessageReplyMarkup', { chat_id: cfg.chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});   // one tap, one compaction
      return t('bot.toast.compacting');
    }
    if (kind === 'c') {
      const c = findConv(a); if (!c) return t('bot.toast.convNotFound');
      cont = { convId: c.id, at: Date.now() };
      await callH(cfg, 'sendMessage', { chat_id: cfg.chatId, text: '↪️ ' + t('bot.list.nextGoesTo', { seat: `<b>${esc(c.seat)}</b>` }) + ` · <i>${esc(clip(c.title, 40))}</i>` }).catch(() => {});
      return t('bot.toast.nextContinues');
    }
    const p = pickers.get(a);
    if (!live(p)) { pickers.delete(a); await edit(`⌛ <b>${t('bot.pick.expired')}</b> · ${t('bot.pick.sendAgain')}`); return t('bot.toast.expired'); }
    if (kind === 's') { p.seat = b; await edit(`${taskQuote(p.text)}\n<b>${esc(p.seat)}</b> · ${t('bot.pick.model')}`, modelKb(a)); return p.seat; }
    if (kind === 'm') { p.model = MODELS[+b]?.[1] ?? null; await edit(`${taskQuote(p.text)}\n<b>${esc(p.seat)}</b> · ${esc(modelName(MODELS[+b]))} · ${t('bot.pick.mode')}`, modeKb(a)); return t('bot.toast.modelSet'); }
    if (kind === 'd') {
      if (b !== 'auto' && b !== 'ask') return t('bot.toast.unknownMode');   // bypass is deliberately not reachable from a phone chat
      pickers.delete(a);
      let out; try { await onNewTask({ seat: p.seat, model: p.model, mode: b, text: p.text }); out = startedLine(p.seat, p.model, b); } catch (e) { out = errLine(t('bot.notStarted'), e.message); }
      await edit(`${taskQuote(p.text)}\n${out}`); return t('bot.toast.ok');
    }
    return t('bot.toast.unknownButton');
  }

  async function handleUpdate(cfg, u) {
    const msg = u.message;
    // Link ONLY on "/start <code>" with the one-time code from the server log / telegram-link-code.txt: whoever finds the bot first must not win the chat.
    if (!cfg.chatId && msg && msg.chat?.type === 'private') {
      const m = /^\/start\s+([0-9a-f]{8})\s*$/i.exec((msg.text || '').trim());
      const code = ensureLinkCode();
      if (!m || m[1].toLowerCase() !== code) return;
      const next = { ...cfg, chatId: String(msg.chat.id) };
      fs.writeFileSync(cfgFile, JSON.stringify(next, null, 2));
      log('telegram chat linked'); linkCode = null; if (linkCodeFile) fs.rmSync(linkCodeFile, { force: true });
      await callH(next, 'sendMessage', { chat_id: next.chatId, text: '🔗 ' + t('bot.linked', { name: '<b>Seat Console</b>', help: '<code>/help</code>' }) }).catch(() => {});
      return;
    }
    if (msg && cfg.chatId && String(msg.chat?.id) === String(cfg.chatId)) return handleMessage(cfg, msg).catch((e) => log('telegram message failed: ' + e.message));
    const cb = u.callback_query;
    if (!cb || !cfg.chatId) return;
    if (String(cb.message?.chat?.id) !== String(cfg.chatId)) { await call(cfg, 'answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {}); return; } // strangers are ignored
    if (/^[smdcrqkx]:/.test(cb.data || '')) { let toast; try { toast = await pickerStep(cfg, cb); } catch (e) { toast = t('bot.toast.failed', { error: e.message }); } await call(cfg, 'answerCallbackQuery', { callback_query_id: cb.id, text: clip(toast, 190) }).catch(() => {}); return; }
    const p = parseCallback(cb.data);
    let outcome;
    if (!p) outcome = t('bot.toast.unknownButton');
    else { try { outcome = await onDecision(p.convShort, p.requestId, p.allow); } catch (e) { outcome = t('bot.toast.notApplied', { error: e.message }); } }
    log(`telegram approval tap ${cb.data} -> ${outcome}`);   // the only record of a tap that did not go through (2026-11-21 had none)
    await call(cfg, 'answerCallbackQuery', { callback_query_id: cb.id, text: clip(outcome === 'Allowed' ? t('bot.perm.allowed') : outcome === 'Denied' ? t('bot.perm.denied') : outcome, 190) }).catch(() => {});
    // The original keeps its formatting (editing the text would flatten the <pre>): drop the buttons and answer under it.
    await call(cfg, 'editMessageReplyMarkup', { chat_id: cfg.chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    const line = outcome === 'Allowed' ? `✅ <b>${t('bot.perm.allowed')}</b>` : outcome === 'Denied' ? `🚫 <b>${t('bot.perm.denied')}</b>` : `⚠️ <b>${t('bot.perm.notDone')}</b> · <code>${escClip(outcome, 200)}</code>`;
    await callH(cfg, 'sendMessage', { chat_id: cfg.chatId, text: line, reply_to_message_id: cb.message.message_id, allow_sending_without_reply: true }).catch(() => {});
  }

  // Random 8-hex code made while no chat is linked; handed to the user through the log and a gitignored file, never through Telegram.
  let linkCode = null;
  function ensureLinkCode() {
    if (!linkCode) {
      linkCode = crypto.randomBytes(4).toString('hex');
      if (linkCodeFile) fs.writeFileSync(linkCodeFile, linkCode);
      log(`telegram: send /start ${linkCode} to link`);
    }
    return linkCode;
  }
  // Long-poll loop: getUpdates (timeout 30) while configured; re-checks the file every idleMs while not.
  let stopped = false, commandsFor = null, conflicts = 0;
  async function loop() {
    let offset = getOffset() || 0; // persisted by the host app: a restart must not replay the updates Telegram still holds
    while (!stopped) {
      const cfg = readCfg();
      if (!cfg) { if (!warned) { warned = true; log('telegram: not configured'); } await new Promise((r) => setTimeout(r, idleMs)); continue; }
      try {
        if (!cfg.chatId) ensureLinkCode();
        if (commandsFor && commandsFor.split('|')[0] !== cfg.botToken) { offset = 0; setOffset(0); } // the token changed while running: another bot's update ids start over
        if (commandsFor !== cfg.botToken + '|' + lang()) { await call(cfg, 'setMyCommands', { commands: [{ command: 'status', description: t('bot.cmd.status') }, ...seats.map((s) => ({ command: s, description: t('bot.cmd.seat', { seat: s }) })), { command: 'digest', description: t('bot.cmd.digest') }, { command: 'evening', description: t('bot.cmd.evening') }, { command: 'list', description: t('bot.cmd.list') }, { command: 'recover', description: t('bot.cmd.recover') }, { command: 'routines', description: t('bot.cmd.routines') }, { command: 'multi', description: t('bot.cmd.multi') }] }); commandsFor = cfg.botToken + '|' + lang(); }   // the menu follows a language change too
        const ups = await call(cfg, 'getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] }, 45000);
        for (const u of ups) { offset = u.update_id + 1; setOffset(offset); await handleUpdate(readCfg() || cfg, u); }
      } catch (e) {
        log('telegram poll failed: ' + e.message);
        // 409 = a second process polls this bot token: Telegram hands each update to only one of them, so button taps and replies land in a console that
        // does not know the conversation. Said once per process at the 3rd conflict, not reset by a won poll: two pollers alternate wins. Sending still works.
        if (/^getUpdates: 409/.test(e.message) && ++conflicts === 3) { log('telegram: another bot instance is polling this token'); send(CONFLICT_TEXT).catch(() => {}); }
        await new Promise((r) => setTimeout(r, retryMs));
      }
    }
  }
  // The post-crash message: null when nothing is interrupted or Telegram is off / not reachable (the caller retries).
  async function offerRecover(crash) { const list = await onRecoverList(); if (!list.length) return null; const d = buildRecover(list, Date.now(), crash); return send(d.text, d.rows); }
  // edit a message we sent earlier (a routine ask that expired or was started from the web)
  const editSent = async (messageId, text, rows) => { const cfg = readCfg(); if (!cfg?.chatId) return null; return callH(cfg, 'editMessageText', { chat_id: cfg.chatId, message_id: messageId, text, disable_web_page_preview: true, ...(rows ? { reply_markup: { inline_keyboard: rows } } : {}) }); };
  return { send, edit: editSent, notify, sendFiles, permButtons, compactButton, offerRecover, handleUpdate, readCfg, start: () => { loop(); }, stop: () => { stopped = true; } };
}
