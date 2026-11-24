// Rolling correction (app.js, "Rolling correction" block; server: roll.mjs): while live dictation types the browser's words, the server reads
// each phrase again a few seconds behind and the page swaps its text in. This file holds only the decisions, kept apart from app.js so a plain
// Node test (test-roll.mjs) can load it without a DOM. Times are milliseconds on the page's clock (the server's stream times + the stream start).
// finals: the pieces live dictation typed, in order: { s: when its first interim words showed, e: when it was typed, st: 'open' | 'done' }.
const ROLL_LAG = 1500, ROLL_PRE = 400;   // a final is typed ~0.5-1.5 s after its words were spoken; its first interim words show ~0.4 s after they start

// Which finals a phrase [startMs, endMs] covers: each final whose (shifted) time span lies at least half inside the phrase window.
// { wait } = words of this phrase are still interim (pendingS = when the current interim words started); { why } = nothing to replace.
function rollMatch(finals, p, pendingS = null) {
  if (pendingS != null && pendingS - ROLL_PRE < p.endMs) return { wait: true };
  const a = p.startMs - 300, b = p.endMs + ROLL_LAG, pick = [];
  finals.forEach((f, i) => { const s = f.s - ROLL_PRE, e = Math.max(f.e, s + 1), ov = Math.min(e, b) - Math.max(s, a); if (ov >= 0.5 * (e - s)) pick.push(i); });
  // an already settled final at the edge is the previous phrase's (its lag reaches into this window): left out. One inside the run = the
  // phrase spans settled or edited text: never twice.
  while (pick.length && finals[pick[0]].st !== 'open') pick.shift();
  while (pick.length && finals[pick[pick.length - 1]].st !== 'open') pick.pop();
  if (!pick.length) return { why: 'nomatch' };
  if (pick.some((i) => finals[i].st !== 'open')) return { why: 'taken' };
  return { from: pick[0], to: pick[pick.length - 1] };   // finals are in time order, so the picked ones are one run
}

const rollWords = (s) => (String(s || '').match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu) || []).length;
const rollNorm = (s) => (String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(' ');
// Replace the live words with the server's? Not when they say the same, when the server heard nothing, or when the word counts are so far
// apart that the phrase and the typed span cannot be the same speech (a final that belongs half to the next phrase, a missed word burst).
function rollDecide(live, text) {
  const lw = rollWords(live), ww = rollWords(text);
  if (!ww) return { replace: false, why: 'empty' };
  if (rollNorm(live) === rollNorm(text)) return { replace: false, why: 'same' };
  if (ww > 2 * lw + 1 || ww < 0.5 * lw) return { replace: false, why: 'mismatch' };
  return { replace: true, why: 'fix' };
}

// Where Smart finish takes over when the dictation stops: the finals after the last one rolling correction settled (replaced or found the
// same). Returns that index (finals.length = nothing left). A gap in the middle stays as typed: re-reading it would redo settled text.
function rollTail(finals) {
  let k = 0; finals.forEach((f, i) => { if (f.st === 'done') k = i + 1; });
  return k;
}
if (typeof module !== 'undefined') module.exports = { rollMatch, rollDecide, rollTail, rollWords };
