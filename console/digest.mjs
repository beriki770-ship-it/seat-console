// Digests: ONE Telegram message at 08:00 and ONE at 21:00 Europe/Vienna (HTML, same style as the other bot messages).
// Pure functions only: server.mjs collects the facts (conversations, usage, server.log, routines), this file decides what is stuck / finished / worth a line and builds the text.
import { wallAsUtc, dueBetween } from './cron.mjs';
import { bar, resetTag, SEAT_EMOJI, esc, escClip, clip, summaryText } from './telegram.mjs';
import { t, tn, hm, fmt, num } from './i18n.mjs';

export const TZ = process.env.SEAT_CONSOLE_TZ || 'Europe/Vienna';   // wall clock of the digests and routine crons (README: Configure)
export const MORNING_CRON = '0 8 * * *', EVENING_CRON = '0 21 * * *';
export const LATE_MS = 5 * 60e3;                                 // sent more than 5 min after its slot (server off, Telegram down) = the message says it is late
export const STUCK_WORKING_MS = 30 * 60e3, STUCK_WAITING_MS = 15 * 60e3;
export const FINISHED_MAX = 6, STUCK_MAX = 6;

const wall = (ms) => new Date(wallAsUtc(ms, TZ));
export const viennaYmd = (ms) => wall(ms).toISOString().slice(0, 10);
export const viennaHour = (ms) => wall(ms).getUTCHours();
export const viennaHm = (ms) => wall(ms).toISOString().slice(11, 16);
const lastSlot = (cron, now) => dueBetween(cron, now - 36 * 3600e3, now, TZ).at(-1);
// The digest to send now, or null. Only the MOST RECENT slot (08:00 or 21:00, whichever passed last) is ever sent, as soon as the server runs:
// a server that was off all day sends the 21:00 one and says the 08:00 one was skipped; anything older is never sent (it is never the latest).
// sent = { lastDigestFor, lastEveningFor } (Vienna dates of the delivered slots; saved only after a delivered send, so a restart never sends twice).
export function dueSlot(sent, now) {
  const m = lastSlot(MORNING_CRON, now), e = lastSlot(EVENING_CRON, now), kind = e > m ? 'evening' : 'morning', at = Math.max(m, e);
  const key = (k) => (k === 'evening' ? sent.lastEveningFor : sent.lastDigestFor);
  if (key(kind) === viennaYmd(at)) return null;
  const other = kind === 'evening' ? 'morning' : 'evening', oAt = Math.min(m, e);
  // undefined = that digest never ran on this server (first deploy): nothing was skipped
  const skipped = key(other) !== undefined && key(other) !== viennaYmd(oAt) && now - oAt <= 24 * 3600e3 ? { kind: other, at: oAt } : null;
  return { kind, at, ymd: viennaYmd(at), late: now - at > LATE_MS, skipped };
}
// The most recent 20:00 (Vienna wall clock) at or before `now`: "overnight" starts there.
export const overnightSince = (now) => lastSlot('0 20 * * *', now);
// The most recent 08:00 at or before `now`: the evening digest covers the day from there (a late one sent at 07:00 still covers the day before).
export const daySince = (now) => lastSlot(MORNING_CRON, now);
// The window and the routine day of one digest. A late one (slot from dueSlot) covers ITS slot's window, not the hours before it was sent: a morning digest sent at 20:30
// still covers since 20:00 the evening before. Evening routines are "tomorrow" of the slot's day; on demand (slot null) of the current 08:00 day, so /evening at 01:00 lists today.
export function digestRefs(kind, now, slot) {
  const ref = slot?.at ?? now, evening = kind === 'evening';
  return { since: evening ? daySince(ref) : overnightSince(ref), routinesAt: evening ? (slot ? slot.at : daySince(now)) + 24 * 3600e3 : now };
}

