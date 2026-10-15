// Run: node console/test-attach.mjs. Telegram attachments against a local fake Bot API (no real bot): a document / voice note sent as a reply to a
// conversation's notification reaches THAT conversation as a file with its bytes and name intact; a photo still arrives as an image; a file over
// Telegram's 20 MB bot limit (by file_size, or getFile's "file is too big") gets one clear reply and is not delivered; a standalone file gets the hint.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createTelegram, TG_FILE_MAX } from './telegram.mjs';

const conv = '0123abcd-0000-4000-8000-000000000000', NOTIF = 100;
const blobs = { 'documents/file_1.pdf': Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(5000)]), 'voice/file_3.oga': crypto.randomBytes(3000), 'photos/file_2.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) };
const ids = { d1: 'documents/file_1.pdf', v1: 'voice/file_3.oga', p1: 'photos/file_2.jpg' };
let updates = []; const sent = [];
const api = http.createServer((req, res) => {
  const fm = /^\/file\/bot[^/]+\/(.+)$/.exec(req.url);
  if (fm) { const b = blobs[fm[1]]; res.writeHead(b ? 200 : 404); return res.end(b); }
  let raw = ''; req.on('data', (x) => (raw += x)); req.on('end', () => {
    const method = req.url.split('/').pop(), body = raw ? JSON.parse(raw) : {};
    let result = true;
    if (method === 'getUpdates') { result = updates; updates = []; if (!result.length) return void setTimeout(() => res.end(JSON.stringify({ ok: true, result: [] })), 100); }
    if (method === 'getFile') { if (body.file_id === 'huge') return res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: file is too big' })); result = { file_path: ids[body.file_id] }; }
    if (method === 'sendMessage') { sent.push(body.text); result = { message_id: 1000 + sent.length }; }
    res.end(JSON.stringify({ ok: true, result }));
  });
}).listen(0);
await new Promise((r) => api.once('listening', r));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgattach-')), cfgFile = path.join(dir, 'tg.json');
fs.writeFileSync(cfgFile, JSON.stringify({ botToken: '123456:SECRETSECRETSECRETSECRETSECRETSEC', chatId: '555' }));
const replies = [];
const tg = createTelegram({ cfgFile, apiBase: `http://127.0.0.1:${api.address().port}`, seats: ['ops'], phoneBase: 'http://x', log: () => {}, idleMs: 50, msgMap: { [NOTIF]: conv },
  onNewTask: async () => {}, onList: async () => [], onStatus: async () => ({ seats: [] }), findConv: () => null, onDecision: async () => 'ok',
  onReply: Object.assign(async (c, p) => { replies.push([c, p]); return 'SENT'; }, { acceptsImages: true }) });
const wait = async (f, ms = 5000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 30)); } };
const msg = (uid, m) => ({ update_id: uid, message: { message_id: uid, chat: { id: 555, type: 'private' }, ...m } });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
tg.start();

// 1. a document as a reply: delivered to that conversation as a file, same bytes, Telegram's file name (spaces kept), the caption as text
updates = [msg(1, { document: { file_id: 'd1', file_name: 'annual report.pdf', file_size: blobs[ids.d1].length }, caption: 'read this', reply_to_message: { message_id: NOTIF } })];
await wait(() => replies.length === 1);
{ const [c, p] = replies[0]; assert.equal(c, conv); assert.equal(p.text, 'read this'); assert.equal(p.images.length, 0); assert.equal(p.files.length, 1);
  assert.equal(p.files[0].name, 'annual report.pdf'); assert.equal(sha(p.files[0].data), sha(blobs[ids.d1])); }
console.log('ok  document reply -> that conversation, bytes + name intact');

// 2. a voice note (no file_name): named after Telegram's file path, default text for a file without caption
updates = [msg(2, { voice: { file_id: 'v1', file_size: 3000 }, reply_to_message: { message_id: NOTIF } })];
await wait(() => replies.length === 2);
assert.equal(replies[1][1].files[0].name, 'file_3.oga'); assert.equal(replies[1][1].text, 'See the attached file.'); assert.equal(sha(replies[1][1].files[0].data), sha(blobs[ids.v1]));
console.log('ok  voice reply -> file named from the file path');

// 3. a photo still takes the image path
updates = [msg(3, { photo: [{ file_id: 'p1' }], reply_to_message: { message_id: NOTIF } })];
await wait(() => replies.length === 3);
assert.equal(replies[2][1].images.length, 1); assert.equal(replies[2][1].files.length, 0); assert.equal(replies[2][1].text, 'See the attached image.');
console.log('ok  photo reply -> image');

// 4. over the bot limit: by file_size (no download tried) and by getFile's own error -> the same clear reply, nothing delivered
const tooBig = (t) => t.startsWith('📎 <b>File too big for the bot</b>');
updates = [msg(4, { document: { file_id: 'd1', file_name: 'big.zip', file_size: TG_FILE_MAX + 1 }, reply_to_message: { message_id: NOTIF } }),
  msg(5, { video: { file_id: 'huge', file_name: 'clip.mp4' }, reply_to_message: { message_id: NOTIF } })];
await wait(() => sent.filter(tooBig).length === 2);
assert.equal(replies.length, 3);
console.log('ok  over 20 MB -> "too big" reply x2, not delivered');

// 5. a file that is not a reply: the hint, no delivery
updates = [msg(6, { document: { file_id: 'd1', file_name: 'x.pdf', file_size: 10 } })];
await wait(() => sent.some((t) => t.startsWith('📎 Photos and files: reply to the notification')));
assert.equal(replies.length, 3);
console.log('ok  standalone file -> reply hint');

tg.stop(); api.close(); fs.rmSync(dir, { recursive: true, force: true });
console.log('attach tests passed'); process.exit(0);
