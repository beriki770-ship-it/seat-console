// Run: node console/test-routines.mjs. Cron parser, next-due math (midnight, DST end 2026-10-25, DST gap), and the scheduler with a fake clock:
// ask once per slot, nothing ever starts without a tap, expiry, restart persistence, seat-full / quota alternatives, first-start rule.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCron, nextDue, dueBetween } from './cron.mjs';
import { createRoutines, parseRoutines, stripFrontmatter, when, GRACE_MS, EXPIRE_MS } from './routines.mjs';

const TZ = 'Europe/Vienna';
// Vienna wall clock -> instant, for readable test data (CEST = UTC+2 until 2026-10-25 03:00, then CET = UTC+1).
const at = (iso) => { const [d, t] = iso.split(' '); const [y, m, dd] = d.split('-').map(Number), [h, mi] = t.split(':').map(Number);
  return Date.UTC(y, m - 1, dd, h - (d >= '2026-10-25' ? 1 : 2), mi); };
const local = (ms) => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms));

// ---- parser ----
const c = parseCron('*/15 9-17/4 1,15 * 1-5');
assert.deepEqual(c.min, [0, 15, 30, 45]); assert.deepEqual(c.hour, [9, 13, 17]); assert.deepEqual([...c.dom], [1, 15]); assert.equal(c.mon.size, 12); assert.deepEqual([...c.dow], [1, 2, 3, 4, 5]);
assert.deepEqual(parseCron('0 0 * * 7').dow.has(0), true); assert.deepEqual(parseCron('5/20 * * * *').min, [5, 25, 45]);
for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', '*/0 * * * *', 'a * * * *', '5-1 * * * *', '* * 0 * *', '* * * 13 *']) assert.throws(() => parseCron(bad), bad);

// ---- next due ----
assert.equal(local(nextDue('0 10 * * 3', at('2026-10-13 18:26'), TZ)), '2026-10-14 10:00');           // Wed 10:00 from Tuesday evening
assert.equal(local(nextDue('0 10 * * 3', at('2026-10-14 10:00'), TZ)), '2026-10-21 10:00');           // strictly after: a week later
assert.equal(local(nextDue('0 20 * * *', at('2026-10-13 18:26'), TZ)), '2026-10-13 20:00');
assert.equal(local(nextDue('0 20 * * *', at('2026-10-13 20:00'), TZ)), '2026-10-14 20:00');
assert.equal(local(nextDue('30 23 * * *', at('2026-10-13 23:45'), TZ)), '2026-10-14 23:30');           // across midnight
assert.equal(local(nextDue('0 0 * * *', at('2026-10-13 23:59'), TZ)), '2026-10-14 00:00');
assert.equal(local(nextDue('0 7 1 * 1', at('2026-10-13 12:00'), TZ)), '2026-10-19 07:00');             // dom AND dow both restricted: EITHER matches (Mon Oct 19 comes before Nov 1)
assert.equal(local(nextDue('0 7 * * 1', at('2026-10-13 12:00'), TZ)), '2026-10-19 07:00');
// DST end 2026-10-25 (03:00 CEST -> 02:00 CET): the 07:00 slot of that day is 25 h after the day before, and the repeated 02:30 fires ONCE, at its first occurrence.
const d24 = nextDue('0 7 * * *', at('2026-10-24 06:00'), TZ), d25 = nextDue('0 7 * * *', d24, TZ);
assert.equal(local(d24), '2026-10-24 07:00'); assert.equal(local(d25), '2026-10-25 07:00'); assert.equal((d25 - d24) / 3600e3, 25);
assert.equal(dueBetween('30 2 * * *', Date.UTC(2026, 9, 24, 12), Date.UTC(2026, 9, 26, 12), TZ).length, 2);   // Oct 25 02:30 once, Oct 26 02:30 once (Oct 24 02:30 is before the window)
assert.equal(new Date(dueBetween('30 2 * * *', Date.UTC(2026, 9, 24, 12), Date.UTC(2026, 9, 25, 12), TZ)[0]).toISOString(), '2026-10-25T00:30:00.000Z');
assert.equal(new Date(nextDue('0 3 * * *', Date.UTC(2026, 9, 25, 0, 0), TZ)).toISOString(), '2026-10-25T02:00:00.000Z');   // 03:00 CET, after the overlap
// DST gap 2026-03-29 (02:00 -> 03:00): a 02:30 slot does not exist that day, it is skipped; the next day fires.
assert.equal(local(nextDue('30 2 * * *', Date.UTC(2026, 2, 28, 12), TZ)), '2026-03-30 02:30');
// weekly Wed 10:00 across the DST end: still 10:00 wall clock
assert.equal(local(nextDue('0 10 * * 3', at('2026-10-22 12:00'), TZ)), '2026-10-28 10:00');
assert.equal(nextDue('0 0 30 2 *', at('2026-10-13 12:00'), TZ), null);                                  // Feb 30 never