// convs = [{ id, seat, title, status (effective), lastAt (ms of the last event, working/waiting only), resultAt, result }]
// Stuck: working with no event for > 30 min, or waiting for an approval > 15 min. Finished overnight: idle/stopped with a result since `since` (newest first, at most FINISHED_MAX).
export function classify(convs, now, since) {
  const stuck = [], finished = [];
  for (const c of convs) {
    const quiet = now - (c.lastAt || now);
    if (c.status === 'working' && quiet > STUCK_WORKING_MS) stuck.push({ ...c, kind: 'working', quietMs: quiet });
    else if (c.status === 'waiting' && quiet > STUCK_WAITING_MS) stuck.push({ ...c, kind: 'waiting', quietMs: quiet });
    else if ((c.status === 'idle' || c.status === 'stopped') && c.resultAt >= since) finished.push(c);
  }
  stuck.sort((a, b) => b.quietMs - a.quietMs); finished.sort((a, b) => b.resultAt - a.resultAt);
  return { stuck, finished: finished.slice(0, FINISHED_MAX), finishedTotal: finished.length };
}

// Count of "error-ish" lines stamped at/after `sinceMs` in server.log text, and the last one. server.mjs stamps every line "YYYY-MM-DDTHH:MM:SSZ <text>" (UTC); lines without a stamp (stack traces, old format) are ignored.
const ERRORISH = /\b(error|errors|failed|fail|exception|unhandled|warn|warning|skipped|crash\w*|EPIPE|ECONN\w+)\b|did not answer|alive but silent/i;
export function scanLog(text, sinceMs) {
  let count = 0, last = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)Z (.*)$/.exec(line);
    if (!m || Date.parse(m[1] + 'Z') < sinceMs || !ERRORISH.test(m[2])) continue;
    count++; last = m[2];
  }
  return { count, last };
}

// Every slot of an enabled routine that falls on the Vienna date of `now`: [{ id, seat, at }] sorted by time. list = routines.view() rows.
// The evening digest passes a time on the next day for "tomorrow".
export function digestRoutines(list, now) {
  const today = viennaYmd(now), midnight = dueBetween('0 0 * * *', now - 30 * 3600e3, now, TZ).at(-1), out = [];
  for (const r of list) if (r.enabled) for (const at of dueBetween(r.cron, midnight - 1, midnight + 26 * 3600e3, TZ)) if (viennaYmd(at) === today) out.push({ id: r.id, seat: r.seat, at });
  return out.sort((a, b) => a.at - b.at);
}

