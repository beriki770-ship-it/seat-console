// node console/test-quotawait.mjs: auto-resume after a usage limit (quotawait.mjs).
import assert from 'node:assert/strict';
import { isQuotaStop, parseReset, resumeAt, MARGIN_MS, FALLBACK_MS } from './quotawait.mjs';
let n = 0; const pass = (m) => { n++; console.log('ok  ' + m); };

const stop = { type: 'result', is_error: true, subtype: 'success', api_error_status: 429, api_error: 'usage_limit_reached', result: "You've hit your session limit · resets 6:10pm (Europe/Vienna)" };
assert.ok(isQuotaStop(stop));
assert.ok(isQuotaStop({ type: 'result', is_error: true, api_error_status: 429, result: "You've hit your weekly limit" }));
assert.ok(!isQuotaStop({ ...stop, is_error: false }), 'a normal reply that mentions the limit is not a stop');
assert.ok(!isQuotaStop({ type: 'result', is_error: true, api_error_status: 500, result: 'Internal error' }));
assert.ok(!isQuotaStop({ type: 'result', is_error: true, api_error_status: 429, result: 'API Error: rate limit, retry' }), 'a short rate_limit 429 is not a usage-limit stop');
assert.ok(!isQuotaStop({ type: 'assistant', is_error: true, api_error: 'usage_limit_reached' }));
pass('isQuotaStop: only an error result from the usage limit');

// 2026-11-01 15:00 Vienna = 14:00 UTC (CET, +1)
const now = Date.UTC(2026, 10, 1, 14, 0);
assert.equal(parseReset(stop.result, now), Date.UTC(2026, 10, 1, 17, 10), '6:10pm Vienna = 17:10 UTC');
assert.equal(parseReset("resets 9am (Europe/Vienna)", now), Date.UTC(2026, 10, 2, 8, 0), 'a time already passed today is tomorrow');
assert.equal(parseReset("resets 12am (Europe/Vienna)", now), Date.UTC(2026, 10, 1, 23, 0), '12am = midnight');
assert.equal(parseReset("resets Nov 3, 9am (Europe/Vienna)", now), Date.UTC(2026, 10, 3, 8, 0), 'a date is used');
assert.equal(parseReset("resets 4pm (America/New_York)", now), Date.UTC(2026, 10, 1, 21, 0), 'another zone (EST, -5)');
assert.equal(parseReset("resets 4pm (Not/AZone)", now), Date.UTC(2026, 10, 1, 16, 0), 'an unknown zone falls back to UTC');
assert.equal(parseReset("You've hit your limit", now), null);
assert.equal(parseReset("resets 25:00", now), null);
// summer time: 2026-07-01 15:00 Vienna = 13:00 UTC (CEST, +2)
assert.equal(parseReset("resets 6:10pm (Europe/Vienna)", Date.UTC(2026, 6, 1, 13, 0)), Date.UTC(2026, 6, 1, 16, 10), 'CEST');
// across the switch back to CET on 2026-10-25 (03:00 CEST -> 02:00 CET)
assert.equal(parseReset("resets Oct 26, 9am (Europe/Vienna)", Date.UTC(2026, 9, 24, 10, 0)), Date.UTC(2026, 9, 26, 8, 0), 'date after the DST switch');
assert.equal(parseReset("resets 9am (Europe/Vienna)", Date.UTC(2026, 9, 24, 22, 0)), Date.UTC(2026, 9, 25, 8, 0), 'tomorrow across the switch');
pass('parseReset: times, tomorrow, dates, zones, summer time, DST switch, junk');

assert.equal(resumeAt(stop, {}, now), Date.UTC(2026, 10, 1, 17, 10) + MARGIN_MS, 'the reset in the message wins');
const w = { five_hour: { utilization: 1, resetsAt: Math.round((now + 3600e3) / 1000) }, seven_day: { utilization: 0.5, resetsAt: Math.round((now + 86400e3) / 1000) } };
assert.equal(resumeAt({ ...stop, result: "You've hit your limit" }, w, now), now + 3600e3 + MARGIN_MS, 'else the full window, not the half-used one');
assert.equal(resumeAt({ ...stop, result: "You've hit your limit" }, {}, now), now + FALLBACK_MS, 'else the fallback');
pass('resumeAt: message, then full window, then fallback; margin added');
console.log(`all ${n} quotawait tests passed`);