// ---- config ----
assert.equal(stripFrontmatter('---\nname: x\ndescription: y\n---\n\nBody line.\nTwo.\n'), 'Body line.\nTwo.');
assert.equal(stripFrontmatter('---\r\nname: x\r\n---\r\nBody\r\n'), 'Body'); assert.equal(stripFrontmatter('No frontmatter'), 'No frontmatter');
assert.throws(() => parseRoutines([{ id: 'a', cron: '* * * * *', seat: 'ops', cwd: 'c' }]), /promptFile or prompt/);
assert.throws(() => parseRoutines([{ id: 'a', prompt: 'p', cron: 'x', seat: 'ops', cwd: 'c' }]));
assert.throws(() => parseRoutines([{ id: 'a', prompt: 'p', cron: '* * * * *', seat: 'ops', cwd: 'c' }, { id: 'a', prompt: 'p', cron: '* * * * *', seat: 'ops', cwd: 'c' }]), /duplicated/);
// the shipped example must parse (routines.json itself is the user's own, gitignored)
const example = JSON.parse(fs.readFileSync(new URL('./routines.example.json', import.meta.url), 'utf8'));
assert.deepEqual(parseRoutines(example).map((r) => r.id), ['weekly-review']);

// ---- when() ----
const NOW = at('2026-10-13 18:26');
assert.equal(when(at('2026-10-13 20:00'), NOW), 'today 20:00'); assert.equal(when(at('2026-10-14 07:30'), NOW), 'tomorrow 07:30'); assert.equal(when(at('2026-10-21 10:00'), NOW), 'Wed 10:00 (21.10)'); assert.equal(when(null, NOW), '—');

// ---- scheduler with a fake clock and fake outside world ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routines-'));
const file = path.join(dir, 'routines.json');
const promptFile = path.join(dir, 'p.md'); fs.writeFileSync(promptFile, '---\nname: p\n---\nDo the nightly thing. '.padEnd(400, 'x'));
const ROUTINES = [
  { id: 'nightly', promptFile, cron: '0 20 * * *', seat: 'ops', cwd: dir, enabled: true, mode: 'auto' },
  { id: 'weekly', prompt: 'weekly <b>&', cron: '0 10 * * 3', seat: 'studio', cwd: dir, enabled: false, mode: 'auto' },
];
fs.writeFileSync(file, JSON.stringify(ROUTINES));
function world(startState, t0) {
  const w = { t: t0, state: startState ? JSON.parse(JSON.stringify(startState)) : {}, asks: [], edits: [], started: [], tgOn: true, tgFail: false, load: { ops: { alive: 0, max: 3, usage: 0.1 }, studio: { alive: 0, max: 3, usage: 0.2 }, dev: { alive: 1, max: 3, usage: 0.5 } }, msg: 100, logs: [] };
  w.deps = { ask: async (text, rows) => { if (w.tgFail || !w.tgOn) return null; w.asks.push({ text, rows }); return { message_id: ++w.msg }; }, telegramOn: () => w.tgOn,
    edit: async (id, text, rows) => { w.edits.push({ id, text, rows }); }, start: (x) => { w.started.push(x); return 'conv-' + w.started.length + '-aaaaaaaaaaaaaaaaaaaaaaaaaaaa'; },
    seatLoad: (s) => w.load[s], seatNames: () => Object.keys(w.load), base: () => 'http://x:1', log: (l) => w.logs.push(l) };
  w.r = createRoutines({ file, state: w.state, save: () => {}, deps: w.deps, now: () => w.t });
  w.restart = () => world(w.state, w.t);
  return w;
}
const html = (h) => { const st = []; for (const m of h.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) { if (m[1]) assert.equal(st.pop(), m[2], h); else st.push(m[2]); } assert.deepEqual(st, [], h); return h; };

