// ideas.mjs + the Telegram capture routing: store fold, pipeline with a stubbed Whisper and a stubbed LLM, dedup, retry, quota wait, restart recovery,
// digest timing (once a day, never 23:00-07:00), and that the bot's existing plain-message behaviour (seat picker, replies) is untouched.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import assert from 'node:assert/strict';
import { readIdeas, createIdeas, parseBrief, buildPrompt, digestDue, similar, IDEA_MARK, MAX_TRIES } from './ideas.mjs';
import { createTelegram } from './telegram.mjs';
import { useLanguage } from './i18n.mjs';
useLanguage(() => 'he');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ideas-')), file = path.join(dir, 'ideas.jsonl'), media = path.join(dir, 'media');
const folders = [{ name: 'tools/seats', dir: '/p/tools/seats' }, { name: 'apps/shop', dir: '/p/apps/shop' }];
const disc = { map: { backend: 'dev', design: 'studio' }, owner: 'dev' };
const wait = async (f, ms = 4000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };
let pass = 0; const ok = (m) => { pass++; console.log('ok ' + m); };
try {
  // ---- parseBrief / prompt ----
  const good = JSON.stringify({ title: 'Ideas inbox in the console with voice notes and more words', text: 'clean', project: 'tools/seats', type: 'build', discipline: 'backend', goal: 'g', context: ['a', 'b'], questions: ['q1', ''], first_message: 'Build it', keywords: ['ideas'] });
  let b = parseBrief('sure:\n' + good, { folders, disciplines: disc.map, owner: 'dev' });
  assert.equal(b.title.split(' ').length, 8); assert.equal(b.project, '/p/tools/seats'); assert.equal(b.seat, 'dev'); assert.equal(b.type, 'build'); assert.deepEqual(b.prep.questions, ['q1']); assert.equal(b.prep.context, 'a\nb');
  b = parseBrief(JSON.stringify({ title: 'x', project: 'nope', type: 'weird', discipline: 'zzz' }), { folders, disciplines: disc.map, owner: 'dev', fallbackText: 'raw' });
  assert.equal(b.project, null); assert.equal(b.type, 'other'); assert.equal(b.seat, 'dev'); assert.equal(b.text, 'raw');
  assert.throws(() => parseBrief('no json here', {}), /no JSON/); assert.throws(() => parseBrief('{"title":""}', {}), /no title/);
  assert.ok(buildPrompt('hello', { folders, disciplines: disc.map }).includes('- tools/seats'));
  ok('parseBrief: 8-word title, project matched or null, type/seat fallbacks, bad output throws');

  // ---- pipeline ----
  const llmCalls = [], trCalls = []; let llmMode = 'ok', readyHook = [];
  const llm = async (p) => { llmCalls.push(p); if (llmMode === 'fail') throw new Error('boom'); if (llmMode === 'quota') throw Object.assign(new Error('limit'), { quota: true, until: Date.now() + 3600000 }); return good.replace('Ideas inbox in the console with voice notes and more words', 'Idea ' + llmCalls.length); };
  const transcribe = async (f) => { trCalls.push(f); assert.ok(fs.existsSync(f)); return 'build an ideas inbox for the seat console with voice'; };
  const mk = () => createIdeas({ file, mediaDir: media, transcribe, llm, folders: () => folders, disciplines: () => disc, related: async (k) => [{ id: 'c1', title: 'old chat about ' + k[0], seat: 'ops' }], onReady: (x) => readyHook.push(x.id) });
  let I = mk();
  assert.equal(I.capture({ text: 'ext check', photos: [{ data: Buffer.from('x'), name: 'evil.html' }] }).captures[0].photos[0], 'photo-1.jpg');   // only allowlisted extensions are stored
  I.del(I.list()[0].id);
  const a = I.capture({ src: 'telegram', audio: [{ data: Buffer.from('OggS fake'), name: 'voice.oga' }], tgMsg: 55 });
  assert.equal(a.status, 'captured'); assert.deepEqual(a.captures[0].audio, ['audio-1.oga']); assert.equal(a.tgMsg, 55);
  await wait(() => I.get(a.id).status === 'ready');
  let x = I.get(a.id);
  assert.equal(trCalls.length, 1); assert.equal(llmCalls.length, 1); assert.ok(llmCalls[0].includes('build an ideas inbox'));
  assert.equal(x.brief.project, '/p/tools/seats'); assert.equal(x.brief.seat, 'dev'); assert.equal(x.brief.related[0].id, 'c1'); assert.deepEqual(readyHook, [a.id]);
  ok('voice note -> transcribed once -> LLM brief -> ready, related chats attached, onReady called');

  // the same thing again (typed this time): merged into the first, no second LLM call, both captures kept
  const dup = I.capture({ src: 'console', text: 'Build an ideas inbox for the seat console, with voice!' });
  await wait(() => !I.get(dup.id) && I.idle());
  x = I.get(a.id); assert.equal(x.captures.length, 2); assert.equal(x.captures[1].dir, dup.id); assert.ok(x.transcripts[a.id + '/audio-1.oga']); assert.equal(llmCalls.length, 1); assert.equal(I.list().length, 1);
  assert.ok(similar('aa bb cc', 'cc bb aa') === 1 && similar('aa bb', 'xx yy') === 0);
  ok('duplicate capture merged into the older idea before any LLM spend');

  // failure -> failed with tries + nextTry (no busy loop); manual retry runs it again
  llmMode = 'fail'; const f = I.capture({ text: 'a totally different thought about invoices' });
  await wait(() => I.get(f.id).status === 'failed' && I.idle());
  assert.equal(I.get(f.id).tries, 1); assert.ok(I.get(f.id).nextTry > Date.now()); assert.match(I.get(f.id).error, /boom/);
  assert.throws(() => I.update(f.id, { status: 'ready' }), /bad status/);   // no brief: not 'ready' by hand
  const n = llmCalls.length; await new Promise((r) => setTimeout(r, 100)); assert.equal(llmCalls.length, n);
  llmMode = 'ok'; I.retry(f.id); await wait(() => I.get(f.id).status === 'ready'); assert.equal(I.get(f.id).tries, 0);
  assert.ok(MAX_TRIES === 3);
  ok('failed LLM -> failed (try 1, backoff), retry button path -> ready');

  // quota: waits without counting as a failure
  llmMode = 'quota'; const q = I.capture({ text: 'something for later about the parrot book' });
  await wait(() => I.get(q.id).waitUntil > Date.now() && I.idle());
  assert.equal(I.get(q.id).status, 'captured'); assert.equal(I.get(q.id).tries, 0);
  ok('seat at its limit -> idea waits (captured, waitUntil), tries unchanged');

  // restart mid-run: 'processing' found at start goes back to the queue; the transcript is not redone
  llmMode = 'ok'; fs.appendFileSync(file, JSON.stringify({ t: 'set', id: q.id, patch: { status: 'processing', waitUntil: 0 } }) + '\n');
  fs.appendFileSync(file, '{"t":"set","id":"'); // torn line
  I = mk(); assert.equal(I.get(q.id).status, 'captured'); I.kick(); await wait(() => I.get(q.id).status === 'ready');
  assert.equal(trCalls.length, 1);
  ok('restart: processing -> captured -> ready; torn line skipped; transcripts kept');

  // edits from the page
  x = I.update(a.id, { brief: { title: 'New title', project: '/p/apps/shop', firstMessage: 'Hi', questions: 'one\ntwo' } });
  assert.equal(x.brief.title, 'New title'); assert.equal(x.brief.projectName, 'apps/shop'); assert.equal(x.brief.prep.firstMessage, 'Hi'); assert.deepEqual(x.brief.prep.questions, ['one', 'two']); assert.equal(x.brief.prep.goal, 'g');
  assert.throws(() => I.update(a.id, { brief: { project: '/etc' } }), /not a project/); assert.throws(() => I.update(a.id, { status: 'processing' }), /bad status/);
  x = I.update(a.id, { status: 'done', chat: 'conv-9' }); assert.equal(x.status, 'done'); assert.equal(x.chat, 'conv-9');
  assert.equal(I.media(a.id, '../x'), null); assert.equal(I.media('00000000', '..'), null); assert.equal(I.media(a.id, '.'), null); assert.ok(I.media(a.id, 'audio-1.oga'));
  I.del(f.id); assert.equal(I.get(f.id), null); assert.ok(!fs.existsSync(path.join(media, f.id)));
  assert.equal(readIdeas(file).length, I.list().length);
  ok('update (title, project, prep, status, chat), bad project / status refused, media path guard, delete removes media');

  // ---- digest timing ----
  const at = (h, m = 0, d = 23) => new Date(2026, 10, d, h, m).getTime();
  const old = [{ status: 'ready', readyAt: new Date(at(9, 0, 22)).toISOString() }, { status: 'ready', readyAt: new Date(at(17, 0)).toISOString() }, { status: 'done', readyAt: new Date(at(1, 0, 20)).toISOString() }];
  assert.equal(digestDue({ now: at(17, 59), ideas: old }), null);                       // before 18:00
  assert.equal(digestDue({ now: at(18, 1), ideas: old }).length, 1);                     // only the one older than 24 h
  assert.equal(digestDue({ now: at(18, 30), last: at(18, 1), ideas: old }), null);       // once a day
  assert.equal(digestDue({ now: at(18, 0, 24), last: at(18, 1), ideas: old }).length, 2); // the next day: both are stale now
  assert.equal(digestDue({ now: at(23, 30), ideas: old }), null);                       // quiet hours
  assert.equal(digestDue({ now: at(6, 30, 24), last: at(18, 1), at: '18:00', ideas: old }), null);
  assert.equal(digestDue({ now: at(20, 0), ideas: [{ status: 'ready', readyAt: new Date(at(19, 0)).toISOString() }] }), null);   // nothing stale
  assert.equal(digestDue({ now: at(8, 0), at: '07:30', staleH: 1, ideas: old }).length, 1);
  ok('digest: at the set time, once a day, only stale ready ideas, never 23:00-07:00');

  // ---- Telegram routing ----
  assert.ok(IDEA_MARK.test('💡 buy milk') && IDEA_MARK.test('רעיון: לבנות') && IDEA_MARK.test('Idea: x') && !IDEA_MARK.test('רעיונות טובים') && !IDEA_MARK.test('fix the bug'));
  const calls = []; let updates = [], nextMsg = 100;
  const api = http.createServer((req, res) => { let s = ''; req.on('data', (d) => s += d); req.on('end', () => {
    if (req.url.includes('/file/bot')) return res.end('OggS-voice-bytes');
    const method = req.url.split('/').pop(), body = s ? JSON.parse(s) : {}; calls.push({ method, body });
    let result = true;
    if (method === 'getUpdates') { result = updates; updates = []; if (!result.length) return setTimeout(() => res.end('{"ok":true,"result":[]}'), 100); }
    if (method === 'sendMessage') result = { message_id: ++nextMsg };
    if (method === 'getFile') result = { file_path: 'voice/file_1.oga' };
    res.end(JSON.stringify({ ok: true, result }));
  }); }).listen(0);
  await new Promise((r) => api.once('listening', r));
  const cfgFile = path.join(dir, 'tg.json'); fs.writeFileSync(cfgFile, JSON.stringify({ botToken: '1:TOKEN', chatId: '555' }));
  const got = [], tasks = [], replies = [], msgMap = { 900: 'conv-x' }; let capture = true;
  const tg = createTelegram({ cfgFile, apiBase: `http://127.0.0.1:${api.address().port}`, seats: ['ops', 'dev'], phoneBase: 'http://x', idleMs: 30, msgMap, log: () => {},
    onIdea: async (p) => { got.push(p); }, ideaCapture: () => capture,
    onNewTask: async (t) => { tasks.push(t); }, onList: async () => [], onStatus: async () => ({ seats: [] }), onDecision: async () => 'x',
    onReply: Object.assign(async (c, p) => { replies.push([c, p]); return 'sent'; }, { acceptsImages: true }) });
  tg.start();
  let uid = 1; const msg = (m) => { updates.push({ update_id: uid++, message: { message_id: 10 + uid, chat: { id: 555, type: 'private' }, ...m } }); };
  msg({ voice: { file_id: 'v1', file_size: 100 } }); await wait(() => got.length === 1);
  assert.equal(got[0].audio.length, 1); assert.equal(got[0].audio[0].data.toString(), 'OggS-voice-bytes'); assert.ok(got[0].tgMsg > 100);
  assert.ok(calls.some((c) => c.method === 'sendMessage' && c.body.text.startsWith('💡')));
  msg({ text: '💡 לבנות תיבת רעיונות' }); await wait(() => got.length === 2); assert.equal(got[1].text, 'לבנות תיבת רעיונות');
  msg({ text: '/idea write the parrot post' }); await wait(() => got.length === 3); assert.equal(got[2].text, 'write the parrot post');
  msg({ photo: [{ file_id: 'p1', file_size: 10 }], caption: 'this shelf' }); await wait(() => got.length === 4); assert.equal(got[3].photos.length, 1); assert.equal(got[3].text, 'this shelf');
  ok('Telegram: voice note, 💡 text, /idea, photo -> Ideas (ack sent)');
  // plain text: still the seat picker (no idea), with a Save-as-idea button that does save it
  msg({ text: 'fix the login page' }); await wait(() => calls.some((c) => c.body.reply_markup?.inline_keyboard?.some((r) => r[0].callback_data?.startsWith('i:'))));
  const pk = calls.filter((c) => c.body.reply_markup).at(-1).body.reply_markup.inline_keyboard;
  assert.ok(pk.some((r) => r[0].callback_data === 's:' + pk.at(-1)[0].callback_data.slice(2) + ':ops')); assert.equal(got.length, 4);
  updates.push({ update_id: uid++, callback_query: { id: 'cb1', data: pk.at(-1)[0].callback_data, message: { message_id: 300, chat: { id: 555 } } } });
  await wait(() => got.length === 5); assert.equal(got[4].text, 'fix the login page'); assert.equal(got[4].tgMsg, 300);
  ok('Telegram: plain text still opens the seat picker; its 💡 button saves the text as an idea');
  // a reply to a notification still goes to that conversation, voice included
  msg({ voice: { file_id: 'v2', file_size: 100 }, reply_to_message: { message_id: 900 } }); await wait(() => replies.length === 1);
  assert.equal(replies[0][0], 'conv-x'); assert.equal(got.length, 5);
  // capture off in Settings: a lone voice note gets the old hint, 💡 text becomes a normal picker task, /idea still works (explicit)
  capture = false; const before = calls.length;
  msg({ voice: { file_id: 'v3', file_size: 100 } }); await wait(() => calls.slice(before).some((c) => c.method === 'sendMessage' && c.body.text.startsWith('📎')));
  msg({ text: '💡 later' }); await wait(() => calls.slice(before).some((c) => c.body.reply_markup?.inline_keyboard?.some((r) => r[0].callback_data?.startsWith('s:'))));
  assert.ok(!calls.filter((c) => c.body.reply_markup).at(-1).body.reply_markup.inline_keyboard.some((r) => r[0].callback_data.startsWith('i:'))); assert.equal(got.length, 5);
  msg({ text: '/idea explicit' }); await wait(() => got.length === 6);
  ok('Telegram: replies untouched; capture off -> old behaviour for voice and plain text, /idea still saves');
  tg.stop(); api.close();
  console.log(`test-ideas: ${pass} passed`);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
setTimeout(() => process.exit(0), 50);
