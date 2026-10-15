// Run: node console/test-digest.mjs. The 08:00 + 21:00 digests: which slot is due (catch-up, DST, restarts), what counts as stuck / finished overnight, the log scan, today's routine slots, the message builder.
import assert from 'node:assert';
import { dueSlot, digestRefs, overnightSince, daySince, viennaYmd, classify, scanLog, digestRoutines, buildMorningDigest, buildEveningDigest, STUCK_MAX, FINISHED_MAX } from './digest.mjs';

// ---- when ----
const at = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);   // UTC instant
const sum08 = at(2026, 10, 14, 6, 0);                                // 08:00 Vienna (CEST, UTC+2)
assert.equal(viennaYmd(sum08), '2026-10-14');
const sent = (m, e) => ({ lastDigestFor: m, lastEveningFor: e });
const slot = (st, now) => { const x = dueSlot(st, now); return x && [x.kind, x.ymd, x.late, x.skipped && x.skipped.kind]; };
const ALL13 = sent('2026-10-13', '2026-10-13'), M14 = sent('2026-10-14', '2026-10-13');
assert.equal(slot(ALL13, sum08 - 60000), null, '07:59: the latest slot (21:00 yesterday) was sent');
assert.deepEqual(slot(ALL13, sum08), ['morning', '2026-10-14', false, null], '08:00 is due, on time');
assert.deepEqual(slot(ALL13, sum08 + 4 * 60000), ['morning', '2026-10-14', false, null], 'a 30 s tick or a quick restart is not "late"');
assert.deepEqual(slot(ALL13, at(2026, 10, 14, 13, 0)), ['morning', '2026-10-14', true, null], 'server up at 15:00: the 08:00 one goes out, marked late (no 10:00 cut-off any more)');
assert.equal(slot(M14, sum08), null, 'already sent: never twice');
assert.equal(slot(M14, at(2026, 10, 14, 18, 59)), null, 'restart at 20:59: nothing');
assert.deepEqual(slot(M14, at(2026, 10, 14, 19, 0)), ['evening', '2026-10-14', false, null], '21:00 is due');
assert.deepEqual(slot(M14, at(2026, 10, 14, 19, 1)), ['evening', '2026-10-14', false, null], 'restart at 21:01: sent, not late');
assert.deepEqual(slot(M14, at(2026, 10, 14, 21, 0)), ['evening', '2026-10-14', true, null], 'server up at 23:00: late evening');
assert.deepEqual(slot(M14, at(2026, 10, 15, 4, 0)), ['evening', '2026-10-14', true, null], "server up at 06:00 next day: still yesterday's evening");
assert.equal(slot(sent('2026-10-14', '2026-10-14'), at(2026, 10, 15, 5, 59)), null, 'both sent: nothing until 08:00');
assert.deepEqual(slot(ALL13, at(2026, 10, 14, 21, 0)), ['evening', '2026-10-14', true, 'morning'], 'off all day: only the evening, the morning is noted as skipped');
assert.deepEqual(slot(ALL13, at(2026, 10, 15, 5, 0)), ['evening', '2026-10-14', true, 'morning'], 'up at 07:00: the 08:00 of yesterday (23 h ago) is still noted');
const off3 = dueSlot(sent('2026-10-12', '2026-10-12'), at(2026, 10, 16, 5, 0));
assert.deepEqual([off3.kind, off3.ymd, off3.skipped.kind, viennaYmd(off3.skipped.at)], ['evening', '2026-10-15', 'morning', '2026-10-15'], 'off three days: only the latest; 13th/14th (> 24 h) are never sent or listed');
assert.deepEqual(slot(ALL13, at(2026, 10, 14, 18, 59)), ['morning', '2026-10-14', true, null], 'evening of the 13th was sent: no skipped note');
assert.deepEqual(slot(sent('2026-10-13', undefined), at(2026, 10, 14, 13, 0)), ['morning', '2026-10-14', true, null], 'evening never ran (first deploy): nothing "skipped"');
assert.deepEqual(slot({}, sum08), ['morning', '2026-10-14', false, null], 'fresh state');
// DST end 2026-10-25 (CEST -> CET at 03:00): 08:00 = 07:00 UTC, 21:00 = 20:00 UTC
assert.equal(dueSlot(sent('2026-10-24', '2026-10-24'), at(2026, 10, 25, 6, 59)), null, 'DST end: 07:59 CET is not 08:00');
assert.equal(dueSlot(sent('2026-10-24', '2026-10-24'), at(2026, 10, 25, 7, 0)).at, at(2026, 10, 25, 7, 0));
assert.equal(dueSlot(sent('2026-10-25', '2026-10-24'), at(2026, 10, 25, 19, 59)), null, 'DST end: 20:59 CET is not 21:00');
assert.equal(dueSlot(sent('2026-10-25', '2026-10-24'), at(2026, 10, 25, 20, 0)).ymd, '2026-10-25');
// DST start 2026-03-29 (CET -> CEST at 02:00): the 21:00 of the 28th was 20:00 UTC, the 08:00 of the 29th is 06:00 UTC
const sp = dueSlot(sent('2026-03-28', '2026-03-27'), at(2026, 3, 29, 5, 59));
assert.deepEqual([sp.kind, sp.at, sp.late, sp.skipped], ['evening', at(2026, 3, 28, 20, 0), true, null], 'DST start: 07:59 CEST, the 21:00 CET of the night before');
assert.equal(dueSlot(sent('2026-03-28', '2026-03-28'), at(2026, 3, 29, 6, 0)).ymd, '2026-03-29');
assert.ok(dueSlot(ALL13, at(2026, 12, 14, 7, 0)) && !dueSlot(sent('2026-12-13', '2026-12-13'), at(2026, 12, 14, 6, 59)), 'winter time: 08:00 Vienna = 07:00 UTC');
assert.equal(daySince(at(2026, 10, 14, 19, 0)), sum08, 'evening covers the day since 08:00');
assert.equal(daySince(at(2026, 10, 15, 5, 0)), sum08, 'a late evening at 07:00 still covers the day before');
assert.equal(overnightSince(sum08), at(2026, 10, 13, 18, 0), '20:00 Vienna the evening before');
assert.equal(overnightSince(at(2026, 10, 13, 19, 0)), at(2026, 10, 13, 18, 0), 'at 21:00 the same evening the window starts at 20:00 today');
// digestRefs: a late digest covers ITS slot's window; on-demand /evening after midnight lists today's routines, not the day after tomorrow
{
  const late = dueSlot(sent('2026-10-13', '2026-10-13'), at(2026, 10, 14, 18, 30));   // server off 08:00-20:30 Vienna: the morning slot is sent late
  assert.equal(late.kind, 'morning'); assert.equal(digestRefs('morning', at(2026, 10, 14, 18, 30), late).since, at(2026, 10, 13, 18, 0), 'late morning at 20:30 covers since 20:00 the evening before (not since 20:00 today)');
  assert.equal(digestRefs('morning', at(2026, 10, 14, 18, 30), null).since, at(2026, 10, 14, 18, 0), 'on demand at 20:30: since 20:00 today (unchanged)');
  const eve = dueSlot(sent('2026-10-14', '2026-10-13'), at(2026, 10, 14, 23, 0));   // 01:00 Vienna on the 15th, the 21:00 slot of the 14th not sent
  const r = digestRefs('evening', at(2026, 10, 14, 23, 0), eve);
  assert.equal(r.since, sum08, 'late evening covers the 14th from 08:00'); assert.equal(viennaYmd(r.routinesAt), '2026-10-15', 'its routines: the day after the slot');
  const od = digestRefs('evening', at(2026, 10, 14, 23, 0), null);   // /evening at 01:00 Vienna on the 15th
  assert.equal(od.since, sum08); assert.equal(viennaYmd(od.routinesAt), '2026-10-15', 'on-demand /evening after midnight: the routines of the 15th, not the 16th');
  assert.equal(viennaYmd(digestRefs('evening', at(2026, 10, 14, 19, 0), null).routinesAt), '2026-10-15', 'on-demand /evening at 21:00: tomorrow');
  assert.equal(digestRefs('morning', sum08, null).routinesAt, sum08, 'morning routines: today (now)');
}

