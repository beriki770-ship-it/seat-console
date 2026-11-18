// Recurring routines for the Seat Console. HARD RULE: a routine NEVER runs unattended. At its due time the console only ASKS
// (one Telegram message with "run" / "skip" buttons); the conversation starts when the user taps "run" (or presses "run now" in the web UI / Telegram).
// This file is the whole scheduler with every outside effect injected (deps), so the tests drive it with a fake clock and a fake Telegram.
//
// routines.json = [{ id, promptFile | prompt, cron, seat, cwd, enabled, mode, model?, effort? }], cron on the wall clock of `tz` (Europe/Vienna).
// The prompt is read from the file at RUN time (frontmatter stripped), never copied into the config.
// state.routines[id] = { lastAskedFor, askedAt, messageId, decision, decidedAt, conversationId, enabled?, lastRun? }
//   decision: pending | blocked (seat full: "anyway" or another seat; quota: "anyway" or skip only) | run | skip | expired | initial (first-ever start: past slots are never asked late)
import fs from 'node:fs';
import path from 'node:path';
import { parseCron, dueBetween, nextDue, wallAsUtc } from './cron.mjs';
import { esc, escClip, SEAT_EMOJI } from './telegram.mjs';
import { t, hm, fmt, pct } from './i18n.mjs';

export const TZ = process.env.SEAT_CONSOLE_TZ || 'Europe/Vienna';   // wall clock of the digests and routine crons (README: Configure)
export const GRACE_MS = 2 * 3600e3;     // PC was off at the due time: still ask if the server comes up within 2 h
export const EXPIRE_MS = 6 * 3600e3;    // an unanswered ask expires after 6 h
export const QUOTA_BLOCK = 0.95;        // at the cap or this full, the tap answers with alternatives instead of starting
const emoji = (seat) => SEAT_EMOJI[seat] || '🔹';

