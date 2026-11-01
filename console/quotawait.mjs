// Auto-resume after a usage limit. A turn that ends on "You've hit your session limit · resets 6:10pm (Europe/Vienna)"
// (result: is_error, api_error 'usage_limit_reached', status 429) is marked; once the limit has reset the console sends it a "continue" message.
// Pure functions, tested by test-quotawait.mjs; server.mjs owns the timer and the send.
export const MARGIN_MS = 2 * 60e3;        // resume this long after the reset: the first request right at the reset can still be refused
export const FALLBACK_MS = 30 * 60e3;     // no reset time known: try again in 30 min (a refused try only re-arms the wait)
export const MAX_TRIES = 8;               // this many resumes in a row that hit the limit again: stop, it needs a person

export const RESUME_TEXT = 'The usage limit has reset. Your last turn stopped on the limit, so it was cut off. Do not start over: check what is already on disk (files you wrote, the project\'s docs/HANDOFF.md, git status) and the output of background agents that died on the limit, then continue the task from where it stopped and restart only the agents whose work is missing.';

export const isQuotaStop = (ev) => ev?.type === 'result' && !!ev.is_error
  && (ev.api_error === 'usage_limit_reached' || (ev.api_error_status === 429 && /hit your (\w+ )?limit/i.test(String(ev.result || ''))));   // not a short rate_limit 429

const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// Wall-clock parts of `t` in time zone `tz`, and the zone's offset from UTC at `t` (ms).
function zoned(t, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(t)).filter((x) => x.type !== 'literal').map((x) => [x.type, +x.value]));
  return { ...p, offset: Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000 };
}
// "resets 6:10pm (Europe/Vienna)", "resets 9am (Europe/Vienna)", "resets Nov 3, 9am (Europe/Vienna)" -> epoch ms of that moment after `now`; null when not found.
export function parseReset(text, now = Date.now()) {
  const m = /resets\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i.exec(String(text || ''));
  if (!m) return null;
  let h = +m[3]; const min = +(m[4] || 0), ap = (m[5] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  let tz = m[6] || 'UTC'; try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = 'UTC'; }
  const z = zoned(now, tz), mon = m[1] ? MON[m[1].toLowerCase()] : undefined;
  if (m[1] && mon === undefined) return null;
  let at = Date.UTC(z.year, mon ?? z.month - 1, m[2] ? +m[2] : z.day, h, min) - z.offset;
  if (at <= now) at = m[1] ? Date.UTC(z.year + 1, mon, +m[2], h, min) - z.offset : at + 24 * 3600e3;   // a time already passed today means tomorrow
  return at + z.offset - zoned(at, tz).offset;   // the offset at the reset itself (a daylight-saving switch in between moves it an hour)
}
// When to resume: the reset named in the message, else the latest reset of a usage window that is (nearly) full, else FALLBACK_MS from now. Plus MARGIN_MS.
export function resumeAt(ev, windows, now = Date.now()) {
  let at = parseReset(ev?.result, now);
  if (at == null) {
    const full = Object.values(windows || {}).filter((w) => typeof w?.resetsAt === 'number' && w.resetsAt * 1000 > now && (w.utilization ?? 0) >= 0.95).map((w) => w.resetsAt * 1000);
    at = full.length ? Math.max(...full) : now + FALLBACK_MS - MARGIN_MS;
  }
  return at + MARGIN_MS;
}