// ---- stuck / finished ----
const MIN = 60000, NOW = sum08, SINCE = overnightSince(NOW);
const c = (o) => ({ id: 'id' + Math.random().toString(16).slice(2, 8), seat: 'ops', title: 't', status: 'idle', lastAt: 0, resultAt: 0, result: '', ...o });
const k = classify([
  c({ title: 'stuck-w', status: 'working', lastAt: NOW - 31 * MIN }),
  c({ title: 'busy-w', status: 'working', lastAt: NOW - 29 * MIN }),
  c({ title: 'stuck-p', status: 'waiting', lastAt: NOW - 16 * MIN }),
  c({ title: 'fresh-p', status: 'waiting', lastAt: NOW - 14 * MIN }),
  c({ title: 'old-quiet-one', status: 'working', lastAt: NOW - 200 * MIN }),
  c({ title: 'fin-new', status: 'idle', resultAt: NOW - 60 * MIN, result: 'סיכום: עשיתי.' }),
  c({ title: 'fin-stopped', status: 'stopped', resultAt: NOW - 3 * 3600e3 }),
  c({ title: 'before-20', status: 'idle', resultAt: SINCE - MIN }),
  c({ title: 'errored', status: 'error', resultAt: NOW - MIN }),
], NOW, SINCE);
assert.deepEqual(k.stuck.map((x) => x.title), ['old-quiet-one', 'stuck-w', 'stuck-p'], 'longest quiet first; 29 min working and 14 min waiting are not stuck');
assert.deepEqual(k.stuck.map((x) => x.kind), ['working', 'working', 'waiting']);
assert.deepEqual(k.finished.map((x) => x.title), ['fin-new', 'fin-stopped'], 'newest first; before 20:00 and errors are out');
const many = classify(Array.from({ length: 9 }, (_, i) => c({ title: 'f' + i, resultAt: NOW - i * MIN })), NOW, SINCE);
assert.equal(many.finished.length, FINISHED_MAX); assert.equal(many.finishedTotal, 9);

