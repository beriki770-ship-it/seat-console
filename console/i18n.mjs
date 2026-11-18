// Languages of the page and the Telegram bot. The strings live in public/locales/<code>.json (en.json is the source of truth; the page loads the
// same files, the bot keys start with "bot."). No library: t(key, vars) with the fallback chain locale -> English -> the key itself.
// The bot reads the language at every call (useLanguage), so a change in Settings applies to its next message.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCALES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'locales');
// code -> the language's own name (the Settings select). Keep in step with the files in public/locales.
export const LANGS = { en: 'English', he: 'עברית', ar: 'العربية', es: 'Español', 'pt-BR': 'Português (Brasil)', fr: 'Français', de: 'Deutsch', it: 'Italiano',
  ru: 'Русский', tr: 'Türkçe', 'zh-CN': '简体中文', ja: '日本語', ko: '한국어', hi: 'हिन्दी', id: 'Bahasa Indonesia' };
export const RTL = new Set(['he', 'ar']);
// Intl locale per language: English dates are written day-first on a 24-hour clock (the console's own habit), so en-GB.
export const intlOf = (code) => (code === 'en' ? 'en-GB' : code);

const cache = {};
const dict = (code) => (cache[code] ??= (() => { try { return JSON.parse(fs.readFileSync(path.join(LOCALES, code + '.json'), 'utf8')); } catch { return {}; } })());
let current = () => 'en';
export const useLanguage = (fn) => { current = fn; };
export const lang = () => { const c = current(); return Object.hasOwn(LANGS, c || '') ? c : 'en'; };

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, n) => (Object.hasOwn(vars, n) ? String(vars[n]) : m)) : s);
export const t = (key, vars) => fill(dict(lang())[key] ?? dict('en')[key] ?? key, vars);
// Plural: key.one / key.few / key.other ... by the language's own rules (Intl.PluralRules); {n} is filled with the formatted number.
const plural = (d, code, key, n) => d[`${key}.${new Intl.PluralRules(code).select(n)}`] ?? d[`${key}.other`];
export const tn = (key, n, vars) => fill(plural(dict(lang()), lang(), key, n) ?? plural(dict('en'), 'en', key, n) ?? key, { n: num(n), ...vars });
export const num = (n, opts) => new Intl.NumberFormat(intlOf(lang()), opts).format(n);
// 0..1 -> "31%" / "31 %" / "%31": whole percent, written the language's way.
export const pct = (u) => new Intl.NumberFormat(intlOf(lang()), { style: 'percent', maximumFractionDigits: 0 }).format(Math.round(u * 100) / 100);
// Dates and times in the chosen language; tz = the wall clock (digests and routines run on SEAT_CONSOLE_TZ).
export const fmt = (ms, opts, tz) => new Intl.DateTimeFormat(intlOf(lang()), { ...opts, ...(tz ? { timeZone: tz } : {}) }).format(ms);
export const hm = (ms, tz) => fmt(ms, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, tz);

// The page's language when settings.json names none: the browser's Accept-Language, else English. "pt" -> pt-BR, "zh"/"zh-Hans" -> zh-CN, old "iw"/"in" codes too.
export function pickLang(header) {
  const want = String(header || '').split(',').map((p) => p.split(';')[0].trim().toLowerCase()).filter(Boolean);
  const ALIAS = { iw: 'he', in: 'id', pt: 'pt-BR', zh: 'zh-CN', 'zh-hans': 'zh-CN', 'zh-sg': 'zh-CN', 'zh-hans-cn': 'zh-CN' };
  for (const w of want) {
    const exact = Object.keys(LANGS).find((c) => c.toLowerCase() === w); if (exact) return exact;
    if (ALIAS[w]) return ALIAS[w];
    const base = w.split('-')[0];
    if (base === 'zh') continue;   // zh-TW / zh-HK: no Traditional Chinese file, rather the next choice than Simplified
    if (Object.hasOwn(LANGS, base)) return base;
    if (ALIAS[base]) return ALIAS[base];
  }
  return 'en';
}
