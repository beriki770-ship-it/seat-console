// Run: node console/test-files.mjs. The files a finished turn produced, sent to Telegram: method by type and size (planFiles), the 5-file cap,
// and the real multipart uploads against a local fake Bot API (reply_to set, file bytes intact, a failing file logged and skipped, a refused photo resent as a document, a 429 waited out once, one shared queue).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createTelegram, planFiles, FILES_MAX, PHOTO_MAX, UPLOAD_MAX } from './telegram.mjs';

const MB = 1024 * 1024, f = (name, size) => ({ path: 'C:\\x\\' + name, name, size });
// planFiles: photo <= 10 MB inline, mp4 <= 50 MB as video, everything else <= 50 MB as document, bigger = a text line
{
  const p = planFiles([f('a.png', MB), f('b.jpg', PHOTO_MAX + 1), f('c.mp4', 49 * MB), f('d.pdf', MB), f('e.mp4', UPLOAD_MAX + 1)]);
  assert.deepEqual(p.send.map((x) => [x.method, x.field, x.file.name]), [['sendPhoto', 'photo', 'a.png'], ['sendDocument', 'document', 'b.jpg'], ['sendVideo', 'video', 'c.mp4'], ['sendDocument', 'document', 'd.pdf']]);
  assert.deepEqual(p.lines, ['📎 e.mp4 (50.0 MB): too big for Telegram, open in console']);
  assert.equal(planFiles([f('s.svg', 10), f('g.gif', 10), f('W.PNG', 10)]).send.map((x) => x.method).join(), 'sendDocument,sendDocument,sendPhoto', 'svg/gif are documents, extension case ignored');
  const many = planFiles(Array.from({ length: 8 }, (_, i) => f(`p${i}.png`, 10)));
  assert.equal(FILES_MAX, 5); assert.equal(many.send.length, 5, 'at most 5 files'); assert.deepEqual(many.lines, ['+3 more in console']);
  console.log('ok  planFiles: methods, size limits, 5-file cap');
}

