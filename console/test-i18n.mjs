// Offline check of the languages (i18n.mjs, public/locales/*.json): every file is valid JSON and has every key of en.json, nothing unknown,
// the same {placeholders} and HTML tags as English, plural forms by the language's own rules; every key the code asks for exists in en.json;
// and app.js / index.html carry no English UI text outside t() (a short allowlist below). Exit 1 on the first failed group, with every finding listed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGS, LOCALES, pickLang, useLanguage, t, tn } from './i18n.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');
const problems = [];
const fail = (m) => problems.push(m);

// ---- the files ----
const files = fs.readdirSync(LOCALES).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
for (const c of Object.keys(LANGS)) if (!files.includes(c)) fail(`missing locale file ${c}.json`);
for (const c of files) if (!Object.hasOwn(LANGS, c)) fail(`${c}.json is not in i18n.mjs LANGS`);
const load = (c) => { try { return JSON.parse(fs.readFileSync(path.join(LOCALES, c + '.json'), 'utf8')); } catch (e) { fail(`${c}.json: invalid JSON (${e.message})`); return {}; } };
const en = load('en');
const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const tags = (s) => [...String(s).matchAll(/<\/?[a-z]+[^>]*>/g)].map((m) => m[0]).sort().join('');
const CATS = ['zero', 'one', 'two', 'few', 'many', 'other'];
const pluralBase = (k) => { const m = /^(.*)\.(zero|one|two|few|many|other)$/.exec(k); return m && Object.hasOwn(en, m[1] + '.other') ? m[1] : null; };

for (const c of files) {
  const d = load(c), cats = new Intl.PluralRules(c).resolvedOptions().pluralCategories;
  for (const [k, v] of Object.entries(d)) {
    if (typeof v !== 'string') { fail(`${c}: ${k} is not a string`); continue; }
    if (!v.trim()) fail(`${c}: ${k} is empty`);
    if (v.includes('"')) fail(`${c}: ${k} holds a straight double quote (breaks an HTML attribute); use the language's own quotes`);
    const base = pluralBase(k);
    if (!Object.hasOwn(en, k) && !(base && cats.includes(k.slice(base.length + 1)))) { fail(`${c}: unknown key ${k}`); continue; }
    const ref = en[k] ?? en[base + '.other'];
    if (vars(v) !== vars(ref) && !(base && vars(v).replace(/(^|,)n(,|$)/, '$1$2').replace(/^,|,$/g, '') === vars(ref).replace(/(^|,)n(,|$)/, '$1$2').replace(/^,|,$/g, ''))) fail(`${c}: ${k} placeholders {${vars(v)}} differ from English {${vars(ref)}}`);
    if (tags(v) !== tags(ref)) fail(`${c}: ${k} HTML tags differ from English`);
  }
  for (const k of Object.keys(en)) {
    const base = pluralBase(k);
    if (base) { const cat = k.slice(base.length + 1); if (cats.includes(cat) && !Object.hasOwn(d, k)) fail(`${c}: missing key ${k}`); continue; }
    if (!Object.hasOwn(d, k)) fail(`${c}: missing key ${k}`);
  }
  for (const b of new Set(Object.keys(en).map(pluralBase).filter(Boolean))) for (const cat of cats) if (!Object.hasOwn(d, `${b}.${cat}`)) fail(`${c}: missing plural ${b}.${cat} (${c} uses ${cats.join('/')})`);
}
if (CATS.length !== 6) fail('plural categories');

// ---- every key the code asks for is in en.json (dynamic ones: their known values) ----
const SRC = ['public/app.js', 'public/tour.js', 'public/index.html', 'telegram.mjs', 'digest.mjs', 'routines.mjs', 'server.mjs'];
const PREFIX = /^(bot|set|conv|side|composer|mode|status|perm|log|result|ctx|usage|quota|pins|code|file|run|routines|projects|mstatus|common|time|search|banner|tour)\./;
for (const f of SRC) {
  const s = read(f);
  const keys = [...s.matchAll(/'([a-z]+(?:\.[A-Za-z0-9_-]+)+)'/g), ...s.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1]).filter((k) => PREFIX.test(k) && !/\.(json|mjs|js|log|txt)$/.test(k));
  for (const k of new Set(keys)) if (!k.endsWith('.') && !Object.hasOwn(en, k) && !Object.hasOwn(en, k + '.other')) fail(`${f}: key ${k} is not in en.json`);
}
for (const s of ['idle', 'working', 'waiting', 'error', 'stopped', 'interrupted']) if (!en['status.' + s]) fail('status.' + s);
for (const s of ['auto', 'ask', 'bypass']) if (!en['mode.' + s]) fail('mode.' + s);

