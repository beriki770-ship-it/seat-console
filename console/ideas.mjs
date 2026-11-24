// Ideas inbox: on the go there is only time to pour a thought out (typed, spoken, a photo, from the page or Telegram); later, at a desk,
// each one should be ready to work on. So nothing just sits: every capture is transcribed (voice notes, local Whisper) and turned by a cheap LLM pass
// into a brief (title, project, type, seat, goal, context, open questions, a first message for the chat). The page lists the ready ones per project;
// "Start chat" opens a new chat in that project with the first message in the box (not sent).
// Store: one append-only JSONL file (<data>/ideas.jsonl): add / set / merge / del lines, folded by readIdeas. Media: <data>/ideas-media/<id>/<file>.
// Pipeline (createIdeas): one idea at a time, in the background; a failure is retried 3 times (5, 10, 15 min), a seat at its limit waits without
// counting as a failure, an idea found 'processing' at start (the server died mid-run) is queued again, a transcript already made is never redone.
// Duplicates (the same idea sent twice) merge into the older one, which keeps both captures.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ID_RE = /^[0-9a-f]{8}$/, FILE_RE = /^[\w-][\w.-]{0,79}$/;   // no leading dot: never '.' or '..'
const EXT = { audio: ['webm', 'ogg', 'oga', 'opus', 'm4a', 'mp4', 'mp3', 'wav'], photo: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'] };   // stored names only get these: an uploaded x.html must never be served back as a page
export const IDEA_TYPES = ['build', 'bug', 'question', 'content', 'admin', 'other'];
export const MAX_TRIES = 3, RETRY_MS = 5 * 60000, DUP_DAYS = 7;
const STATUSES = ['captured', 'processing', 'ready', 'failed', 'done', 'archived'];

export function readIdeas(file) {
  let raw = ''; try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const map = new Map();
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue; let e; try { e = JSON.parse(l); } catch { continue; }   // a torn last line (crash mid-write) is skipped
    if (!ID_RE.test(e?.id)) continue;
    if (e.t === 'add') map.set(e.id, { id: e.id, status: 'captured', at: e.at, src: e.src || 'console', tries: 0, transcripts: {}, captures: [{ dir: e.id, src: e.src || 'console', at: e.at, text: e.text || '', audio: e.audio || [], photos: e.photos || [] }], ...(e.tgMsg ? { tgMsg: e.tgMsg } : {}) });
    const x = map.get(e.id); if (!x || e.t === 'add') continue;
    if (e.t === 'set') Object.assign(x, e.patch || {});
    else if (e.t === 'merge') { const into = map.get(e.into); if (into) { into.captures.push(...x.captures); Object.assign(into.transcripts, x.transcripts); } map.delete(e.id); }
    else if (e.t === 'del') map.delete(e.id);
  }
  return [...map.values()].reverse();   // newest first
}
function append(file, entry) {
  let lead = ''; try { const s = fs.statSync(file); if (s.size) { const fd = fs.openSync(file, 'r'), b = Buffer.alloc(1); try { fs.readSync(fd, b, 0, 1, s.size - 1); } finally { fs.closeSync(fd); } if (b[0] !== 10) lead = '\n'; } } catch {}
  fs.appendFileSync(file, lead + JSON.stringify({ ...entry, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
}

// A capture's media stay in the folder of the idea that took it (c.dir), also after a merge; transcripts are keyed '<dir>/<file>'.
// Everything said in an idea's captures, in order: typed text plus the transcripts of its voice notes.
export function rawText(x) {
  return x.captures.map((c) => [c.text, ...c.audio.map((a) => x.transcripts?.[c.dir + '/' + a])].filter(Boolean).join('\n')).filter(Boolean).join('\n---\n');
}
const words = (s) => new Set(String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1));
export function similar(a, b) {   // Jaccard over the words: 1 = the same words
  const A = words(a), B = words(b); if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / (A.size + B.size - n);
}

// The instructions for the LLM pass. Folders = the project list the console knows (projectFolders), disciplines = disciplines.json's map.
export function buildPrompt(text, { folders = [], disciplines = {}, photos = 0 } = {}) {
  return [
    'An idea the user captured on the go (typed or a voice-note transcript, possibly messy, any language). Prepare it so that later, at a desk, they can start an AI chat about it at once.',
    'Return ONE JSON object and nothing else, with these keys:',
    '"title": at most 8 words, in the idea\'s own language; "text": the idea cleaned up (fix transcription errors, keep every detail, no new facts);',
    `"project": the exact name of the matching project from the list below, or null if unsure; "type": one of ${IDEA_TYPES.join(', ')};`,
    `"discipline": one of ${Object.keys(disciplines).join(', ') || 'none'}, the kind of work it needs;`,
    '"goal": one sentence, what done looks like; "context": what an AI starting this chat needs to know (2-5 short lines); "questions": 0-4 open questions the user should answer first;',
    '"first_message": a ready first message for the chat, in the idea\'s language, written as the user (first person), self-contained;',
    '"keywords": 1-3 single words to search earlier conversations about the same thing.',
    'Never invent facts not in the idea. If something is unclear, put it in "questions".',
    photos ? `He also attached ${photos} photo(s) you cannot see; mention in "context" that the photos are attached.` : '',
    '', 'Projects:', ...folders.map((f) => '- ' + f.name), '', 'The idea:', '"""', String(text).slice(0, 12000), '"""',
  ].filter((l) => l !== null).join('\n');
}

// The LLM's answer -> a checked brief. Unknown project -> null, unknown type -> other, seat from the discipline map (owner when none fits).
export function parseBrief(out, { folders = [], disciplines = {}, owner = null, fallbackText = '' } = {}) {
  const m = String(out).match(/\{[\s\S]*\}/); if (!m) throw new Error('the processor returned no JSON');
  let j; try { j = JSON.parse(m[0]); } catch { throw new Error('the processor returned broken JSON'); }
  const s = (v, n) => String(v ?? '').trim().slice(0, n);
  const title = s(j.title, 200).split(/\s+/).slice(0, 8).join(' ');
  if (!title) throw new Error('the processor returned no title');
  const f = j.project && folders.find((x) => x.name === j.project || path.basename(x.dir) === j.project);
  const disc = Object.hasOwn(disciplines, j.discipline) ? j.discipline : null;
  return {
    title, text: s(j.text, 8000) || fallbackText, project: f ? f.dir : null, projectName: f ? f.name : null,
    type: IDEA_TYPES.includes(j.type) ? j.type : 'other', seat: disc ? disciplines[disc] : owner,
    prep: { goal: s(j.goal, 600), context: s(Array.isArray(j.context) ? j.context.join('\n') : j.context, 2000), questions: (Array.isArray(j.questions) ? j.questions : []).map((q) => s(q, 300)).filter(Boolean).slice(0, 4), firstMessage: s(j.first_message, 4000) },
    keywords: (Array.isArray(j.keywords) ? j.keywords : []).map((k) => s(k, 40)).filter(Boolean).slice(0, 3),
  };
}

// Once-a-day Telegram nudge: the ready ideas older than staleH, at `at` (HH:MM, this machine's local time), at most once per day, never 23:00-07:00.
// last = when the previous digest went out. Returns the ideas to list, or null when nothing is due.
export const quietHour = (d) => d.getHours() >= 23 || d.getHours() < 7;
export function digestDue({ now = Date.now(), last = 0, at = '18:00', staleH = 24, ideas = [] }) {
  const d = new Date(now); if (quietHour(d)) return null;
  const [h, mi] = String(at).split(':').map(Number), slot = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, mi).getTime();
  if (!Number.isFinite(slot) || now < slot || last >= slot) return null;
  const stale = ideas.filter((x) => x.status === 'ready' && now - Date.parse(x.readyAt || x.at) >= staleH * 3600000);
  return stale.length ? stale : null;
}

// Telegram: a text that is meant as an idea (explicit marker), not as a task for a seat. "/idea …" is handled as a command by the bot.
export const IDEA_MARK = /^\s*(?:💡|רעיון(?=[\s:,-]|$)[:,-]?|idea:)\s*/iu;   // \b is ASCII-only: a lookahead ends the Hebrew word

// transcribe(absPath) -> text; llm(prompt) -> raw text (throw an Error with .quota = true / .until for a seat at its limit);
// folders() -> [{ name, dir }]; disciplines() -> { map, owner }; related(keywords, selfText) -> [{ id, title, seat }]; onReady(idea) after a brief is made.
export function createIdeas({ file, mediaDir, transcribe, llm, folders = () => [], disciplines = () => ({ map: {}, owner: null }), related = () => [], onChange = () => {}, onReady = () => {}, log = () => {}, now = () => Date.now() }) {
  const list = () => readIdeas(file), get = (id) => list().find((x) => x.id === id) || null;
  const set = (id, patch) => { append(file, { t: 'set', id, patch }); onChange(); };
  for (const x of list()) if (x.status === 'processing') set(x.id, { status: 'captured' });   // died mid-run: do it again (transcripts made so far are kept)
  let running = false, timer = null;

  function capture({ src = 'console', text = '', audio = [], photos = [], tgMsg = null } = {}) {
    text = String(text || '').trim().slice(0, 20000);
    if (!text && !audio.length && !photos.length) throw new Error('an idea needs text, a voice note or a photo');
    const taken = new Set(list().map((x) => x.id)); let id; do id = crypto.randomBytes(4).toString('hex'); while (taken.has(id));
    const dir = path.join(mediaDir, id), save = (f, i, kind) => {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const e = (/\.([a-z0-9]{1,5})$/i.exec(f.name || '') || [])[1]?.toLowerCase(), ext = EXT[kind].includes(e) ? e : kind === 'audio' ? 'webm' : 'jpg';
      const name = `${kind}-${i + 1}.${ext}`; fs.writeFileSync(path.join(dir, name), f.data, { mode: 0o600 }); return name;
    };
    const a = audio.map((f, i) => save(f, i, 'audio')), p = photos.map((f, i) => save(f, i, 'photo'));
    append(file, { t: 'add', id, src, text, audio: a, photos: p, ...(tgMsg ? { tgMsg } : {}) });
    onChange(); setTimeout(kick, 0);
    return get(id);
  }
  // The owner's edits from the page. Only these keys; the brief is replaced whole when given.
  function update(id, patch = {}) {
    const x = get(id); if (!x) throw new Error('no idea ' + id);
    const out = {};
    if (patch.status != null) {   // only between the states a brief exists in: a queued / processing / failed idea is the pipeline's
      if (!['ready', 'done', 'archived'].includes(patch.status) || !['ready', 'done', 'archived'].includes(x.status) || !x.brief) throw new Error('bad status');
      out.status = patch.status;
    }
    if (patch.brief != null) {
      const b = patch.brief, s = (v, n) => String(v ?? '').trim().slice(0, n), cur = x.brief || {};
      const f = b.project !== undefined ? (b.project && folders().find((k) => k.dir === b.project)) : undefined;
      if (b.project && !f) throw new Error('not a project folder');
      out.brief = { ...cur, ...(b.title != null ? { title: s(b.title, 120) || cur.title } : {}), ...(b.type != null && IDEA_TYPES.includes(b.type) ? { type: b.type } : {}),
        ...(f !== undefined ? { project: f ? f.dir : null, projectName: f ? f.name : null } : {}),
        prep: { ...(cur.prep || {}), ...(b.goal != null ? { goal: s(b.goal, 600) } : {}), ...(b.context != null ? { context: s(b.context, 2000) } : {}), ...(b.firstMessage != null ? { firstMessage: s(b.firstMessage, 4000) } : {}), ...(b.questions != null ? { questions: String(b.questions).split('\n').map((q) => s(q, 300)).filter(Boolean).slice(0, 6) } : {}) } };
    }
    for (const k of ['chat', 'todo']) if (patch[k] != null) out[k] = String(patch[k]).slice(0, 80);
    set(id, out); return get(id);
  }
  function retry(id) { const x = get(id); if (!x) throw new Error('no idea ' + id); if (x.status === 'processing') throw new Error('being prepared right now'); set(id, { status: 'captured', tries: 0, error: null, nextTry: 0, waitUntil: 0 }); setTimeout(kick, 0); return get(id); }
  function del(id) {
    const x = get(id); if (!x) throw new Error('no idea ' + id); if (x.status === 'processing') throw new Error('being prepared right now');
    append(file, { t: 'del', id }); for (const d of new Set(x.captures.map((c) => c.dir))) fs.rmSync(path.join(mediaDir, d), { recursive: true, force: true }); onChange();
  }
  function media(id, name) { if (!ID_RE.test(id) || !FILE_RE.test(name)) return null; const p = path.join(mediaDir, id, name); try { return fs.statSync(p).isFile() ? p : null; } catch { return null; } }

  const due = (x, t) => (x.status === 'captured' && !(x.waitUntil > t)) || (x.status === 'failed' && x.tries < MAX_TRIES && (x.nextTry || 0) <= t);
  async function processOne(x) {
    set(x.id, { status: 'processing' });
    const tr = { ...x.transcripts };
    for (const c of x.captures) for (const a of c.audio) if (tr[c.dir + '/' + a] == null) {   // a voice note: transcribed once, kept
      const f = media(c.dir, a); if (!f) throw new Error('voice note file missing');
      tr[c.dir + '/' + a] = String(await transcribe(f) || '').trim();
      if (get(x.id)?.status !== 'processing') return;   // deleted / changed meanwhile
      set(x.id, { transcripts: { ...tr } });
    }
    x = get(x.id); const text = rawText(x), photos = x.captures.reduce((n, c) => n + c.photos.length, 0);
    if (!text.trim() && !photos) throw new Error('nothing was said in the voice note');
    // the same thing sent twice (a resend, a repeat from Telegram and the page): folded into the older one before any LLM spend
    const t = now(), twin = text.trim() && list().find((o) => o.id !== x.id && ['captured', 'processing', 'ready', 'failed'].includes(o.status) && Date.parse(o.at) < Date.parse(x.at) && t - Date.parse(o.at) < DUP_DAYS * 86400000 && similar(rawText(o), text) >= 0.8);
    if (twin) return merged(x, twin, 'same text');
    const disc = disciplines(), fl = folders();
    const brief = parseBrief(await llm(buildPrompt(text || '(no text, only photos)', { folders: fl, disciplines: disc.map, photos })), { folders: fl, disciplines: disc.map, owner: disc.owner, fallbackText: text });
    let rel = []; try { rel = (await related(brief.keywords, text)).slice(0, 3); } catch {}
    const same = list().find((o) => o.id !== x.id && o.status === 'ready' && o.brief && o.brief.title.toLowerCase() === brief.title.toLowerCase() && o.brief.project === brief.project && t - Date.parse(o.at) < DUP_DAYS * 86400000);
    if (same) return merged(x, same, 'same title');
    if (get(x.id)?.status !== 'processing') return;   // deleted / changed while the LLM ran
    set(x.id, { status: 'ready', brief: { ...brief, related: rel }, readyAt: new Date(now()).toISOString(), error: null });
    try { await onReady(get(x.id)); } catch (e) { log('[ideas] onReady failed: ' + e.message); }
  }
  // A duplicate folds into the older idea; a Telegram capture's "Saved" message still gets the (older) idea's title and Open button.
  async function merged(x, into, why) {
    append(file, { t: 'merge', id: x.id, into: into.id }); onChange(); log(`[ideas] ${x.id} merged into ${into.id} (${why})`);
    const y = get(into.id); if (x.tgMsg && y?.brief) { try { await onReady({ ...y, tgMsg: x.tgMsg }); } catch (e) { log('[ideas] onReady failed: ' + e.message); } }
  }
  async function kick() {
    if (running) return; running = true; clearTimeout(timer);
    try {
      for (;;) {
        const t = now(), next = list().filter((x) => due(x, t)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
        if (!next) break;
        try { await processOne(next); }
        catch (e) {
          if (e.quota) { set(next.id, { status: 'captured', waitUntil: e.until || t + 30 * 60000, error: String(e.message).slice(0, 300) }); log(`[ideas] ${next.id} waits for the processor seat's limit`); continue; }
          const tries = (next.tries || 0) + 1;
          set(next.id, { status: 'failed', tries, error: String(e.message || e).slice(0, 300), nextTry: t + tries * RETRY_MS });
          log(`[ideas] ${next.id} failed (try ${tries}): ${String(e.message || e).slice(0, 200)}`);
        }
      }
    } finally {
      running = false;
      const t = now(), wake = list().map((x) => x.status === 'captured' ? x.waitUntil || 0 : x.status === 'failed' && x.tries < MAX_TRIES ? x.nextTry || 0 : 0).filter((w) => w > t);
      if (wake.length) { timer = setTimeout(kick, Math.min(...wake) - t + 500); timer.unref?.(); }
    }
  }
  return { capture, update, retry, del, media, list, get, kick, idle: () => !running };
}
