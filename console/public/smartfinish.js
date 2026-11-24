// Smart finish for live dictation (app.js, "Smart finish" block): after the browser's speech service has typed the words, the same speech,
// recorded in parallel, is read again by Whisper on this server. This file holds only the decision, kept apart from app.js so a plain
// Node test (test-smartfinish.mjs) can load it without a DOM.
// The two cases it fixes, from the owner's feedback (2026-11-24):
//  - another language: live dictation is fixed to one language per session (the Web Speech API has no detection), so English or German
//    spoken into a Hebrew session comes out as Hebrew-sounding nonsense. Whisper detects the language: a different one it is sure of wins.
//  - dropped words: Edge (Microsoft's service) misses words unless you speak slowly. Whisper heard clearly more words: its text wins.
const SF_MIN_PROB = 0.6, SF_MIN_RATIO = 0.7;
const sfWords = (s) => (String(s || '').match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu) || []).length;
const sfLatin = (s) => (String(s || '').match(/[A-Za-zÀ-ÿ]+(?:['’.-][A-Za-zÀ-ÿ]+)*/g) || []).length;   // English / German words (Latin letters)
const sfNorm = (s) => (String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(' ');
// live: the text this dictation typed; whisper: the server's text (Gemini or Whisper, see engine); liveLangs: the languages the session
// listened in ('he' / 'en' / 'de', more than one when the owner switched the chip mid-dictation); lang + prob: the detected language and how
// sure (Whisper only); segments: Whisper's pieces [{ lang, prob }] (each read in its own language); langs: the languages the result holds.
// Mixed languages (2026-11-24): a live session hears ONE language, so a dictation that mixes them comes out partly as nonsense.
//  - Gemini writes each word in the script it was spoken in: its text wins when it differs from the live text and it holds 2+ languages,
//    a language the session did not listen in, Latin-script words the live text lacks (English inside a Hebrew sentence), or the word gap.
//  - Whisper: a piece in another language it is sure of, or 2+ languages, wins. After a chip switch the live text is already per language
//    and Whisper cannot spell words inside a sentence across languages, so then only the word gap counts (never make it worse).
function smartDecide({ live, whisper, liveLangs, lang, prob, segments, langs, engine }) {
  const lw = sfWords(live), ww = sfWords(whisper), r = (replace, why) => ({ replace, why, lw, ww });
  if (!ww) return r(false, 'empty');
  const short = lw < SF_MIN_RATIO * ww && ww - lw >= 3;   // the gap must be 3+ words: on (near) silence Whisper can invent a word or two ("תודה רבה")
  if (engine === 'gemini') {
    if (sfNorm(live) === sfNorm(whisper)) return r(false, 'same');
    // never shorter than the live text (a recording missing its last words; after a chip switch the live text is already per language)
    const gl = langs || [], full = lw && ww >= (liveLangs.length > 1 ? 1 : SF_MIN_RATIO) * lw;   // 0.7: a transliteration splits words differently ("לסטייג׳ינג" = 2)
    if (full && gl.length >= 2) return r(true, 'mixed');
    if (full && gl.some((l) => !liveLangs.includes(l))) return r(true, 'lang');
    if (full && sfLatin(whisper) > sfLatin(live)) return r(true, 'latin');
    return short ? r(true, 'short') : r(false, 'same');
  }
  // (an empty dictation is the gap rule's case: a language guess on a clip with no live words is no reason on its own)
  const sure = (segments || [{ lang, prob }]).filter((s) => s.lang && (s.prob ?? 0) >= SF_MIN_PROB);
  if (lw && liveLangs.length < 2) {
    if (new Set(sure.map((s) => s.lang)).size >= 2) return r(true, 'mixed');
    if (sure.some((s) => !liveLangs.includes(s.lang))) return r(true, 'lang');
  }
  return short ? r(true, 'short') : r(false, 'same');
}
if (typeof module !== 'undefined') module.exports = { smartDecide, sfWords };
