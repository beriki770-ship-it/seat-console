// todos.mjs: add via the CLI (env SEAT_TODOS + SEAT_CONV), fold, comment keeps it open, done closes it once, torn line skipped.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process'; import { fileURLToPath } from 'node:url';
import { readTodos, addTodo, markTodo, parseDue, DEFAULT_DUE_MS } from './todos.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-')), f = path.join(dir, 'todos.jsonl');
try {
  const id = execFileSync(process.execPath, [path.join(HERE, 'todos.mjs'), 'add', 'Open an account at example.com'], { env: { ...process.env, SEAT_TODOS: f, SEAT_CONV: 'conv-1' } }).toString().trim();
  assert.match(id, /^[0-9a-f]{6}$/);
  let [x] = readTodos(f); assert.equal(x.conv, 'conv-1'); assert.equal(x.what, 'Open an account at example.com'); assert.ok(!x.doneAt);
  fs.appendFileSync(f, '{"t":"add","id":"abc'); // torn
  const id2 = addTodo(f, null, 'second'); assert.equal(readTodos(f)[0].id, id2);   // newest first, torn line skipped
  assert.throws(() => markTodo(f, id, 'comment', ''), /empty comment/);
  markTodo(f, id, 'comment', 'which email?'); x = readTodos(f).find((k) => k.id === id); assert.ok(!x.doneAt); assert.equal(x.comments[0].text, 'which email?');
  markTodo(f, id, 'done', 'opened with info@'); x = readTodos(f).find((k) => k.id === id); assert.ok(x.doneAt); assert.equal(x.comments.length, 2);
  assert.throws(() => markTodo(f, id, 'done'), /already done/);
  assert.throws(() => markTodo(f, 'ffffff', 'done'), /no task/);
  assert.throws(() => execFileSync(process.execPath, [path.join(HERE, 'todos.mjs'), 'add', 'x'], { env: { ...process.env, SEAT_TODOS: '' }, stdio: 'pipe' }));
  const now = Date.parse('2026-11-23T10:00:00Z');
  assert.equal(parseDue('+2h', now), '2026-11-23T12:00:00.000Z'); assert.equal(parseDue('+30m', now), '2026-11-23T10:30:00.000Z');
  assert.throws(() => parseDue('tomorrow-ish', now), /cannot read/);
  const id3 = execFileSync(process.execPath, [path.join(HERE, 'todos.mjs'), 'add', 'Sign the form', '--due', '2026-11-24T09:00:00Z'], { env: { ...process.env, SEAT_TODOS: f, SEAT_CONV: 'c' } }).toString().trim();
  x = readTodos(f).find((k) => k.id === id3); assert.equal(x.what, 'Sign the form'); assert.equal(x.due, '2026-11-24T09:00:00.000Z');
  x = readTodos(f).find((k) => k.id === id2); assert.equal(Date.parse(x.due) - Date.parse(x.at), DEFAULT_DUE_MS);   // no --due: one hour
  // dismiss: closed (not done), reason kept, reopen puts it back, errors on repeats
  const id4 = addTodo(f, 'c', 'Cancel the old plan');
  markTodo(f, id4, 'dismiss', 'bought elsewhere'); x = readTodos(f).find((k) => k.id === id4);
  assert.ok(x.dismissedAt); assert.ok(!x.doneAt); assert.equal(x.comments[0].text, 'bought elsewhere');
  assert.throws(() => markTodo(f, id4, 'dismiss'), /already dismissed/); assert.throws(() => markTodo(f, id4, 'done'), /already dismissed/);
  markTodo(f, id4, 'reopen'); x = readTodos(f).find((k) => k.id === id4); assert.ok(!x.dismissedAt && !x.doneAt);
  assert.throws(() => markTodo(f, id4, 'reopen'), /already open/);
  // machine check: exit 0 closes (auto), non-zero stays, timeout/127 = error, 5 errors = broken, the page path cannot set a check
  const { checkTodos, runCheck } = await import('./todos.mjs'), SLOW = `"${process.execPath}" -e "setTimeout(() => {}, 5000)"`, WIN = process.platform === 'win32';   // cmd.exe exits 1 for an unknown command: no 'not found' there   // sh and cmd.exe alike
  const st = { last: {}, errs: {} }, ok = addTodo(f, 'c', 'ok one', null, 'exit 0'), no = addTodo(f, 'c', 'no one', null, 'exit 1'), nf = addTodo(f, 'c', 'bad cmd', null, 'no-such-cmd-xyz'), sl = addTodo(f, 'c', 'slow', null, SLOW);
  assert.equal((await runCheck('exit 3')).code, 3); if (!WIN) assert.equal((await runCheck('no-such-cmd-xyz')).error, 'not found'); assert.equal((await runCheck(SLOW, 200)).error, 'timeout');
  const run = (c) => runCheck(c, 300);
  assert.deepEqual(await checkTodos(f, st, { minAgeMs: 0, run }), [ok]);
  x = readTodos(f).find((k) => k.id === ok); assert.ok(x.doneAt && x.auto); assert.ok(!readTodos(f).find((k) => k.id === no).doneAt);
  assert.equal(st.errs[no], undefined); assert.equal(st.errs[sl], 1); if (!WIN) assert.equal(st.errs[nf], 1);   // plain non-zero is not an error
  const before = st.errs[sl]; assert.deepEqual(await checkTodos(f, st, { run }), []); assert.equal(st.errs[sl], before);   // not due again within 10 min
  for (let i = 0; i < 4; i++) await checkTodos(f, st, { minAgeMs: 0, run });
  assert.ok(readTodos(f).find((k) => k.id === sl).checkBroken); const n = st.errs[sl];
  await checkTodos(f, st, { minAgeMs: 0, run }); assert.equal(st.errs[sl], n);   // broken: no longer run
  // the page's POST can only name done / comment / dismiss / reopen: no check is written by markTodo
  markTodo(f, no, 'comment', 'hi', { check: 'touch /tmp/pwn' }); assert.equal(readTodos(f).find((k) => k.id === no).check, 'exit 1');
  // seat CLI: done / dismiss only from the asking conversation
  const cli = (env, ...a) => execFileSync(process.execPath, [path.join(HERE, 'todos.mjs'), ...a], { env: { ...process.env, SEAT_TODOS: f, ...env }, stdio: 'pipe' }).toString().trim();
  const id5 = cli({ SEAT_CONV: 'cc' }, 'add', 'two words', '--check', 'test -f /nope', '--due', '+1h'); x = readTodos(f).find((k) => k.id === id5); assert.equal(x.check, 'test -f /nope'); assert.equal(x.what, 'two words');
  assert.throws(() => cli({ SEAT_CONV: 'other' }, 'done', id5, 'x')); assert.ok(!readTodos(f).find((k) => k.id === id5).doneAt);
  cli({ SEAT_CONV: 'cc' }, 'done', id5, 'file exists now'); x = readTodos(f).find((k) => k.id === id5); assert.ok(x.doneAt); assert.equal(x.comments[0].text, 'file exists now');
  // approval task: approve / reject close it with an outcome, done is refused, seat CLI --approve
  const ap = addTodo(f, 'c', 'Send the mail to X', null, null, 'approval'), ap2 = addTodo(f, 'c', 'Publish Y', null, null, 'approval');
  x = readTodos(f).find((k) => k.id === ap); assert.equal(x.kind, 'approval');
  assert.throws(() => markTodo(f, ap, 'done'), /approve or reject/); assert.ok(!readTodos(f).find((k) => k.id === ap).doneAt);
  const rp = addTodo(f, 'c', 'regular one'), rq = addTodo(f, 'c', 'regular two');   // approve / reject also close a regular task
  markTodo(f, rp, 'approve', 'fine'); x = readTodos(f).find((k) => k.id === rp); assert.ok(x.doneAt); assert.equal(x.outcome, 'approved'); assert.equal(x.kind, undefined);
  markTodo(f, rq, 'reject', 'no'); assert.equal(readTodos(f).find((k) => k.id === rq).outcome, 'rejected');
  markTodo(f, ap, 'approve', 'ok, go'); x = readTodos(f).find((k) => k.id === ap); assert.ok(x.doneAt); assert.equal(x.outcome, 'approved'); assert.equal(x.comments[0].text, 'ok, go');
  assert.throws(() => markTodo(f, ap, 'reject'), /already approved/);
  markTodo(f, ap2, 'reject', 'not yet'); x = readTodos(f).find((k) => k.id === ap2); assert.ok(x.doneAt); assert.equal(x.outcome, 'rejected'); assert.equal(x.comments[0].text, 'not yet');
  markTodo(f, ap2, 'reopen'); x = readTodos(f).find((k) => k.id === ap2); assert.ok(!x.doneAt && !x.outcome && x.kind === 'approval');
  const id6 = cli({ SEAT_CONV: 'cc' }, 'add', 'Approve the', 'invoice', '--approve', '--due', '+1h'); x = readTodos(f).find((k) => k.id === id6); assert.equal(x.kind, 'approval'); assert.equal(x.what, 'Approve the invoice');
  assert.throws(() => cli({ SEAT_CONV: 'cc' }, 'done', id6, 'x')); assert.throws(() => cli({ SEAT_CONV: 'cc' }, 'add', 'x', '--approve', '--check', 'true'));
  // a comment written from a Telegram reply carries src (the page tags it); the page's path (no opts) never does, nor any other kind
  const tgc = addTodo(f, 'c', 'telegram one'); markTodo(f, tgc, 'comment', 'from the phone', { src: 'telegram' }); markTodo(f, tgc, 'comment', 'from the page'); markTodo(f, tgc, 'done', 'x', { src: 'telegram' });
  assert.deepEqual(readTodos(f).find((k) => k.id === tgc).comments.map((c) => c.src || null), ['telegram', null, null]);
  if (process.platform !== 'win32' && execFileSync('/bin/sh', ['-c', 'command -v ffmpeg || true']).toString().trim()) await telegramE2E(); else console.log('test-todos: SKIPPED the Telegram end-to-end part: Windows, or ffmpeg is not installed (the voice worker decodes with it)');
  console.log('test-todos: all passed');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

// Telegram -> task, end to end on an isolated instance (own port + data, fake claude, fake Bot API, stub Whisper worker): 💬 vm:<id> gets a ForceReply
// prompt; a voice note sent as a reply to it is transcribed by the (stub) Whisper, noted on the task with src telegram, and reaches the asking
// conversation with the audio attached; the bot answers "✅ … <seat>"; a reply after the task is closed gets one error line and changes nothing.
async function telegramE2E() {
  const http = await import('node:http'), { spawn } = await import('node:child_process');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-tg-')), DATA = path.join(WORK, 'data'); fs.mkdirSync(DATA); fs.mkdirSync(path.join(WORK, 'home'));
  const ROOT_SEATS = path.join(HERE, '..', 'seats.json'), OWN_SEATS = !fs.existsSync(ROOT_SEATS);   // seat init (seat.sh) reads the repo's seats.json: a fresh clone (CI) gets a throwaway one, removed at the end
  if (OWN_SEATS) fs.writeFileSync(ROOT_SEATS, JSON.stringify({ projectsDir: WORK, seats: { demo: { email: 'demo@example.com', role: 'test seat' } } }));
  const SEAT = Object.entries(JSON.parse(fs.readFileSync(ROOT_SEATS, 'utf8').replace(/^﻿/, '')).seats).filter(([, v]) => !v.agent).pop()[0];
  const STUB = path.join(WORK, 'fake-whisper.cjs');   // speaks worker.py's line protocol: {ready} then {id, text} per clip
  fs.writeFileSync(STUB, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ ready: true }) + '\\n');\nrequire('readline').createInterface({ input: process.stdin }).on('line', (l) => { const m = JSON.parse(l); process.stdout.write(JSON.stringify({ id: m.id, text: 'stub transcript ' + (m.mode || 'plain'), lang: 'he' }) + '\\n'); });\n");
  fs.chmodSync(STUB, 0o755);
  const calls = []; let updates = [], nextMsg = 500;
  const api = http.createServer((req, res) => {
    if (req.url.includes('/file/bot')) { req.resume(); return void res.end(fs.readFileSync(path.join(HERE, 'fixtures', 'voice-he.wav'))); }
    let b = ''; req.on('data', (x) => (b += x)); req.on('end', () => {
      const method = req.url.split('/').pop(), body = b ? JSON.parse(b) : {}; calls.push({ method, body });
      if (method === 'getUpdates') { const u = updates; updates = []; return void setTimeout(() => res.end(JSON.stringify({ ok: true, result: u })), u.length ? 0 : 150); }
      res.end(JSON.stringify({ ok: true, result: method === 'sendMessage' ? { message_id: ++nextMsg } : method === 'getFile' ? { file_path: 'voice/v.oga' } : true }));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => api.once('listening', r));
  fs.writeFileSync(path.join(DATA, 'telegram-off.json'), JSON.stringify({ botToken: '1:TESTTOKEN', chatId: '555' }));
  const PORT = await new Promise((r) => { const x = http.createServer().listen(0, '127.0.0.1', () => { const p = x.address().port; x.close(() => r(p)); }); });
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/i.test(k))), HOME: path.join(WORK, 'home'), VOICE_PY: STUB, SEAT_TG_API: `http://127.0.0.1:${api.address().port}` };
  const fd = fs.openSync(path.join(DATA, 'server.log'), 'a');
  const srv = spawn(process.execPath, [path.join(HERE, 'server.mjs'), '--port', String(PORT), '--data', DATA, '--claude', path.join(HERE, 'fixtures', 'fake-claude.mjs')], { stdio: ['ignore', fd, fd], env, cwd: HERE }); fs.closeSync(fd);
  const req = (method, p, body, token) => new Promise((ok) => { const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Seat-Token': token } : {}) } }, (rs) => { let d = ''; rs.on('data', (x) => (d += x)); rs.on('end', () => ok({ code: rs.statusCode, body: d })); }); r.on('error', (e) => ok({ code: 'err ' + e.message })); r.end(body ? JSON.stringify(body) : undefined); });
  const wait = async (fn, ms = 30000) => { const t0 = Date.now(); while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + fn); await sleep(100); } };
  try {
    let TOKEN = ''; await wait(async () => { try { TOKEN = fs.readFileSync(path.join(DATA, 'token.txt'), 'utf8').trim(); } catch {} return TOKEN && (await req('GET', '/health')).code === 200; });
    const sent = await req('POST', '/api/send', { seat: SEAT, text: 'hello', mode: 'auto', cwd: WORK }, TOKEN); assert.equal(sent.code, 200, sent.body);
    const conv = JSON.parse(sent.body).conversationId, TF = path.join(DATA, 'todos.jsonl'), log = path.join(DATA, 'logs', SEAT, conv + '.jsonl');
    await wait(() => fs.existsSync(log) && /echo: hello/.test(fs.readFileSync(log, 'utf8')));
    const tid = addTodo(TF, conv, 'Upload the screenshot of Pages');
    updates = [{ update_id: 1, callback_query: { id: 'q1', data: 'vm:' + tid, message: { message_id: 7, chat: { id: 555 }, text: 'card' } } }];
    await wait(() => calls.some((c) => c.method === 'sendMessage' && c.body.reply_markup?.force_reply));
    const prompt = calls.find((c) => c.method === 'sendMessage' && c.body.reply_markup?.force_reply), promptId = 500 + calls.filter((c) => c.method === 'sendMessage').indexOf(prompt) + 1;
    assert.ok(prompt.body.text.includes('Upload the screenshot of Pages'), prompt.body.text);
    updates = [{ update_id: 2, message: { message_id: 90, chat: { id: 555, type: 'private' }, voice: { file_id: 'vn1', file_size: 5000 }, reply_to_message: { message_id: promptId } } }];
    await wait(() => calls.some((c) => c.method === 'sendMessage' && c.body.reply_to_message_id === 90));
    const ack = calls.find((c) => c.method === 'sendMessage' && c.body.reply_to_message_id === 90).body.text;
    assert.ok(ack.startsWith('✅') && ack.includes(`<b>${SEAT}</b>`) && ack.includes('stub transcript segments'), ack);
    const x = readTodos(TF).find((k) => k.id === tid); assert.ok(!x.doneAt); assert.equal(x.comments.length, 1); assert.equal(x.comments[0].src, 'telegram'); assert.match(x.comments[0].text, /^🎙 stub transcript segments$/);
    await wait(() => /The user commented on the task \\"Upload the screenshot of Pages\\"[^"]*Their comment: 🎙 stub transcript segments/.test(fs.readFileSync(log, 'utf8')));
    assert.ok(fs.readdirSync(path.join(DATA, 'uploads', conv)).length >= 1, 'the voice note is attached to the conversation');
    assert.match(fs.readFileSync(log, 'utf8'), /"type":"console_user","text":"💬 The user commented[^\n]*"files":\[\{"name"/);   // the voice note rides with the comment
    // closed task: one error line, no comment, nothing new in the chat
    await wait(() => /echo: 💬 The user commented/.test(fs.readFileSync(log, 'utf8'))); await sleep(500);   // the seat's answer to the comment is in: the log is quiet now
    markTodo(TF, tid, 'done'); const before = fs.readFileSync(log, 'utf8').length;
    updates = [{ update_id: 3, message: { message_id: 91, chat: { id: 555, type: 'private' }, text: 'and now?', reply_to_message: { message_id: promptId } } }];
    await wait(() => calls.some((c) => c.method === 'sendMessage' && c.body.reply_to_message_id === 91));
    const er = calls.find((c) => c.method === 'sendMessage' && c.body.reply_to_message_id === 91).body.text; assert.ok(er.startsWith('❌') && /closed/i.test(er), er);
    assert.equal(readTodos(TF).find((k) => k.id === tid).comments.length, 1); await sleep(500); assert.equal(fs.readFileSync(log, 'utf8').length, before);
    console.log('test-todos: telegram reply -> task comment (voice, stub Whisper) end to end OK');
  } catch (e) { try { console.log(fs.readFileSync(path.join(DATA, 'server.log'), 'utf8').slice(-3000)); console.log('getUpdates', calls.filter((c) => c.method === 'getUpdates').length, JSON.stringify(calls.filter((c) => c.method === 'getUpdates').slice(-2).map((c) => c.body))); console.log(JSON.stringify(calls.filter((c) => c.method !== 'getUpdates').map((c) => [c.method, c.body.text]).slice(-8))); } catch {} throw e; }
  finally { srv.kill(); api.close(); await sleep(300); fs.rmSync(WORK, { recursive: true, force: true }); if (OWN_SEATS) fs.rmSync(ROOT_SEATS, { force: true }); }
}
