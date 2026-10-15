// "Needs your answer", auto-pins, pin release, follow-up suggestions and user titles (marks.mjs).
import assert from 'node:assert/strict';
import { findQuestion, findUrls, suggest, markTurn, answered, addManualPin, donePin, activePins, setTitle, autoTitle, PINS_KEPT, AUTO_PINS_OPEN, TITLE_MAX } from './marks.mjs';
let ok = 0; const pass = (m) => { ok++; console.log('ok  ' + m); };
const S = '\nסיכום: עשיתי X. צריך ממך החלטה.';
{
  assert.equal(findQuestion('Done.\n\nShould I deploy now or wait for the review?' + S), 'Should I deploy now or wait for the review?');
  assert.equal(findQuestion('Built it.\n\nתעלה את זה עכשיו?\nסיכום: הכל מוכן.'), 'תעלה את זה עכשיו?');
  assert.equal(findQuestion('Is it done? Yes.\n\nAll files written.\nסיכום: הכל מוכן.'), null, 'a question in an earlier paragraph is not the ending');
  assert.equal(findQuestion('Ready.\n\nLet me know which one you prefer.'), 'Let me know which one you prefer.');
  assert.equal(findQuestion('Ready.\nסיכום: עשיתי. מחכה לאישור שלך לפרסום.'), 'מחכה לאישור שלך לפרסום.');
  assert.equal(findQuestion('Done.\n\n```js\nif (a?.b) x();\n```'), null, 'a ?. inside code is not a question');
  assert.equal(findQuestion('Done, nothing needed.' + '\nסיכום: הכל עובד.'), null);
  // Closing "nothing needed from you" lines (real production false positives) are NOT questions.
  for (const t of ['לא צריך ממך כלום, אעדכן כשיש תוצאות.', 'סיכום: עשיתי. כרגע לא צריך ממך כלום.', 'Done.\nסיכום: הכל מוכן. אין צורך בפעולה ממך.', 'Done.\n\nNothing needed from you.', 'Done.\n\nNo action needed from you.'])
    assert.equal(findQuestion(t), null, t);
  assert.equal(findQuestion('Ready.\nסיכום: עשיתי. צריך ממך אישור לפרסום.'), 'צריך ממך אישור לפרסום.', 'a non-negated ask still counts');
  assert.equal(findQuestion('Ready.\nסיכום: עשיתי. תגיד לי איזה צבע.'), 'תגיד לי איזה צבע.');
  const live = 'Preview: https://example.com/preview/42\n\n```\nשלום עולם\n```\n\nShould I deploy now or wait for the review?\n\nSummary: This is a test.';   // a real haiku reply on 4851
  assert.equal(findQuestion(live), 'Should I deploy now or wait for the review?'); assert.deepEqual(suggest(live), ['Deploy now', 'Wait for the review']);
  assert.equal(findQuestion('text', [{ questions: [{ question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }] }]), 'Which colour?', 'AskUserQuestion always counts');
  pass('question / decision request at the end of a reply (paragraph, summary line, AskUserQuestion), not inside code or earlier paragraphs');
}
{
  assert.deepEqual(findUrls('Live: https://a.example/x. PR (https://github.com/o/r/pull/7), again https://a.example/x and **https://b.test/p**'), ['https://a.example/x', 'https://github.com/o/r/pull/7', 'https://b.test/p']);
  assert.deepEqual(findUrls('no links, C:\\x\\y.md'), []);
  pass('URLs: trailing punctuation and markdown cut, deduped, order kept');
}
{
  assert.deepEqual(suggest('Done.\n\nShould I deploy now or wait for the review?'), ['Deploy now', 'Wait for the review']);
  assert.deepEqual(suggest('x\n\nDo you prefer tea or coffee?'), ['Tea', 'Coffee']);
  assert.deepEqual(suggest('x\n\nלהעלות עכשיו או לחכות לבדיקה?'), ['להעלות עכשיו', 'לחכות לבדיקה']);
  assert.deepEqual(suggest('x\n\nShall I push the commit?'), ['Yes, go ahead', 'No']);
  assert.deepEqual(suggest('x\n\nלהמשיך לשלב הבא?'), ['כן, תמשיך', 'לא']);
  assert.deepEqual(suggest('Options:\n1. **Hetzner** - cheap\n2. Netcup: ok\n3. OVH (EU)\nWhich one?'), ['Hetzner', 'Netcup', 'OVH']);
  assert.deepEqual(suggest('All done.'), []);
  assert.deepEqual(suggest('t', [{ questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }] }] }]), ['A', 'B', 'C'], 'at most 3');
  pass('suggestions: AskUserQuestion options, "X or Y", list items, yes/no (Hebrew chips for a Hebrew question), nothing for a plain report');
}
{
  const c = { id: 'c1' };
  markTurn(c, { result: 'Deployed https://x.test/a\n\nShould I also update the README?', isError: false, i: 10, now: 100 });
  assert.equal(c.needsAnswer, 100); assert.deepEqual(activePins(c).map((p) => p.kind).sort(), ['link', 'question']);
  markTurn(c, { result: 'Still https://x.test/a', isError: false, i: 20, now: 200 });
  assert.equal(c.needsAnswer, 100, 'a later turn without a question (background agent, CLI-started) keeps the mark'); assert.deepEqual(c.suggest, ['Yes, go ahead', 'No'], '... and the chips'); assert.equal(activePins(c).filter((p) => p.kind === 'link').length, 1, 'same link is not pinned twice');
  const m = addManualPin(c, { i: 5, text: '  important   note ', now: 210 }); assert.equal(m.text, 'important note');
  assert.throws(() => addManualPin(c, { i: -1, text: 'x' })); assert.throws(() => addManualPin(c, { i: 1, text: '  ' }));
  markTurn(c, { result: 'boom', isError: true, i: 30, now: 300 }); assert.ok(activePins(c).some((p) => p.kind === 'error'));
  answered(c, 250);
  assert.deepEqual(activePins(c).map((p) => p.kind).sort(), ['error', 'manual'], 'a message releases the automatic pins made BEFORE it, never a manual one or a later one');
  answered(c, 400); assert.deepEqual(activePins(c).map((p) => p.kind), ['manual']);
  markTurn(c, { result: 'Again https://x.test/a', isError: false, i: 40, now: 500 }); assert.equal(activePins(c).filter((p) => p.kind === 'link').length, 0, 'a released link is not pinned again');
  donePin(c, m.id, 600); assert.equal(activePins(c).length, 0); assert.throws(() => donePin(c, m.id), /no such pin/, 'done twice');
  const keep = addManualPin(c, { i: 50, text: 'mine', now: 700 });
  for (let k = 0; k < PINS_KEPT + 10; k++) markTurn(c, { result: `https://n.test/${k}`, isError: false, i: 100 + k, now: 1000 + k });
  const open = activePins(c); assert.equal(open.length, AUTO_PINS_OPEN + 1, 'at most AUTO_PINS_OPEN automatic pins wait, plus the manual one');
  assert.ok(open.some((p) => p.id === keep.id)); assert.equal(open.filter((p) => p.kind === 'link')[0].text, `https://n.test/${PINS_KEPT + 10 - AUTO_PINS_OPEN}`, 'the newest ones stay');
  assert.equal(c.pins.length, PINS_KEPT, 'over PINS_KEPT the oldest released pins go');
  markTurn(c, { result: 'https://n.test/0', isError: false, i: 2000, now: 9000 }); assert.equal(activePins(c).length, AUTO_PINS_OPEN + 1, 'a link released by the cap is not pinned again');
  pass('pins: question + link + error pinned, links deduped, released only by a later message or done, manual pins wait for done, capped');
}
{
  const c = { title: 'New conversation' };
  autoTitle(c, 'first message'); assert.equal(c.title, 'first message');
  assert.throws(() => setTitle(c, '   '), /empty/); assert.throws(() => setTitle(c, 5), /text/);
  assert.equal(setTitle(c, '  My   title '), 'My title'); assert.equal(c.titleSetByUser, true);
  assert.equal(Array.from(setTitle(c, 'x'.repeat(500))).length, TITLE_MAX);
  const d = { title: 'New conversation' }; setTitle(d, 'New conversation'); autoTitle(d, 'from the first message'); assert.equal(d.title, 'New conversation', 'a user title is never overwritten');
  pass('titles: trimmed, clipped, non-empty; the automatic title never replaces one the user set');
}
console.log(`all ${ok} marks tests passed`);
