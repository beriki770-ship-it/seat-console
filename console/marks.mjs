// What a finished turn leaves for the user: "needs your answer", auto-pins (questions, new links, blocking errors) and 2-3 follow-up suggestions.
// All derived from the reply text (and the turn's AskUserQuestion calls), no model call: the CLI's own --prompt-suggestions emits nothing in -p mode
// (checked on 2.1.284, also with CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1). Pure functions on the conversation object, tested by test-marks.mjs.
export const TITLE_MAX = 120, PIN_TEXT = 160, PINS_KEPT = 40, AUTO_PINS_OPEN = 10, SUGGEST_MAX = 3;
const cut = (s, n) => { const a = Array.from(String(s ?? '').replace(/\s+/g, ' ').trim()); return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join(''); };

// Every seat ends its reply with a "Summary:" (or Hebrew "סיכום:") line; the question usually sits in the paragraph before it, the summary itself may carry the ask ("needed from the user: ...").
function lastParts(text) {
  // Haiku sometimes writes it as "Summary:" in a paragraph of its own (seen live on 4851): same treatment.
  const SUM = /^\s*(?:\*\*)?(?:סיכום|summary)\s*:(?:\*\*)?\s*/i, lines = String(text || '').trim().split('\n'), sum = lines.length && SUM.test(lines.at(-1)) ? lines.pop().replace(SUM, '') : '';
  const paras = lines.join('\n').trim().split(/\n\s*\n/);
  return { para: paras.at(-1) || '', sum };
}
// The sentences of a block that end with a question mark (Latin or Arabic/Hebrew-keyboard "؟").
const questionsIn = (block) => (String(block).replace(/```[\s\S]*?```/g, ' ').match(/[^.!?\n؟]*[?؟]/g) || []).map((q) => q.replace(/^[\s*>#\-\d.)]+/, '').trim()).filter((q) => q.length > 2);
// An explicit decision request without a question mark ("tell me which one", "let me know", "תגיד לי").
const ASK_RE = /\b(should I|shall I|do you want|would you like|which (one|option|of)|tell me|let me know|please (confirm|choose|decide|approve)|your call|waiting for your)\b|(תגיד לי|תחליט|תבחר|לאשר\?|מחכה לתשובה|מחכה לאישור|צריך ממך|רוצה ש)/i;
// The closing summary of every agent says "nothing needed from you" - that contains the ask phrase ("צריך ממך") but is the opposite of an ask,
// so a negated sentence never counts as an explicit request (seen live: "כרגע לא צריך ממך כלום.").
const NEG_RE = /(לא צריך|אין צורך|לא נדרש|אין מה לעשות|לא נדרשת)|\b(nothing (is )?(needed|required)|no action (is )?(needed|required)|(don't|do not) need anything|nothing for you to do|not needed from you)\b/i;

// The question that ends a turn, or null. asks = AskUserQuestion inputs of this turn (an explicit question tool call always counts).
export function findQuestion(text, asks = []) {
  const q = asks.flatMap((a) => a?.questions || []).map((x) => x?.question).find(Boolean);
  if (q) return cut(q, PIN_TEXT);
  const { para, sum } = lastParts(text);
  for (const block of [para, sum]) {
    const qs = questionsIn(block); if (qs.length) return cut(qs.at(-1), PIN_TEXT);
    const m = block.split(/(?<=[.!])\s+|\n/).find((s) => ASK_RE.test(s) && !NEG_RE.test(s)); if (m) return cut(m, PIN_TEXT);
  }
  return null;
}

// http(s) URLs in order, trailing punctuation / markdown closers cut off, each once.
export function findUrls(text) {
  const out = [];
  for (let u of String(text || '').match(/https?:\/\/[^\s<>"'`\])]+/g) || []) { u = u.replace(/[.,;:!?)*_]+$/, ''); if (!out.includes(u)) out.push(u); }
  return out;
}

// 2-3 next messages. Order: the AskUserQuestion options, an "X or Y?" question, the list the question offers, a yes/no question.
// Hebrew question -> Hebrew chips (an English question gets English chips).
const YESNO_RE = /^(should|shall|can|may|do|does|did|is|are|would|will|want|ok(ay)?|האם|לה?משיך|שאמשיך|שאשלח|לשלוח|רוצה|אפשר|מאשר|לעשות|להעלות|לפרסם)(?=[\s?؟,]|$)/i;   // a lookahead, not \b: \b knows only ASCII word characters, never a Hebrew letter
export function suggest(text, asks = []) {
  const opts = asks.flatMap((a) => a?.questions || []).flatMap((x) => (x?.options || []).map((o) => o?.label)).filter(Boolean);
  if (opts.length) return uniq(opts.map((o) => cut(o, 60)));
  const q = findQuestion(text); if (!q) return [];
  const he = /[֐-׿]/.test(q);
  // "Deploy now or wait for review?" -> "Deploy now", "wait for review" (the part after the last "or", the part before it from its last comma / colon).
  const or = q.replace(/[?؟]$/, '').split(he ? /\s+או\s+/ : /\s+or\s+/i);
  if (or.length >= 2 && or.length <= 3) {
    const head = or[0].split(/[,:;]\s*/).pop().replace(/^(?:.*\s)?(?:should I|shall I|do you want(?: me)? to|would you like(?: me)? to|prefer|האם|תעדיף|להעדיף)\s+/i, '');
    const parts = [head, ...or.slice(1)].map((p) => p.replace(/^(to|ל)\s+/i, '').trim()).filter((p) => p && Array.from(p).length <= 60);
    if (parts.length >= 2) return uniq(parts.map(capital));
  }
  // A numbered or bulleted list in the last paragraph, then a question about it: the items' first words are the options.
  const items = (lastParts(text).para.match(/^\s*(?:\d+[.)]|[-*•])\s+(.+)$/gm) || []).map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, '').replace(/\*\*/g, '').split(/\s[-–:]\s|[.:(]/)[0].trim()).filter(Boolean);
  if (items.length >= 2) return uniq(items.map((i) => cut(i, 60)));
  if (YESNO_RE.test(q.replace(/^[^\p{L}]+/u, ''))) return he ? ['כן, תמשיך', 'לא'] : ['Yes, go ahead', 'No'];
  return [];
}
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const uniq = (a) => [...new Set(a)].slice(0, SUGGEST_MAX);

// ---- pins, persisted on the conversation (c.pins). A pin: { id, kind: question|link|error|manual, text, url?, i (event index it points at), at, released? }.
// Released pins stay (up to PINS_KEPT entries) only so a link that is in every reply is not pinned again after the user answered.
const pinId = () => Math.random().toString(36).slice(2, 10);
// At most AUTO_PINS_OPEN automatic pins wait at once (a chatty agent must not bury the bar): older ones are released, so their links stay deduped.
// Over PINS_KEPT: the oldest RELEASED pins go first; a pin still waiting for the user is never dropped, a manual one is never auto-released.
const trim = (c, now) => {
  const open = c.pins.filter((p) => !p.released && p.kind !== 'manual');
  for (const p of open.slice(0, Math.max(0, open.length - AUTO_PINS_OPEN))) p.released = now;
  let over = c.pins.length - PINS_KEPT; if (over > 0) c.pins = c.pins.filter((p) => !(p.released && over-- > 0));
};
// Called once per finished turn (not for /context, /compact). result = the result event, i = its index, asks = the turn's AskUserQuestion inputs.
export function markTurn(c, { result, isError, i, asks = [], now = Date.now() }) {
  c.pins ??= [];
  const q = isError ? null : findQuestion(result, asks), add = (p) => c.pins.push({ id: pinId(), i, at: now, ...p });
  // Only a question sets the mark and the chips; only answered() clears them: a later turn without one (a background agent finishing, a turn the CLI started) leaves them.
  if (q) { c.needsAnswer = now; c.suggest = suggest(result, asks); }
  if (q && !c.pins.some((p) => p.i === i && p.kind === 'question')) add({ kind: 'question', text: q });
  if (isError) add({ kind: 'error', text: cut(result || 'the turn failed', PIN_TEXT) });
  for (const url of findUrls(result)) if (!c.pins.some((p) => p.url === url)) add({ kind: 'link', text: cut(url, PIN_TEXT), url });
  trim(c, now);
}
// the user sent a message in this conversation: the mark is cleared, the suggestions are spent, and every automatic pin made before now is released.
// A manual 📌 is the user's own and stays until its ✓.
export function answered(c, now = Date.now()) {
  c.needsAnswer = 0; c.suggest = [];
  for (const p of c.pins || []) if (!p.released && p.kind !== 'manual' && p.at < now) p.released = now;
}
export function addManualPin(c, { i, text, now = Date.now() }) {
  if (!Number.isInteger(i) || i < 0) throw new Error('bad event index');
  const t = cut(text, PIN_TEXT); if (!t) throw new Error('empty pin');
  c.pins ??= []; const p = { id: pinId(), kind: 'manual', text: t, i, at: now }; c.pins.push(p); trim(c, now); return p;
}
// The explicit "done ✓" on a pin.
export function donePin(c, id, now = Date.now()) {
  const p = (c.pins || []).find((x) => x.id === id && !x.released); if (!p) throw new Error('no such pin');
  p.released = now; return p;
}
export const activePins = (c) => (c.pins || []).filter((p) => !p.released).map(({ id, kind, text, url, i }) => ({ id, kind, text, url, i }));

// ---- titles: a title the user typed is never replaced by the automatic one (first message / routine title) ----
export function setTitle(c, raw) {
  if (typeof raw !== 'string') throw new Error('title must be text');
  const t = cut(raw, TITLE_MAX); if (!t) throw new Error('empty title');
  c.title = t; c.titleSetByUser = true; return t;
}
export function autoTitle(c, title) { if (!c.titleSetByUser && c.title === 'New conversation') c.title = title; }