// ---- log scan ----
const log = ['2026-10-13T17:59:59Z [x] failed before the window', '2026-10-13T18:00:00Z [state] save failed: EBUSY', 'stack line no stamp failed', '2026-10-13T19:00:00Z [done] conv=ab notify=sent',
  '2026-10-13T20:00:00Z [uncaughtException] Error: boom', '2026-10-14T05:00:00Z [host] conv=ab12: host 1 alive but silent, left running', 'Seat Console on http://127.0.0.1:4850'].join('\n');
assert.deepEqual(scanLog(log, SINCE), { count: 3, last: '[host] conv=ab12: host 1 alive but silent, left running' });
assert.deepEqual(scanLog('', SINCE), { count: 0, last: null });

// ---- routines today ----
const rs = [{ id: 'nightly', seat: 'ops', cron: '0 20 * * *', enabled: true }, { id: 'ep', seat: 'render', cron: '0 7 * * *', enabled: true }, { id: 'wed', seat: 'studio', cron: '0 10 * * 3', enabled: false }, { id: 'tue', seat: 'dev', cron: '30 9 * * 2', enabled: true }];
assert.deepEqual(digestRoutines(rs, NOW).map((x) => x.id), ['ep', 'nightly'], 'all of today (2026-10-14 is a Wednesday), disabled and Tuesday-only ones out, by time');
assert.deepEqual(digestRoutines(rs, at(2026, 10, 13, 6, 0)).map((x) => x.id), ['ep', 'tue', 'nightly'], 'Tuesday has its 09:30 one');
assert.deepEqual(digestRoutines(rs, at(2026, 10, 25, 6, 0)).map((x) => x.id), ['ep', 'nightly'], 'DST end day (25 h) still lists each once');