// fake Bot API: records method, content type and the multipart fields
const calls = []; let fail = {}, rate = {};   // fail[method] = always 400; rate[method] = n -> the next n calls get 429 retry_after 1
const api = http.createServer((req, res) => {
  const chunks = []; req.on('data', (x) => chunks.push(x)); req.on('end', async () => {
    const method = req.url.split('/').pop(), raw = Buffer.concat(chunks), type = req.headers['content-type'] || '';
    let body;
    if (type.startsWith('multipart/form-data')) { const fd = await new Response(raw, { headers: { 'content-type': type } }).formData(); body = {}; for (const [k, v] of fd) body[k] = typeof v === 'string' ? v : { name: v.name, bytes: Buffer.from(await v.arrayBuffer()) }; }
    else body = raw.length ? JSON.parse(raw) : {};
    calls.push({ method, type, body });
    if (fail[method]) return res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' }));
    if (rate[method] > 0) { rate[method]--; return res.end(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } })); }
    res.end(JSON.stringify({ ok: true, result: { message_id: 500 + calls.length } }));
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => api.on('listening', r));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgfiles-')), cfgFile = path.join(dir, 'tg.json');
fs.writeFileSync(cfgFile, JSON.stringify({ botToken: '123:SECRET', chatId: '42' }));
const logs = [];
const tg = createTelegram({ cfgFile, apiBase: `http://127.0.0.1:${api.address().port}`, log: (l) => logs.push(l), onNewTask: async () => {}, onList: async () => [], onStatus: async () => ({ seats: [] }), onDecision: async () => 'x', onReply: async () => 'x' });
const real = (name, bytes) => { const p = path.join(dir, name); fs.writeFileSync(p, bytes); return { path: p, name, size: bytes.length }; };
const png = real('shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255])), mp4 = real('cut.mp4', Buffer.alloc(64, 7)), pdf = real('report.pdf', Buffer.from('%PDF-1.4 x'));

// notify resolves to the sent message, so the files can reply to it
{
  const m = await tg.notify('done', { seat: 'ops', title: 'T', text: 'סיכום: ok', convId: '0123abcd-0000' }, 'http://x');
  assert.equal(m.message_id, 501, 'notify returns the done-message');
  calls.length = 0;
  await tg.sendFiles(m.message_id, [png, mp4, pdf, { ...pdf, name: 'huge.pdf', size: UPLOAD_MAX + 1 }]);
  assert.deepEqual(calls.map((c) => c.method), ['sendPhoto', 'sendVideo', 'sendDocument', 'sendMessage'], 'one upload per file, in order, then the text line');
  for (const c of calls.slice(0, 3)) { assert.ok(c.type.startsWith('multipart/form-data'), 'multipart upload'); assert.equal(c.body.reply_to_message_id, '501', 'reply_to = the done-message'); assert.equal(c.body.chat_id, '42'); assert.equal(c.body.allow_sending_without_reply, 'true'); }
  assert.deepEqual(calls[0].body.photo.bytes, fs.readFileSync(png.path), 'PNG bytes arrive intact'); assert.equal(calls[0].body.photo.name, 'shot.png'); assert.equal(calls[0].body.caption, 'shot.png');
  assert.equal(calls[1].body.video.bytes.length, 64); assert.equal(calls[2].body.document.name, 'report.pdf');
  assert.equal(calls[3].body.reply_to_message_id, 501); assert.match(calls[3].body.text, /huge\.pdf \(50\.0 MB\): too big for Telegram, open in console/);
  assert.ok(!calls[3].body.parse_mode, 'the text line is plain (agent-made file names)');
  console.log('ok  sendFiles: photo/video/document multipart as replies, oversize as a text line');
}
// a refused photo is resent as a document, a failing file is logged and the next one still goes, nothing throws
{
  calls.length = 0; logs.length = 0; fail = { sendPhoto: true };
  await tg.sendFiles(501, [png, pdf]);
  assert.deepEqual(calls.map((c) => c.method), ['sendPhoto', 'sendDocument', 'sendDocument'], 'photo refused -> same file as document, then the pdf');
  assert.equal(calls[1].body.document.name, 'shot.png'); assert.deepEqual(calls[1].body.document.bytes, fs.readFileSync(png.path));
  calls.length = 0; fail = { sendPhoto: true, sendDocument: true };
  await tg.sendFiles(501, [png, pdf, mp4]);
  assert.deepEqual(calls.map((c) => c.method), ['sendPhoto', 'sendDocument', 'sendDocument', 'sendVideo'], 'each item stands alone: failures do not stop the batch');
  assert.equal(logs.filter((l) => l.startsWith('telegram file failed')).length, 2, 'one log line per failed file'); assert.ok(!logs.join().includes('SECRET'), 'token never logged');
  fail = {}; calls.length = 0;
  await tg.sendFiles(501, [{ ...pdf, path: path.join(dir, 'gone.pdf') }, mp4]);   // deleted between the filter and the upload
  assert.deepEqual(calls.map((c) => c.method), ['sendVideo'], 'a vanished file is skipped, the next one goes'); assert.match(logs.at(-1), /telegram file failed \(report\.pdf\)/);
  console.log('ok  sendFiles: per-item failures, photo -> document fallback, never thrown');
}
// 429: retry_after is honoured once
{
  calls.length = 0; rate = { sendVideo: 1 }; const t0 = Date.now();
  await tg.sendFiles(501, [mp4]);
  assert.deepEqual(calls.map((c) => c.method), ['sendVideo', 'sendVideo'], 'retried once after the 429'); assert.ok(Date.now() - t0 >= 950, 'waited retry_after (1 s)');
  calls.length = 0; rate = { sendVideo: 2 }; logs.length = 0;
  await tg.sendFiles(501, [mp4]);
  assert.equal(calls.length, 2, 'only ONE retry'); assert.match(logs.at(-1), /429/); rate = {};
  console.log('ok  sendFiles: 429 retry_after honoured once');
}
// one shared queue: two turns finishing at once never interleave their uploads
{
  calls.length = 0;
  const other = createTelegram({ cfgFile, apiBase: `http://127.0.0.1:${api.address().port}`, log: (l) => logs.push(l), onNewTask: async () => {}, onList: async () => [], onStatus: async () => ({ seats: [] }), onDecision: async () => 'x', onReply: async () => 'x' });
  await Promise.all([tg.sendFiles(601, [png, pdf]), other.sendFiles(602, [mp4, png])]);
  assert.deepEqual(calls.map((c) => c.body.reply_to_message_id), ['601', '601', '602', '602'], 'the second batch waits for the first');
  console.log('ok  sendFiles: one serial queue');
}
// off / not linked: nothing is sent
{
  fs.writeFileSync(cfgFile, JSON.stringify({ botToken: '123:SECRET' })); calls.length = 0;
  await tg.sendFiles(501, [png]); assert.equal(calls.length, 0, 'no chat linked: no upload');
  console.log('ok  sendFiles: nothing without a linked chat');
}
api.close(); fs.rmSync(dir, { recursive: true, force: true });
console.log('files tests passed');