// ---- config ----
// Body of a SKILL.md: everything after the YAML frontmatter.
export const stripFrontmatter = (s) => String(s).replace(/^﻿/, '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
export function parseRoutines(json) {
  const list = Array.isArray(json) ? json : json?.routines;
  if (!Array.isArray(list)) throw new Error('routines.json must be an array');
  const ids = new Set();
  return list.map((r) => {
    if (!r.id || ids.has(r.id)) throw new Error(`routine id missing or duplicated: ${r.id}`);
    ids.add(r.id);
    if (!r.promptFile && typeof r.prompt !== 'string') throw new Error(`routine ${r.id}: promptFile or prompt required`);
    if (!r.seat || !r.cwd) throw new Error(`routine ${r.id}: seat and cwd required`);
    parseCron(r.cron);   // throws on a bad expression
    return { mode: 'auto', enabled: true, ...r, cwd: path.normalize(r.cwd), ...(r.promptFile ? { promptFile: path.normalize(r.promptFile) } : {}) };   // forward slashes in the JSON are easier to type
  });
}
export const promptOf = (r) => (typeof r.prompt === 'string' ? r.prompt : stripFrontmatter(fs.readFileSync(r.promptFile, 'utf8')));

// ---- formatting (Hebrew, Telegram HTML) ----
const ymd = (ms, tz = TZ) => new Date(wallAsUtc(ms, tz)).toISOString().slice(0, 10);
// "today 20:00" / "tomorrow 07:30" / "Wed 10:00 (14/10)", in the chosen language (i18n.mjs)
export function when(ms, now, tz = TZ) {
  if (ms == null) return '—';
  const d = Math.round((Date.parse(ymd(ms, tz)) - Date.parse(ymd(now, tz))) / 86400000), time = hm(ms, tz);
  return d === 0 ? t('bot.when.today', { time }) : d === 1 ? t('bot.when.tomorrow', { time }) : t('bot.when.day', { weekday: fmt(ms, { weekday: 'short' }, tz), time, date: fmt(ms, { day: 'numeric', month: 'numeric' }, tz) });
}
const head = (r, slot, seat = r.seat) => `⏰ <b>${esc(r.id)}</b> · ${emoji(seat)} ${t('bot.routine.head', { seat: esc(seat), time: hm(slot, TZ) })}`;
const slotMin = (slot) => Math.floor(slot / 60000);
export const cbData = (a, id, slot, seat) => ['q', a, id, slotMin(slot), seat].filter((x) => x !== undefined).join(':');

export function createRoutines({ file, state, save, deps, now = () => Date.now() }) {
  const { log = () => {} } = deps;
  const hadState = state.routines !== undefined;
  state.routines ??= {};
  let cfg = [], cfgMtime = 0, cfgBad = null, busy = false;
  const st = (id) => (state.routines[id] ??= {});
  const enabled = (r) => st(r.id).enabled ?? r.enabled;

  // Re-read when the file changed, so adding a routine needs no restart. A broken edit keeps the last good list (logged once).
  function load() {
    try {
      const m = fs.statSync(file).mtimeMs;
      if (m !== cfgMtime) { cfg = parseRoutines(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))); cfgMtime = m; cfgBad = null; }
    } catch (e) { if (e.message !== cfgBad) { cfgBad = e.message; log(`[routine] routines.json not loaded: ${e.message}`); } }
    return cfg;
  }
  const find = (id) => load().find((r) => r.id === id);
  const latestSlot = (r, t) => dueBetween(r.cron, t - GRACE_MS, t, TZ).at(-1);

  // First start on a state that never knew routines: slots that are already past are NOT asked retroactively (e.g. deploy at 21:00, nightly was 20:00).
  if (!hadState) {
    const t = now();
    for (const r of load()) { const slot = latestSlot(r, t); if (slot) { Object.assign(st(r.id), { lastAskedFor: slot, askedAt: t, decision: 'initial' }); log(`[routine] ${r.id}: slot ${new Date(slot).toISOString()} already passed at first start, marked as asked (not asked late)`); } }
    save();
  }

  const preview = (r) => { try { return promptOf(r); } catch { return t('bot.routine.promptUnreadable'); } };
  const askRows = (r, slot) => [[{ text: '▶️ ' + t('bot.routine.run'), callback_data: cbData('r', r.id, slot) }, { text: '⏭️ ' + t('bot.routine.skip'), callback_data: cbData('s', r.id, slot) }]];
  const askText = (r, slot) => [head(r, slot), `<blockquote expandable>${escClip(preview(r).replace(/\s+/g, ' '), 200)}</blockquote>`].join('\n');
  const pending = (s) => s.decision === 'pending' || s.decision === 'blocked';

  async function edit(s, text, rows) { if (s.messageId && deps.edit) await deps.edit(s.messageId, text, rows).catch((e) => log('[routine] edit failed: ' + e.message)); }

  // ---- starting ----
  // Starts the conversation (throws when the seat cannot take it). If an ask is open for this routine it is settled by this start.
  async function launch(r, { seat = r.seat, by }) {
    const tNow = now(), s = st(r.id);
    const conversationId = await deps.start({ routine: r, seat, title: `⏰ ${r.id} · ${ymd(tNow)}`, text: promptOf(r) });
    s.lastRun = { at: tNow, conversationId, seat, by };
    if (pending(s)) {
      const slot = s.lastAskedFor;
      Object.assign(s, { decision: 'run', decidedAt: tNow, conversationId });
      await edit(s, [head(r, slot, seat), '▶️ ' + t('bot.routine.startedOn', { seat: `<b>${esc(seat)}</b>` }) + ` · <a href="${deps.base()}/#${conversationId}">${t('bot.openInConsole')} ↗</a>`].join('\n'));
    }
    save(); log(`[routine] ${r.id} started by=${by} seat=${seat} conv=${conversationId.slice(0, 8)}`);
    return conversationId;
  }

  // ---- the periodic check: expire stale asks, ask for due slots. Never starts anything. ----
  async function tick() {
    if (busy) return; busy = true;
    try {
      const tNow = now();
      for (const r of load()) {
        const s = st(r.id);
        if (pending(s) && tNow - s.askedAt >= EXPIRE_MS) {
          s.decision = 'expired'; s.decidedAt = tNow; save(); log(`[routine] ${r.id}: ask expired`);
          await edit(s, [head(r, s.lastAskedFor), '⌛ ' + t('bot.pick.expired')].join('\n'));
        }
        if (!enabled(r)) continue;
        const slot = latestSlot(r, tNow);
        if (!slot || slot <= (s.lastAskedFor || 0)) continue;
        const m = await deps.ask(askText(r, slot), askRows(r, slot));
        if (!m && deps.telegramOn()) { log(`[routine] ${r.id}: ask not delivered, retrying`); continue; }   // network not up yet: the slot stays unasked
        Object.assign(s, { lastAskedFor: slot, askedAt: tNow, messageId: m?.message_id ?? null, decision: 'pending', decidedAt: null, conversationId: null });
        save(); log(`[routine] ask ${r.id} slot=${new Date(slot).toISOString()} telegram=${m ? 'sent' : 'off'}`);
      }
    } catch (e) { log('[routine] tick failed: ' + (e?.stack || e)); } finally { busy = false; }
  }

  // ---- a Telegram button: q:<a>:<id>:<slotMinute>[:<seat>]  (a = r run, s skip, f run anyway, t run on another seat) or q:n:<id> (run now) ----
  // Returns { toast, edit?: { text, rows } }.
  async function tap(data) {
    const [, a, id, slot, seat] = String(data).split(':'), r = find(id);
    if (!r || !/^[rsftn]$/.test(a || '')) return { toast: t('bot.toast.unknownButton') };
    const s = st(id);
    if (a === 'n') {
      try { await launch(r, { by: 'telegram-now' }); return { toast: t('bot.toast.started') }; } catch (e) { return { toast: t('bot.toast.failed', { error: e.message }) }; }
    }
    if (!pending(s) || String(slotMin(s.lastAskedFor)) !== slot) return { toast: t(s.decision === 'run' ? 'bot.toast.alreadyStarted' : 'bot.toast.alreadyHandled') };
    const slotMs = s.lastAskedFor;
    if (a === 's') { Object.assign(s, { decision: 'skip', decidedAt: now() }); save(); log(`[routine] ${r.id}: skipped`); return { toast: t('bot.toast.skipped'), edit: { text: [head(r, slotMs), '⏭️ ' + t('bot.routine.skipped')].join('\n') } }; }
    let target = r.seat;
    if ((a === 't' || a === 'f') && seat) { if (!deps.seatNames().includes(seat)) return { toast: t('bot.toast.unknownSeat') }; target = seat; }
    // Another seat only while the routine's own seat is NOT at its usage limit (an old "other seat" button from a process-cap block may be tapped later).
    if (target !== r.seat) { const own = full(r.seat); if (own?.quota) return { toast: own.plain, edit: blockedEdit(r, slotMs, r.seat, own) }; }
    if (a === 'r' || a === 't') {
      const why = full(target);
      if (why) return { toast: why.plain, edit: blockedEdit(r, slotMs, target, why) };
    }
    try { await launch(r, { seat: target, by: 'telegram' }); return { toast: t('bot.toast.started') }; }
    catch (e) { return { toast: t('bot.toast.failed', { error: e.message }), edit: { text: [head(r, slotMs, target), `❌ <code>${escClip(e.message, 200)}</code>`].join('\n'), rows: askRows(r, slotMs) } }; }
  }
  // At its process cap or (nearly) out of quota. null = free to use.
  function full(seat) {
    const l = deps.seatLoad(seat);
    // Usage first: a seat at its cap AND at its limit is a quota block (no other seats offered).
    if (l.usage != null && l.usage >= QUOTA_BLOCK) return { quota: true, plain: t('bot.routine.atPct', { seat, pct: pct(l.usage) }), line: `${emoji(seat)} ` + t('bot.routine.atQuota', { seat: `<b>${esc(seat)}</b>`, pct: pct(l.usage) }) };
    if (l.alive >= l.max) return { plain: t('bot.routine.full', { seat, n: `${l.alive}/${l.max}` }), line: `${emoji(seat)} ` + t('bot.routine.full', { seat: `<b>${esc(seat)}</b>`, n: `${l.alive}/${l.max}` }) };
    return null;
  }
  function blockedEdit(r, slot, target, why) {
    const s = st(r.id); s.decision = 'blocked'; save();
    // Other seats only when the seat is at its PROCESS cap (RAM). At its usage limit: run anyway or skip, never another seat (each seat's limit is its own).
    const alts = why.quota ? [] : deps.seatNames().filter((n) => n !== target && !full(n)).map((n) => ({ n, u: deps.seatLoad(n).usage ?? 0 })).sort((x, y) => x.u - y.u);
    return { text: [head(r, slot), `⚠️ ${why.line}`].join('\n'), rows: [
      [{ text: '▶️ ' + t('bot.routine.anyway', { seat: target }), callback_data: cbData('f', r.id, slot, target === r.seat ? undefined : target) }],
      ...alts.map((x) => [{ text: `${emoji(x.n)} ${x.n}${x.u ? ' ' + pct(x.u) : ''}`, callback_data: cbData('t', r.id, slot, x.n) }]),
      [{ text: '⏭️ ' + t('bot.routine.skip'), callback_data: cbData('s', r.id, slot) }]] };
  }

  // ---- web UI / API ----
  const view = () => load().map((r) => { const s = st(r.id), t = now(); return { id: r.id, seat: r.seat, cron: r.cron, cwd: r.cwd, mode: r.mode, enabled: enabled(r), nextDue: enabled(r) ? nextDue(r.cron, t, TZ) : null,
    lastAskedFor: s.lastAskedFor || null, decision: s.decision || null, conversationId: s.conversationId || null, lastRun: s.lastRun || null }; });
  async function act(id, action) {
    const r = find(id); if (!r) throw new Error('unknown routine');
    if (action === 'enable' || action === 'disable') { st(id).enabled = action === 'enable'; save(); return { ok: true, enabled: action === 'enable' }; }
    if (action === 'run') return { ok: true, conversationId: await launch(r, { by: 'web' }) };   // the user clicking: starts at once, no seat check (a full seat throws)
    throw new Error('unknown action');
  }

  // /routines in Telegram: every routine with its next due time and a run-now button.
  function listMessage() {
    const now0 = now(), rs = view(), lines = rs.map((r) => `${r.enabled ? emoji(r.seat) : '🔕'} <b>${esc(r.id)}</b> · ${esc(r.seat)} · ${r.enabled ? t('bot.routine.next', { when: when(r.nextDue, now0) }) : t('bot.routine.off')}`);
    return { text: [`<b>⏰ ${t('bot.routine.title')}</b>`, '', ...lines, '', `<i>${t('bot.routine.note')}</i>`].join('\n'),
      rows: rs.map((r) => [{ text: `▶️ ${t('bot.routine.runNow')} · ${r.id}`.slice(0, 60), callback_data: `q:n:${r.id}` }]) };
  }

  return { tick, tap, act, view, listMessage, start() { tick(); return setInterval(tick, 30000).unref(); } };
}