// ---- the message ----
const TAGS = new Set(['b', 'i', 'u', 's', 'code', 'pre', 'a', 'blockquote']);
function checkHtml(h) {
  assert.ok(h.length <= 4096, 'over 4096: ' + h.length);
  const stack = [], re = /<(\/?)([a-z-]+)([^<>]*)>/g; let last = 0, m;
  const text = (t) => assert.ok(!/[<>]|&(?!(amp|lt|gt|quot);)/.test(t), 'raw special char in: ' + t);
  while ((m = re.exec(h))) { text(h.slice(last, m.index)); last = re.lastIndex; assert.ok(TAGS.has(m[2]), 'unknown tag ' + m[2]); if (m[1]) assert.equal(stack.pop(), m[2], 'unbalanced </' + m[2] + '>'); else stack.push(m[2]); }
  text(h.slice(last)); assert.deepEqual(stack, [], 'unclosed ' + stack); return h;
}
const BASE = 'http://100.64.0.1:4850';
const seats = [{ name: 'studio', usage: 0.31, resetsAt: at(2026, 10, 14, 8, 20) }, { name: 'dev', usage: 0.62, resetsAt: NOW - 1000 }, { name: 'render', usage: null }, { name: 'info', usage: 0.9, resetsAt: at(2026, 10, 14, 9, 0) }, { name: 'ops', usage: 0, resetsAt: at(2026, 10, 14, 7, 0) }];
const d = buildMorningDigest({ seats, ...k, errors: { count: 3, last: '[host] a <b> & "q"' }, sinceLabel: '20:00', routines: digestRoutines(rs, NOW) }, NOW, BASE);
checkHtml(d.text);
for (const part of ['☀️ <b>Good morning</b> · <i>Wednesday 14.10</i>', '<b>🎨 studio</b>', '🟢 ▰▰▰▱▱▱▱▱▱▱ 31%', '🔁 reset', '<i>no data</i>', '⚠️ <b>Stuck</b> (3)', 'idle 3 h', 'waiting for approval 16 min', '🌙 <b>Finished overnight</b> (2)', '<blockquote>עשיתי.</blockquote>', '<b>Errors and warnings since 20:00</b>: 3', '<code>[host] a &lt;b&gt; &amp; "q"</code>', '<s>07:00 · render · ep</s>', '20:00 · ⚙️ <b>ops</b> · nightly'])
  assert.ok(d.text.includes(part) || d.text.replace(/<\/?b>/g, '').includes(part.replace(/<\/?b>/g, '')), 'missing: ' + part + '\n' + d.text);
assert.equal(d.rows.length, 3); assert.equal(d.rows[0][0].url, `${BASE}/#${k.stuck[0].id}`); assert.ok(d.rows[0][0].text.startsWith('↗ ops'));
// quiet morning: nothing stuck, nothing finished, no errors, no routines
const q = buildMorningDigest({ seats, stuck: [], finished: [], finishedTotal: 0, errors: { count: 0, last: null }, sinceLabel: '20:00', routines: [] }, NOW, BASE); checkHtml(q.text);
assert.ok(q.text.includes('✅ Nothing is stuck') && q.text.includes('🌙 No conversations finished overnight') && q.text.includes('🛠 No errors in server.log since 20:00') && q.text.includes('⏰ No routines scheduled for today') && q.rows === null);
// worst case: 20 stuck, 6 long finished, hostile text everywhere, 5 routines
const evil = '<&>'.repeat(120);
const worst = buildMorningDigest({ seats, stuck: Array.from({ length: 20 }, (_, i) => ({ id: 'w' + i, seat: 'dev', title: evil, kind: i % 2 ? 'waiting' : 'working', quietMs: 90 * MIN })), finished: Array.from({ length: 6 }, (_, i) => ({ id: 'f' + i, seat: 'ops', title: evil, result: 'סיכום: ' + evil })), finishedTotal: 30,
  errors: { count: 999, last: evil }, sinceLabel: '20:00', routines: Array.from({ length: 5 }, (_, i) => ({ id: evil.slice(0, 40), seat: 'ops', at: NOW + i * MIN })) }, NOW, BASE);
checkHtml(worst.text); assert.equal(worst.rows.length, STUCK_MAX); assert.ok(worst.text.includes('+14 more') && worst.text.includes('+24 more'));

