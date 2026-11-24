// Settings page back end, pure parts: settings.json (beside state.json) plus the config-file edits the page makes
// (seats.json, disciplines.json, routines.json, remotes.json, the Telegram secrets file). server.mjs owns the paths and applies
// the results; test-settings.mjs drives these offline. Every write is atomic (temp file + rename): a crash never leaves half a file.
import fs from 'node:fs';
import { parseCron } from './cron.mjs';
import { parseRemotes } from './remote.mjs';
import { retry } from './hardening.mjs';
import { LANGS } from './i18n.mjs';
import { VOICE_MODELS, VOICE_LANGS, VOICE_ENGINES, SMART_MODELS, SMART_ENGINES, GEMINI_MODELS } from './voice.mjs';

export const SEAT_NAME = /^[a-z][a-z0-9-]{1,20}$/;
const BOOLS = ['usageMeters', 'claudeResets', 'codexResets', 'multiProjects', 'quotaWarning', 'digests', 'voice', 'voiceSmart', 'voiceRolling', 'ideasTelegram'];
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,80}$/;

// The defaults, in one place. Optional features are off unless the install already uses them (a codex seat, a disciplines.json).
export function defaults({ seats = {}, disciplines = false, autoArchiveDays = 3, idleReapMinutes = 5 } = {}) {
  return { usageMeters: true, claudeResets: false, codexResets: Object.values(seats).some((s) => s.agent === 'codex'), multiProjects: !!disciplines,
    quotaWarning: true, digests: true, autoArchiveDays, idleReapMinutes, projectsFreshAtPct: 40, autoArchiveDoneMin: 30, models: {}, language: '',
    voice: true, voiceEngine: 'live', voiceModel: VOICE_MODELS[0], voiceLang: '', voiceSmart: true, voiceRolling: true, voiceSmartEngine: 'whisper', voiceGeminiModel: GEMINI_MODELS[0], voiceSmartModel: SMART_MODELS[0],   // Gemini Smart finish sends audio to Google: opt-in (Settings > Voice)
    ideasSeat: '', ideasDigestAt: '18:00', ideasStaleH: 24, ideasTelegram: true };   // language '' = the browser's (the page) / English (the bot); ideasSeat '' = the first Claude seat
}