// first start at 18:26: the 20:00 slot is in the future, nothing asked; at 20:00 exactly ONE ask, nothing started
let w = world(null, at('2026-10-13 18:26'));
await w.r.tick(); assert.equal(w.asks.length, 0);
w.t = at('2026-10-13 20:00'); await w.r.tick(); await w.r.tick(); await w.r.tick();
assert.equal(w.asks.length, 1, 'ask once per slot'); assert.equal(w.started.length, 0, 'asking never starts anything');
const ask = w.asks[0]; html(ask.text);
assert.ok(/^⏰ <b>nightly<\/b> · ⚙️ ops seat · due 20:00\n<blockquote expandable>Do the nightly thing\./.test(ask.text)); assert.ok(!ask.text.includes('name: p') && !ask.text.includes('---'));
assert.deepEqual(ask.rows[0].map((b) => b.text), ['▶️ Run', '⏭️ Skip']); assert.ok(ask.rows[0].every((b) => b.callback_data.length <= 64));
assert.ok(ask.text.length < 400 + 120);
assert.equal(w.r.view().find((r) => r.id === 'nightly').decision, 'pending');
// restart inside the same minute and an hour later: still no second ask, the pending ask survives
w = w.restart(); await w.r.tick(); assert.equal(w.asks.length, 0); assert.equal(w.r.view()[0].decision, 'pending');
w.t = at('2026-10-13 21:00'); await w.r.tick(); assert.equal(w.asks.length, 0);
// the tap: stale button -> nothing, right button -> starts with the file's body as prompt, title, seat, cwd; second tap says already started
const cbRun = ask.rows[0][0].callback_data, cbSkip = ask.rows[0][1].callback_data;
assert.equal((await w.r.tap(cbRun.replace(/:\d+$/, ':1'))).toast, 'already handled');
const tapped = await w.r.tap(cbRun);
assert.equal(tapped.toast, 'started'); assert.equal(w.started.length, 1);
assert.equal(w.started[0].title, '⏰ nightly · 2026-10-13'); assert.equal(w.started[0].seat, 'ops'); assert.equal(w.started[0].routine.cwd, dir); assert.ok(w.started[0].text.startsWith('Do the nightly thing.') && !w.started[0].text.includes('name: p'));
assert.equal(w.edits.length, 1); assert.equal(w.edits[0].id, 101); assert.ok(html(w.edits[0].text).includes('▶️ Started on <b>ops</b>') && w.edits[0].text.includes('#conv-1-'));
assert.equal(w.r.view()[0].decision, 'run'); assert.equal(w.r.view()[0].conversationId, 'conv-1-aaaaaaaaaaaaaaaaaaaaaaaaaaaa');
assert.equal((await w.r.tap(cbRun)).toast, 'already started'); assert.equal((await w.r.tap(cbSkip)).toast, 'already started'); assert.equal(w.started.length, 1);
// next day: a new slot, a new ask
w.t = at('2026-10-14 20:00'); await w.r.tick(); assert.equal(w.asks.length, 1);