// ---- the evening message: since 08:00, finished today, stuck, errors, tomorrow's routines; late + skipped first lines ----
const EVE = at(2026, 10, 14, 19, 0), DAY0 = daySince(EVE);
const ek = classify([c({ title: 'fin-today', status: 'idle', resultAt: EVE - 60 * MIN, result: 'סיכום: נגמר.' }), c({ title: 'fin-night', status: 'idle', resultAt: DAY0 - MIN }), c({ title: 'stuck-p', status: 'waiting', lastAt: EVE - 20 * MIN })], EVE, DAY0);
assert.deepEqual(ek.finished.map((x) => x.title), ['fin-today'], "before 08:00 is the morning's");
const elog = ['2026-10-14T05:59:59Z [x] failed overnight', '2026-10-14T06:00:00Z [state] save failed: EBUSY', '2026-10-14T12:00:00Z [retention] 0 files compressed, 0 left for later', '2026-10-14T18:00:00Z [digest] evening sent for 2026-10-13 (late) message_id=5'].join('\n');
assert.deepEqual(scanLog(elog, DAY0), { count: 1, last: '[state] save failed: EBUSY' }, 'since 08:00; the retention and late-digest lines are not errors');
const tomorrow = digestRoutines(rs, EVE + 24 * 3600e3);
assert.deepEqual(tomorrow.map((x) => [x.id, viennaYmd(x.at)]), [['ep', '2026-10-15'], ['nightly', '2026-10-15']], 'Thursday 15.10');
const e = buildEveningDigest({ seats, ...ek, errors: scanLog(elog, DAY0), sinceLabel: '08:00', routines: tomorrow, slot: { kind: 'evening', at: EVE, late: false, skipped: null } }, EVE + MIN, BASE);
checkHtml(e.text);
assert.ok(e.text.startsWith('🌆 <b>Good evening</b> · <i>Wednesday 14.10</i>'), e.text);
for (const part of ['⚠️ <b>Stuck</b> (1)', 'waiting for approval 20 min', '✅ <b>Finished today</b> (1)', '<blockquote>נגמר.</blockquote>', '<b>Errors and warnings since 08:00</b>: 1', '⏰ <b>Routines tomorrow</b>', '07:00 · 🎬 <b>render</b> · ep', '20:00 · ⚙️ <b>ops</b> · nightly'])
  assert.ok(e.text.includes(part), 'missing: ' + part + '\n' + e.text);
assert.ok(!e.text.includes('Quota') && !e.text.includes('<s>') && !e.text.includes('Late'), 'no usage block, tomorrow is not struck through, on time = no late line');
const late = buildEveningDigest({ seats, stuck: [], finished: [], finishedTotal: 0, errors: { count: 0, last: null }, sinceLabel: '08:00', routines: [], slot: dueSlot(ALL13, at(2026, 10, 15, 5, 0)) }, at(2026, 10, 15, 5, 0), BASE);
checkHtml(late.text);
assert.ok(late.text.startsWith('⏰ <b>Late</b> · the server was not available at 21:00\n<i>Morning digest of 08:00 was not sent: only the latest is sent</i>\n\n🌆 <b>Good evening</b>'), late.text);
assert.ok(late.text.includes('✅ No conversations finished today') && late.text.includes('🛠 No errors in server.log since 08:00') && late.text.includes('⏰ No routines scheduled for tomorrow') && late.rows === null);
const lateM = buildMorningDigest({ seats, stuck: [], finished: [], finishedTotal: 0, errors: { count: 0, last: null }, sinceLabel: '20:00', routines: [], slot: dueSlot(ALL13, at(2026, 10, 14, 13, 0)) }, at(2026, 10, 14, 13, 0), BASE);
assert.ok(lateM.text.startsWith('⏰ <b>Late</b> · the server was not available at 08:00\n\n☀️ <b>Good morning</b>'), lateM.text);
const worstE = buildEveningDigest({ seats, stuck: Array.from({ length: 20 }, (_, i) => ({ id: 'w' + i, seat: 'dev', title: evil, kind: 'working', quietMs: 90 * MIN })), finished: Array.from({ length: 6 }, (_, i) => ({ id: 'f' + i, seat: 'ops', title: evil, result: 'סיכום: ' + evil })), finishedTotal: 30,
  errors: { count: 999, last: evil }, sinceLabel: '08:00', routines: Array.from({ length: 12 }, (_, i) => ({ id: evil.slice(0, 40), seat: 'ops', at: EVE + i * 3600e3 })), slot: { kind: 'evening', at: EVE, late: true, skipped: { kind: 'morning', at: sum08 } } }, EVE, BASE);
checkHtml(worstE.text); assert.equal(worstE.rows.length, STUCK_MAX);
console.log('digest tests passed');