// Known keys with the right type only; the first bad one throws (the page shows the message).
export function validateSettings(input, seats) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('settings must be an object');
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (BOOLS.includes(k)) { if (typeof v !== 'boolean') throw new Error(`${k} must be true or false`); out[k] = v; }
    else if (k === 'projectsFreshAtPct') { if (!Number.isInteger(v) || v < 0 || v > 95) throw new Error('projectsFreshAtPct must be a whole number 0-95 (0 = never)'); out[k] = v; }
    else if (k === 'autoArchiveDays') { if (!Number.isInteger(v) || v < 0 || v > 365) throw new Error('autoArchiveDays must be a whole number 0-365 (0 = never)'); out[k] = v; }
    else if (k === 'autoArchiveDoneMin') { if (!Number.isInteger(v) || v < 0 || v > 10080) throw new Error('autoArchiveDoneMin must be a whole number 0-10080 (0 = off)'); out[k] = v; }
    else if (k === 'idleReapMinutes') { if (!Number.isInteger(v) || v < 1 || v > 1440) throw new Error('idleReapMinutes must be a whole number 1-1440'); out[k] = v; }
    else if (k === 'guideOffered') { if (v !== 'later' && v !== 'done') throw new Error('guideOffered must be later or done'); out[k] = v; }   // the first-run tour question (public/tour.js)
    else if (k === 'voiceEngine') { if (!VOICE_ENGINES.includes(v)) throw new Error('voiceEngine must be live or local'); out[k] = v; }
    else if (k === 'voiceModel') { if (!VOICE_MODELS.includes(v)) throw new Error('unknown voice model ' + v); out[k] = v; }   // the mic button (voice.mjs)
    else if (k === 'voiceSmartEngine') { if (!SMART_ENGINES.includes(v)) throw new Error('voiceSmartEngine must be ' + SMART_ENGINES.join(' or ')); out[k] = v; }   // gemini (audio to Google) or whisper (this server)
    else if (k === 'voiceGeminiModel') { if (!GEMINI_MODELS.includes(v)) throw new Error('voiceGeminiModel must be one of ' + GEMINI_MODELS.join(', ')); out[k] = v; }
    else if (k === 'voiceSmartModel') { if (!SMART_MODELS.includes(v)) throw new Error('voiceSmartModel must be ' + SMART_MODELS.join(' or ')); out[k] = v; }   // Smart finish (live dictation checked by Whisper)
    else if (k === 'voiceLang') { if (!VOICE_LANGS.includes(v)) throw new Error('voiceLang must be "", he, en or de'); out[k] = v; }
    else if (k === 'ideasSeat') { if (v !== '' && (!Object.hasOwn(seats, v) || seats[v].agent)) throw new Error('ideasSeat must be a Claude seat'); out[k] = v; }   // the Ideas processor (ideas.mjs) runs claude -p on this seat's login
    else if (k === 'ideasDigestAt') { const m = /^(\d\d):([0-5]\d)$/.exec(v); if (!m || +m[1] < 7 || +m[1] > 22) throw new Error('ideasDigestAt must be HH:MM between 07:00 and 22:59'); out[k] = v; }   // never at night (23:00-07:00)
    else if (k === 'ideasStaleH') { if (!Number.isInteger(v) || v < 1 || v > 720) throw new Error('ideasStaleH must be a whole number 1-720'); out[k] = v; }
    else if (k === 'language') { if (v !== '' && !Object.hasOwn(LANGS, v)) throw new Error('unknown language ' + v); out[k] = v; }
    else if (k === 'models') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('models must be an object seat -> model id');
      out.models = {};
      for (const [seat, id] of Object.entries(v)) {
        if (!Object.hasOwn(seats, seat)) throw new Error('models: unknown seat ' + seat);
        if (id === '' || id == null) continue;   // '' = the seat's own default
        if (typeof id !== 'string' || !MODEL_ID.test(id)) throw new Error(`models: bad model id for ${seat}`);
        out.models[seat] = id;
      }
    } else throw new Error('unknown setting ' + k);
  }
  return out;
}

// A file holding only the tour answer is still a first run: answering the tour question must not skip the first-run Settings page.
export const onlyGuide = (o) => Object.keys(o).every((k) => k === 'guideOffered');

// { settings, firstRun, error }: no file = first run (the page opens Settings); a broken file = the defaults and the reason, never a crash.
export function readSettings(file, ctx) {
  const base = defaults(ctx);
  let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { settings: base, firstRun: e.code === 'ENOENT', error: e.code === 'ENOENT' ? null : e.message }; }
  try {
    const saved = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (saved?.models && typeof saved.models === 'object') for (const s of Object.keys(saved.models)) if (!Object.hasOwn(ctx.seats || {}, s)) delete saved.models[s];   // a removed seat's default model is dropped, not the whole file
    return { settings: { ...base, ...validateSettings(saved, ctx.seats || {}) }, firstRun: Object.keys(saved).length > 0 && onlyGuide(saved), error: null };
  }
  catch (e) { return { settings: base, firstRun: false, error: 'settings.json ignored: ' + e.message }; }
}

export function writeJsonAtomic(file, obj, mode) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', mode ? { mode } : undefined);
  try { retry(() => fs.renameSync(tmp, file)); }   // Windows: a virus scanner or an editor may hold the target for a moment
  catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

// seats.json: a new seat. agent: '' (Claude) | 'codex' | 'agy'. A second account of the same agent gets its own login folder ("home"),
// so two seats never share one login (the console refuses resets for seats that do).
export function addSeat(cfg, { agent = '', name, email = '', role = '' }) {
  if (!SEAT_NAME.test(name || '')) throw new Error('name: 2-21 characters, a-z, 0-9 and -, starting with a letter');
  if (Object.hasOwn(cfg.seats || {}, name)) throw new Error(`a seat named ${name} already exists`);
  if (!['', 'codex', 'agy'].includes(agent)) throw new Error('unknown agent ' + agent);
  if (typeof email !== 'string' || email.length > 120 || (email && !/^[^\s@]+@[^\s@]+$/.test(email))) throw new Error('e-mail looks wrong');
  if (typeof role !== 'string' || role.length > 200) throw new Error('role: 200 characters at most');
  const seat = { email, role: role || (agent === 'codex' ? 'Codex (OpenAI)' : agent === 'agy' ? 'Antigravity (Google)' : 'General work') };
  if (agent) {
    seat.agent = agent;
    if (Object.values(cfg.seats || {}).some((s) => s.agent === agent)) seat.home = `~/.seat-console/accounts/${name}`;
  }
  return { ...cfg, seats: { ...cfg.seats, [name]: seat } };
}