const mins = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? tn('bot.dur.min', m) : tn('bot.dur.h', Math.round(m / 60)); };
const slotName = (kind) => t(kind === 'evening' ? 'bot.digest.evening' : 'bot.digest.morning');
const at = (ms) => hm(ms, TZ);
// d = { seats:[{ name, usage: 0..1|null, resetsAt }], stuck, finished, finishedTotal, errors:{count,last}, sinceLabel, routines:[{id,seat,at}], slot?: dueSlot() result } -> { text (HTML), rows (inline keyboard | null) }
export const buildMorningDigest = (d, now, base) => buildDigest(d, now, base, false);
// Evening: the same sections for the day since 08:00 and tomorrow's routines; no usage block (d.seats is not read).
export const buildEveningDigest = (d, now, base) => buildDigest(d, now, base, true);
function buildDigest(d, now, base, evening) {
  const lines = [];
  // a late slot says so in its FIRST line: the user reads "21:00" at 07:00 and must know why
  if (d.slot?.late) lines.push(`⏰ <b>${t('bot.digest.late')}</b> · ${t('bot.digest.lateWhy', { time: at(d.slot.at) })}`);
  if (d.slot?.skipped) lines.push(`<i>${t('bot.digest.skipped', { digest: slotName(d.slot.skipped.kind), time: at(d.slot.skipped.at) })}</i>`);
  if (lines.length) lines.push('');
  lines.push(`${evening ? '🌆' : '☀️'} <b>${t(evening ? 'bot.digest.goodEvening' : 'bot.digest.goodMorning')}</b> · <i>${fmt(now, { weekday: 'long', day: 'numeric', month: 'numeric' }, TZ)}</i>`, '');
  if (!evening) {
    lines.push(`<b>📊 ${t('bot.digest.quota')}</b>`);
    for (const s of d.seats) lines.push(`${SEAT_EMOJI[s.name] || '🔹'} <b>${esc(s.name)}</b>  ${s.usage == null ? `<i>${t('bot.digest.noData')}</i>` : [bar(s.usage), resetTag(s.resetsAt, now)].filter(Boolean).join(' · ')}`);
    lines.push('');
  }
  const rows = [];
  if (d.stuck.length) {
    lines.push(`⚠️ <b>${t('bot.digest.stuck')}</b> (${num(d.stuck.length)})`);
    for (const c of d.stuck.slice(0, STUCK_MAX)) {
      lines.push(`${c.kind === 'waiting' ? '⏳' : '⚙️'} <b>${esc(c.seat)}</b> · <i>${escClip(c.title, 40)}</i> · ${t(c.kind === 'waiting' ? 'bot.digest.waitingFor' : 'bot.digest.idleFor', { time: mins(c.quietMs) })}`);
      rows.push([{ text: `↗ ${c.seat} · ${clip(c.title, 24)}`, url: `${base}/#${c.id}` }]);
    }
    if (d.stuck.length > STUCK_MAX) lines.push(`<i>${t('bot.more', { n: d.stuck.length - STUCK_MAX })}</i>`);
  } else lines.push('✅ ' + t('bot.digest.nothingStuck'));
  lines.push('');
  if (d.finished.length) {
    lines.push(`${evening ? '✅' : '🌙'} <b>${t(evening ? 'bot.digest.finishedToday' : 'bot.digest.finishedOvernight')}</b> (${num(d.finishedTotal)})`);
    for (const c of d.finished) {
      const sum = summaryText(c.result) || String(c.result || '').replace(/\s+/g, ' ').trim();
      lines.push(`${SEAT_EMOJI[c.seat] || '🔹'} <b>${esc(c.seat)}</b> · <i>${escClip(c.title, 40)}</i>`);
      if (sum) lines.push(`<blockquote>${escClip(sum, 120)}</blockquote>`);
    }
    if (d.finishedTotal > d.finished.length) lines.push(`<i>${t('bot.more', { n: d.finishedTotal - d.finished.length })}</i>`);
  } else lines.push(evening ? '✅ ' + t('bot.digest.noneToday') : '🌙 ' + t('bot.digest.noneOvernight'));
  lines.push('');
  lines.push(d.errors.count ? `🛠 <b>${t('bot.digest.errorsSince', { time: d.sinceLabel })}</b>: ${num(d.errors.count)}\n<code>${escClip(d.errors.last, 140)}</code>` : '🛠 ' + t('bot.digest.noErrors', { time: d.sinceLabel }));
  lines.push('');
  if (d.routines.length) { lines.push(`⏰ <b>${t(evening ? 'bot.digest.routinesTomorrow' : 'bot.digest.routinesToday')}</b>`); for (const r of d.routines.slice(0, 8)) lines.push(r.at < now ? `<s>${at(r.at)} · ${esc(r.seat)} · ${esc(r.id)}</s>` : `${at(r.at)} · ${SEAT_EMOJI[r.seat] || '🔹'} <b>${esc(r.seat)}</b> · ${esc(r.id)}`); if (d.routines.length > 8) lines.push(`<i>${t('bot.more', { n: d.routines.length - 8 })}</i>`); }
  else lines.push('⏰ ' + t(evening ? 'bot.digest.noRoutinesTomorrow' : 'bot.digest.noRoutinesToday'));
  return { text: lines.join('\n'), rows: rows.length ? rows : null };
}