// ---- no English UI text left in the page outside t() ----
// index.html: every element with visible text or a title / placeholder / aria-label carries its data-i18n twin. Allowed: the product name.
const html = read('public/index.html');
const ALLOW_TEXT = new Set(['Seat Console', '☰', '⚙', '×', '']);
for (const m of html.matchAll(/<(\w+)([^>]*)>([^<]*)</g)) {
  const [, tag, attrs, text] = m, tx = text.trim();
  if (['script', 'style', 'title', 'option', 'h1'].includes(tag) && (tag !== 'option' || /data-i18n=/.test(attrs) || !/[a-z]{3}/.test(tx))) continue;
  if (tx && /[A-Za-z]{2}/.test(tx) && !ALLOW_TEXT.has(tx) && !/data-i18n=/.test(attrs) && !/^(Opus|Fable|Sonnet|Haiku) [\d.]+$/.test(tx)) fail(`index.html: <${tag}> text "${tx.slice(0, 40)}" has no data-i18n`);
  for (const a of ['title', 'placeholder', 'aria-label', 'label']) if (new RegExp(`\\s${a}="[^"]*[A-Za-z]{2}`).test(attrs) && !new RegExp(`data-i18n-${a}=`).test(attrs)) fail(`index.html: <${tag}> ${a} has no data-i18n-${a}`);
}
// app.js: string literals and template text that read like an English UI phrase (a capital word followed by a lower-case word, or a known UI attribute).
const js = read('public/app.js').split('\n');
const ALLOW_JS = [/'See the attached (file|image)\.'/];   // text sent to the agent as the message itself, not page text
js.forEach((line, i) => {
  if (/^\s*\/\//.test(line)) return;
  const code = line.replace(/\/\/ .*$/, '').replace(/`[^`]*`/g, (s) => s.replace(/\$\{[^}]*\}/g, ''));
  const isClass = (m) => /(div\(|className = |classList\.\w+\()\s*$/.test(code.slice(Math.max(0, m.index - 20), m.index));   // CSS class lists look like lower-case phrases
  const hits = [...code.matchAll(/(['`])([^'`]*?)\1/g)].filter((m) => !isClass(m)).map((m) => m[2]).filter((s) => /\b[A-Z][a-z]+ [a-z]+/.test(s) || /^(?:[a-z]+ ){1,}[a-z]+[.…]?$/.test(s));
  for (const h of hits) if (!ALLOW_JS.some((r) => r.test(`'${h}'`)) && !/[<>=]/.test(h.replace(/<[^>]+>/g, ''))) fail(`app.js:${i + 1}: hard-coded text "${h.slice(0, 60)}"`);
  if (/(title|placeholder|aria-label)="[A-Za-z][a-z]+ [a-z]/.test(code)) fail(`app.js:${i + 1}: hard-coded attribute text`);
  if (/(alert|confirm|prompt)\('[A-Za-z]/.test(code)) fail(`app.js:${i + 1}: hard-coded dialog text`);
});

// ---- the bot helper: fallback chain, plural, placeholders ----
let cur = 'en'; useLanguage(() => cur);
if (t('bot.pick.seat') !== 'Which seat?') fail('t en');
cur = 'de'; if (files.includes('de') && t('bot.pick.seat') === 'Which seat?') fail('t de falls back to English');
cur = 'xx'; if (t('bot.pick.seat') !== 'Which seat?') fail('unknown language -> English');
if (t('no.such.key') !== 'no.such.key') fail('missing key -> the key');
cur = 'en'; if (tn('run.actions', 1) !== '1 action' || tn('run.actions', 3) !== '3 actions') fail('tn en');
if (files.includes('ru')) { cur = 'ru'; const a = tn('run.actions', 1), b = tn('run.actions', 3), c5 = tn('run.actions', 5); if (!(a !== b && b !== c5)) fail(`tn ru forms: ${a} / ${b} / ${c5}`); }
cur = 'en';
const PICK = [['he-IL,he;q=0.9,en;q=0.8', 'he'], ['pt-PT', 'pt-BR'], ['zh-TW,ja;q=0.5', 'ja'], ['zh-Hans-CN', 'zh-CN'], ['zh', 'zh-CN'], ['fr-CA', 'fr'], ['nl,sv', 'en'], ['', 'en'], ['iw', 'he'], ['ar-EG', 'ar'], ['ko-KR', 'ko'], ['hi-IN', 'hi'], ['id-ID', 'id'], ['de-AT', 'de']];
for (const [h, want] of PICK) if (pickLang(h) !== want) fail(`pickLang(${h}) = ${pickLang(h)}, want ${want}`);

if (problems.length) { console.error(problems.map((p) => 'FAIL ' + p).join('\n') + `\n${problems.length} problem(s)`); process.exit(1); }
console.log(`test-i18n: ${files.length} locales x ${Object.keys(en).length} keys OK, code keys OK, no hard-coded page text`);
