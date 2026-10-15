// 5-field cron (minute hour day-of-month month day-of-week) evaluated on the WALL CLOCK of one IANA time zone.
// Supports *, numbers, lists (1,5), ranges (1-5) and steps (*/15, 1-10/3). Day-of-week 0 or 7 = Sunday.
// Like Vixie cron: when BOTH day-of-month and day-of-week are restricted, a day matches if EITHER does.
// DST: a wall time that does not exist (spring gap) is skipped; one that happens twice (autumn) fires at its first occurrence.
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseField(src, [lo, hi]) {
  const out = new Set();
  for (const part of src.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`bad cron field "${src}"`);
    const step = m[2] === undefined ? 1 : +m[2];
    if (step < 1) throw new Error(`bad cron step in "${src}"`);
    let a, b;
    if (m[1] === '*') [a, b] = [lo, hi];
    else { const [x, y] = m[1].split('-'); a = +x; b = y === undefined ? (m[2] === undefined ? +x : hi) : +y; }
    if (a < lo || b > hi || a > b) throw new Error(`cron value out of range in "${src}"`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron needs 5 fields: "${expr}"`);
  const [min, hour, dom, mon, dow] = f.map((s, i) => parseField(s, RANGES[i]));
  if (dow.has(7)) dow.add(0);
  return { min: [...min].sort((a, b) => a - b), hour: [...hour].sort((a, b) => a - b), dom, mon, dow, domAny: f[2] === '*', dowAny: f[4] === '*' };
}

// ---- time zone helpers (Intl only, no dependency) ----
const fmts = new Map();
const fmt = (tz) => { let f = fmts.get(tz); if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); fmts.set(tz, f); } return f; };
// The wall clock of instant `ms` in `tz`, as the UTC timestamp of the same digits.
export function wallAsUtc(ms, tz) {
  const p = {}; for (const x of fmt(tz).formatToParts(new Date(ms))) p[x.type] = +x.value;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}
// The instants (ms) whose wall clock in tz reads exactly y-m-d h:mi (0, 1 or 2 of them: DST gap / overlap).
function wallToInstants(y, m, d, h, mi, tz) {
  const want = Date.UTC(y, m - 1, d, h, mi), out = new Set();
  for (const off of [-3, -2, -1, 0, 1, 2, 3]) { const guess = want - off * 3600000; if (wallAsUtc(guess, tz) === want) out.add(guess); }
  return [...out].sort((a, b) => a - b);
}

// Due instants (ms, ascending) strictly after `fromMs` and at or before `toMs`.
export function dueBetween(cron, fromMs, toMs, tz) {
  const c = typeof cron === 'string' ? parseCron(cron) : cron, out = [];
  const start = new Date(wallAsUtc(fromMs, tz)), end = wallAsUtc(toMs, tz);
  for (let day = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() - 1); day <= end + 86400000; day += 86400000) {
    const d = new Date(day), y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, dd = d.getUTCDate(), wd = d.getUTCDay();
    if (!c.mon.has(m)) continue;
    const domOk = c.dom.has(dd), dowOk = c.dow.has(wd);
    if (!(c.domAny || c.dowAny ? domOk && dowOk : domOk || dowOk)) continue;
    for (const h of c.hour) for (const mi of c.min) {
      const hit = wallToInstants(y, m, dd, h, mi, tz)[0];
      if (hit !== undefined && hit > fromMs && hit <= toMs) out.push(hit);
    }
  }
  return out.sort((a, b) => a - b);
}

// The first due instant after `afterMs` (searches up to 400 days; null when the expression never fires).
export function nextDue(cron, afterMs, tz) {
  const c = typeof cron === 'string' ? parseCron(cron) : cron;
  for (let from = afterMs, i = 0; i < 14; i++, from += 30 * 86400000) {
    const hits = dueBetween(c, from, from + 30 * 86400000, tz);
    if (hits.length) return hits[0];
  }
  return null;
}