// skip
w = world(null, at('2026-10-13 19:00')); w.t = at('2026-10-13 20:00'); await w.r.tick();
const sk = await w.r.tap(w.asks[0].rows[0][1].callback_data); assert.equal(sk.toast, 'skipped'); assert.ok(sk.edit.text.includes('⏭️ Skipped')); assert.equal(w.started.length, 0); assert.equal(w.r.view()[0].decision, 'skip');
// expiry: 6 h later the message is edited to "Expired", the decision is expired, a late tap does nothing; persisted across a restart
w = world(null, at('2026-10-13 19:00')); w.t = at('2026-10-13 20:00'); await w.r.tick(); const cb0 = w.asks[0].rows[0][0].callback_data;
w.t += EXPIRE_MS - 60000; await w.r.tick(); assert.equal(w.edits.length, 0);
w = w.restart(); w.t = at('2026-10-14 02:00'); await w.r.tick(); assert.equal(w.edits.length, 1); assert.ok(w.edits[0].text.endsWith('⌛ Expired')); assert.equal(w.r.view()[0].decision, 'expired');
assert.equal((await w.r.tap(cb0)).toast, 'already handled'); assert.equal(w.started.length, 0);
w.t = at('2026-10-14 02:05'); await w.r.tick(); assert.equal(w.edits.length, 1, 'expired once');
// PC was off at the due time: server starts 1h50 later -> asks once; 2h10 later -> too late, no ask
w = world({ routines: {} }, at('2026-10-13 21:50')); await w.r.tick(); assert.equal(w.asks.length, 1); assert.ok(w.asks[0].text.includes('due 20:00')); await w.r.tick(); assert.equal(w.asks.length, 1);
w = world({ routines: {} }, at('2026-10-13 22:10')); await w.r.tick(); assert.equal(w.asks.length, 0);
// first-ever start (no state.routines) after the slot: marked as asked and logged, NOT asked late
w = world(null, at('2026-10-13 20:40')); await w.r.tick(); assert.equal(w.asks.length, 0); assert.equal(w.r.view()[0].decision, 'initial'); assert.ok(w.logs.some((l) => /already passed at first start/.test(l)));
w.t = at('2026-10-14 20:00'); await w.r.tick(); assert.equal(w.asks.length, 1);
// Telegram off: the ask is recorded (decision pending, no message id), nothing started; delivery failing while Telegram is on: retried, then recorded once
w = world(null, at('2026-10-13 19:00')); w.tgOn = false; w.t = at('2026-10-13 20:00'); await w.r.tick(); assert.equal(w.asks.length, 0); assert.equal(w.r.view()[0].decision, 'pending'); assert.ok(w.logs.some((l) => /telegram=off/.test(l)));
w = world(null, at('2026-10-13 19:00')); w.tgFail = true; w.t = at('2026-10-13 20:00'); await w.r.tick(); await w.r.tick(); assert.equal(w.r.view()[0].decision, null);
w.tgFail = false; w.t += 30000; await w.r.tick(); assert.equal(w.asks.length, 1); await w.r.tick(); assert.equal(w.asks.length, 1);
// disabled routine (weekly) never asks; enabling it by override does; Wed 10:00 slot
w = world(null, at('2026-10-13 19:00')); w.t = at('2026-10-14 10:00'); await w.r.tick(); assert.equal(w.asks.filter((a) => a.text.includes('weekly')).length, 0);
await w.r.act('weekly', 'enable'); await w.r.tick(); assert.equal(w.asks.filter((a) => a.text.includes('weekly')).length, 1); assert.ok(html(w.asks.at(-1).text).includes('weekly &lt;b&gt;&amp;'));
assert.equal(w.r.view().find((r) => r.id === 'weekly').enabled, true); await w.r.act('weekly', 'disable'); assert.equal(w.r.view().find((r) => r.id === 'weekly').nextDue, null);
await assert.rejects(() => w.r.act('nope', 'run'), /unknown routine/); await assert.rejects(() => w.r.act('weekly', 'zap'), /unknown action/);
// seat full / quota: the tap answers with the reason and alternatives, nothing starts; "anyway" / another seat does
w = world(null, at('2026-10-13 19:00')); w.t = at('2026-10-13 20:00'); await w.r.tick(); const cbR = w.asks[0].rows[0][0].callback_data;
w.load.ops.alive = 3; let b = await w.r.tap(cbR);
assert.equal(b.toast, 'ops full (3/3)'); assert.equal(w.started.length, 0); html(b.edit.text); assert.ok(b.edit.text.includes('full (3/3)'));
const labels = b.edit.rows.flat().map((x) => x.text); assert.ok(labels[0].startsWith('▶️ Anyway') && labels.some((l) => l.includes('studio')) && labels.some((l) => l.includes('dev')) && !labels.some((l) => l.includes('ops') && !l.startsWith('▶️')) && labels.at(-1) === '⏭️ Skip');
assert.ok(b.edit.rows.flat().every((x) => x.callback_data.length <= 64)); assert.equal(w.r.view()[0].decision, 'blocked');
const anyway = b.edit.rows[0][0].callback_data, other = b.edit.rows.flat().find((x) => x.text.includes('studio')).callback_data;
w.load.ops.alive = 0; w.load.ops.usage = 0.96; b = await w.r.tap(cbR); assert.equal(b.toast, 'ops at 96%'); assert.equal(w.started.length, 0);
assert.equal((await w.r.tap(other)).toast, 'started'); assert.equal(w.started[0].seat, 'studio'); assert.equal(w.r.view()[0].decision, 'run');
w = world(null, at('2026-10-13 19:00')); w.t = at('2026-10-13 20:00'); await w.r.tick(); w.load.ops.usage = 0.97; b = await w.r.tap(w.asks[0].rows[0][0].callback_data);
assert.equal((await w.r.tap(b.edit.rows[0][0].callback_data)).toast, 'started'); assert.equal(w.started[0].seat, 'ops');   // anyway: same seat despite 97 %
// a start that throws (seat refuses): the ask stays open with its buttons
w = world(null, at('2026-10-13 19:00')); w.t = at('2026-10-13 20:00'); await w.r.tick(); w.deps.start = () => { throw new Error('Seat \'ops\' already runs 3 conversations.'); };
b = await w.r.tap(w.asks[0].rows[0][0].callback_data); assert.ok(b.toast.startsWith('failed') && html(b.edit.text).includes('❌') && b.edit.rows); assert.equal(w.r.view()[0].decision, 'pending');
// run now (web or Telegram): starts at once, settles an open ask, and works without any ask
w = world(null, at('2026-10-13 19:00')); const rn = await w.r.act('nightly', 'run'); assert.ok(rn.conversationId); assert.equal(w.started.length, 1); assert.equal(w.r.view()[0].lastRun.by, 'web'); assert.equal(w.r.view()[0].decision, null);
w.t = at('2026-10-13 20:00'); await w.r.tick(); assert.equal(w.asks.length, 1, 'a manual run does not cancel the scheduled ask');
await w.r.act('nightly', 'run'); assert.equal(w.r.view()[0].decision, 'run'); assert.equal(w.edits.length, 1);
assert.equal((await w.r.tap('q:n:nightly')).toast, 'started'); assert.equal((await w.r.tap('q:n:ghost')).toast, 'unknown button');
// /routines list: every routine, next due, run-now button each
const lm = w.r.listMessage(); html(lm.text); assert.ok(lm.text.includes('nightly') && lm.text.includes('weekly') && lm.text.includes('off') && lm.text.includes('next: ')); assert.equal(lm.rows.length, 2); assert.ok(lm.rows.every((r) => r[0].callback_data.length <= 64));
// editing routines.json takes effect without a restart; a broken edit keeps the last good list
fs.writeFileSync(file, JSON.stringify([...ROUTINES, { id: 'extra', prompt: 'x', cron: '5 5 * * *', seat: 'dev', cwd: dir }])); const mt = new Date(Date.now() + 5000); fs.utimesSync(file, mt, mt);
assert.equal(w.r.view().length, 3); fs.writeFileSync(file, '{ not json'); const mt2 = new Date(Date.now() + 10000); fs.utimesSync(file, mt2, mt2); assert.equal(w.r.view().length, 3); assert.ok(w.logs.some((l) => /not loaded/.test(l)));
console.log('routines tests passed');
fs.rmSync(dir, { recursive: true, force: true });