// blockers: why the server will not drop it (conversations, a discipline, a routine). The last seat stays: the console needs one.
export function removeSeat(cfg, name, blockers = []) {
  if (!Object.hasOwn(cfg.seats || {}, name)) throw new Error('unknown seat ' + name);
  if (Object.keys(cfg.seats).length < 2) throw new Error('the last seat cannot be removed');
  if (blockers.length) throw new Error(`${name} is still used: ${blockers.join('; ')}`);
  const seats = { ...cfg.seats }; delete seats[name];
  return { ...cfg, seats };
}

// disciplines.json: every target and the owner must be a seat that exists.
export function checkDisciplines({ owner, disciplines }, seats) {
  if (!Object.hasOwn(seats, owner)) throw new Error('owner: unknown seat ' + owner);
  if (!disciplines || typeof disciplines !== 'object' || Array.isArray(disciplines) || !Object.keys(disciplines).length) throw new Error('add at least one discipline');
  for (const [d, s] of Object.entries(disciplines)) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(d)) throw new Error(`discipline "${d}": a-z, 0-9 and - only`);
    if (!Object.hasOwn(seats, s)) throw new Error(`${d} -> unknown seat ${s}`);
  }
  return { owner, disciplines };
}

// routines.json: add or replace one routine (by id), then the whole list must still parse the way the scheduler reads it.
export function saveRoutine(list, r, seats) {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(r?.id || '')) throw new Error('id: a-z, 0-9 and - only');
  if (!Object.hasOwn(seats, r.seat)) throw new Error('unknown seat ' + r.seat);
  if (typeof r.prompt !== 'string' || !r.prompt.trim()) throw new Error('the prompt is empty');
  if (typeof r.cwd !== 'string' || !/^([A-Za-z]:)?[\\/]/.test(r.cwd)) throw new Error('folder: an absolute path');
  parseCron(r.cron);   // throws "cron needs 5 fields" and friends
  const old = list.find((x) => x.id === r.id) || {};
  const next = { ...old, id: r.id, seat: r.seat, cron: String(r.cron).trim(), cwd: r.cwd, prompt: r.prompt, mode: ['auto', 'ask', 'bypass'].includes(r.mode) ? r.mode : 'auto', enabled: old.enabled ?? true };
  if (next.prompt) delete next.promptFile;   // a prompt typed here replaces a prompt file
  return old.id ? list.map((x) => (x.id === r.id ? next : x)) : [...list, next];
}

// remotes.json: one entry, checked by the same rules the server applies at start (parseRemotes); account = a local seat.
export function addRemote(list, r, seats, home) {
  if (list.some((x) => x.name === r?.name)) throw new Error(`a remote named ${r?.name} already exists`);
  if (r.account && !Object.hasOwn(seats, r.account)) throw new Error('account: unknown seat ' + r.account);
  const entry = { name: r.name, target: r.target, identity: r.identity, seat: r.seat || r.name, paths: r.paths || [], ...(r.control ? { control: true } : {}), ...(r.account ? { account: r.account } : {}) };
  if (!parseRemotes({ remotes: [entry] }, home, () => {}).length) throw new Error('needs name (a-z 0-9 -), target user@host, the key file, and folders to follow (letters, digits, _ . / ~ * ? -) unless it may start conversations');
  return [...list, entry];
}

// The Telegram secrets file: a new bot token. Another bot = the chat link starts over (/start <code> to the new bot).
export function telegramToken(cfg, token) {
  if (!/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(token || '')) throw new Error('that is not a bot token (it looks like 123456789:AA... from @BotFather)');
  return cfg?.botToken === token ? cfg : { botToken: token };
}
