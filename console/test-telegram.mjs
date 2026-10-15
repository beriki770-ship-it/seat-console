// Run: node console/test-telegram.mjs. Unit tests (message builder, throttle, callback parsing) plus the whole
// Telegram flow against a local fake Bot API: chat linking, notify, Allow/Deny callback, reply routing.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { escClip, buildMessage, Throttle, parseCallback, callbackData, extractSummary, createTelegram, PERM_MAX, isStatusRequest, buildDigest, buildRecover, bar, permTooLong, clock, resetTag, seatMark, quotaWarnDue, buildQuotaWarning } from './telegram.mjs';
import { markInterrupted } from './recovery.mjs';
import { createRoutines } from './routines.mjs';

const id = '0123abcd-0000-4000-8000-000000000000';
const BASE = 'http://100.64.0.1:4850';
// tag-balance checker: only Telegram's tags, balanced, no nested blockquote, no raw < > & in text, under 4096 chars
const TAGS = new Set(['b', 'i', 'u', 's', 'code', 'pre', 'a', 'blockquote', 'tg-spoiler']);
function checkHtml(h) {
  assert.ok(h.length <= 4096, 'message over 4096: ' + h.length);
  const stack = [], re = /<(\/?)([a-z-]+)([^<>]*)>/g; let last = 0, m;
  const text = (t) => assert.ok(!/[<>]|&(?!(amp|lt|gt|quot);)/.test(t), 'raw special char in: ' + t);
  while ((m = re.exec(h))) {
    text(h.slice(last, m.index)); last = re.lastIndex;
    assert.ok(TAGS.has(m[2]), 'unknown tag ' + m[2]);
    if (m[1]) assert.equal(stack.pop(), m[2], 'unbalanced </' + m[2] + '> in ' + h);
    else { if (m[2] === 'blockquote') assert.ok(!stack.includes('blockquote'), 'nested blockquote'); stack.push(m[2]); }
  }
  text(h.slice(last)); assert.deepEqual(stack, [], 'unclosed ' + stack + ' in ' + h);
  return h;
}
const ok = checkHtml;
// builder
const m0 = ok(buildMessage('done', { seat: 'ops', title: 'T', text: 'x'.repeat(500), convId: id }, BASE));
assert.ok(m0.startsWith('✅ <b>ops</b> · <i>T</i>\n<blockquote>' + 'x'.repeat(299) + '…</blockquote>\n<blockquote expandable>') && m0.includes(`<a href="${BASE}/#0123abcd-`) && m0.includes('Open in console ↗'));
const m = ok(buildMessage('done', { seat: 'ops', title: 'T', text: 'long body\nסיכום: עשיתי. עובד.', convId: id, files: ['a.js', 'b.js'], usage: 0.31 }, BASE));
assert.ok(m.includes('<blockquote>עשיתי. עובד.</blockquote>') && !m.includes('סיכום:</blockquote>') && m.includes('<blockquote expandable>long body') && m.includes('📄 <code>a.js</code> <code>b.js</code>') && m.includes("🟢 ▰▰▰▱▱▱▱▱▱▱ 31% · 5 h"));
// a turn that ends with a question to the user: the needs-answer line sits right under the summary (done only, never on an error)
const qa = ok(buildMessage('done', { seat: 'ops', title: 'T', text: 'x?\nסיכום: שאלה.', convId: id, needsAnswer: true }, BASE));
assert.ok(qa.includes('<blockquote>שאלה.</blockquote>\n❓ <b>Waiting for your answer</b>') && !m.includes('❓') && !ok(buildMessage('error', { seat: 'ops', title: 'T', text: 'b', convId: id, needsAnswer: true }, BASE)).includes('❓'));
// escaping: tags and & coming from agents arrive as text, never as markup
const evil = ok(buildMessage('done', { seat: 'ops', title: 'a <b>&', text: 'x </blockquote><b>y&z\nסיכום: <i>&', convId: id, files: ['<f>&.js'] }, BASE));
assert.ok(evil.includes('<i>a &lt;b&gt;&amp;</i>') && evil.includes('<blockquote>&lt;i&gt;&amp;</blockquote>') && evil.includes('<code>&lt;f&gt;&amp;.js</code>') && !evil.includes('<b>y'));
const e1 = ok(buildMessage('error', { seat: 'ops', title: 'T', text: 'boom', convId: id }, BASE));
assert.ok(e1.startsWith('❌ <b>ops</b> · <i>T</i>\n<code>boom</code>'));
const p1 = ok(buildMessage('perm', { seat: 'ops', title: 'T', tool: 'Bash', input: { command: 'del x' }, convId: id }, BASE));
assert.ok(p1.startsWith('⏳ <b>ops</b> · <i>T</i>\n\nAsks for approval: <b>Bash</b>\n<pre>del x</pre>') && p1.includes('Open in console'));
assert.ok(ok(buildMessage('perm', { seat: 'ops', title: 'T', tool: 'B<ash>', input: { command: 'echo "<a>" && x' }, convId: id }, BASE)).includes('<pre>echo "&lt;a&gt;" &amp;&amp; x</pre>'));
assert.equal(extractSummary('a\nb'), null);
assert.equal(buildMessage('done', { seat: 's', title: 't', text: 'f', convId: id, files: 'abcdefg'.split('') }, BASE).includes('+2'), true);
assert.equal(bar(0.18), '🟢 ▰▰▱▱▱▱▱▱▱▱ 18%'); assert.ok(bar(0.5).startsWith('🟡') && bar(0.81).startsWith('🔴') && bar(1).includes('▰'.repeat(10)));
// reset time: local clock, a past reset reads "reset", usage in the message/digest carries it; no resetsAt = no tag (old callers)
const T0 = new Date(2026, 9, 13, 14, 0, 0).getTime();
assert.equal(clock(new Date(2026, 9, 13, 19, 40).getTime()), '19:40'); assert.equal(clock(new Date(2026, 9, 13, 7, 5).getTime()), '07:05');
assert.equal(resetTag(new Date(2026, 9, 13, 19, 40).getTime(), T0), '🔁 resets 19:40'); assert.equal(resetTag(T0 - 1, T0), '🔁 reset'); assert.equal(resetTag(T0, T0), '🔁 reset'); assert.equal(resetTag(null, T0), '');
const mr = ok(buildMessage('done', { seat: 'ops', title: 'T', text: 'x', convId: id, usage: 0.31, resetsAt: Date.now() + 3600000 }, BASE));
assert.ok(mr.includes("31% · 5 h · 🔁 resets " + clock(Date.now() + 3600000)), mr);
assert.ok(ok(buildMessage('done', { seat: 'ops', title: 'T', text: 'x', convId: id, usage: 0, resetsAt: Date.now() - 1000 }, BASE)).includes("0% · 5 h · 🔁 reset"));
assert.ok(!buildMessage('done', { seat: 'ops', title: 'T', text: 'x', convId: id, usage: 0.31 }, BASE).includes('🔁'));
assert.ok(ok(buildDigest({ seats: [{ name: 'ops', usage: 0.31, resetsAt: new Date(2026, 9, 13, 19, 40).getTime(), convs: [{ id, title: 't', status: 'idle', updatedAt: T0 - 60000, result: '' }] }] }, T0, BASE).text).includes('<b>⚙️ ops</b>  🟢 ▰▰▰▱▱▱▱▱▱▱ 31% · 🔁 resets 19:40\n'));
assert.ok(buildDigest({ seats: [{ name: 'ops', usage: 0, resetsAt: T0 - 1, convs: [{ id, title: 't', status: 'idle', updatedAt: T0 - 60000, result: '' }] }] }, T0, BASE).text.includes('0% · 🔁 reset\n'));
// picker markers: none below 50 %, 🟡 50-80, 🔴 from 80
assert.deepEqual([null, 0.49, 0.5, 0.79, 0.8, 1].map(seatMark), ['', '', '🟡', '🟡', '🔴', '🔴']);
// one 90 % warning per seat per window: below 90 never, first time yes, same window (even a few seconds apart) no, a new window yes again, other seats independent
const wn = {};
assert.ok(!quotaWarnDue(wn, 'ops', 0.89, 1000) && quotaWarnDue(wn, 'ops', 0.9, 1000) && !quotaWarnDue(wn, 'ops', 0.95, 1000) && !quotaWarnDue(wn, 'ops', 0.97, 1005));
assert.ok(quotaWarnDue(wn, 'ops', 0.91, 1000 + 5 * 3600) && quotaWarnDue(wn, 'dev', 0.92, 1000) && !quotaWarnDue(wn, 'constructor', NaN, 1));
const qw = ok(buildQuotaWarning({ seat: 'ops', util: 0.92, resetsAt: new Date(2026, 9, 13, 19, 40).getTime(), alt: { name: 'info', util: 0.12 } }, T0));
assert.equal(qw, '🔴 <b>ops</b> at 92% of the 5-hour quota\n🔁 resets 19:40\nMore room: <b>info</b> (12%)');
assert.ok(!ok(buildQuotaWarning({ seat: 'ops', util: 0.9, resetsAt: T0 + 1000, alt: null }, T0)).includes('More room'));
// a 200-char command shows in full; one over PERM_MAX is not shown in full and sends the reader to the console
const cmd200 = 'c'.repeat(200);
assert.ok(ok(buildMessage('perm', { seat: 'ops', title: 'T', tool: 'Bash', input: { command: cmd200 }, convId: id }, BASE)).includes(cmd200));
const longMsg = ok(buildMessage('perm', { seat: 'ops', title: 'T', tool: 'Bash', input: { command: 'z'.repeat(5000) }, convId: id }, BASE));
assert.ok(/no buttons/.test(longMsg) && longMsg.length < 1000 && longMsg.includes(`/#${id}`));
assert.ok(permTooLong({ command: '&'.repeat(1000) }) && !permTooLong({ command: 'a'.repeat(1000) }));   // the cap counts the ESCAPED text
assert.ok(ok(buildMessage('perm', { seat: 'ops', title: 'T', tool: 'Write', input: { file_path: 'a', content: 'x'.repeat(300) }, convId: id }, BASE)).includes('"content": "' + 'x'.repeat(300)));
const th = new Throttle(60000);
assert.ok(th.allow('c', 0) && !th.allow('c', 59999) && th.allow('c', 60000) && th.allow('other', 1));
// callbacks
const cd = callbackData(id, 'req-123', true);
assert.equal(cd, 'p:0123abcd:req-123:1'); assert.ok(Buffer.byteLength(cd) <= 64);
assert.deepEqual(parseCallback(cd), { convShort: '0123abcd', requestId: 'req-123', allow: true });
assert.deepEqual(parseCallback('p:0123abcd:a:b:c:0'), { convShort: '0123abcd', requestId: 'a:b:c', allow: false });
assert.equal(parseCallback('x:1'), null);

// status phrase matcher: exact short phrases only
for (const t of ['מה חדש', ' מה חדש ', 'סטטוס', 'STATUS', "What's new", 'update', '/status', 'מה קורה', 'מה המצב', 'עדכון', 'מה נעשה']) assert.ok(isStatusRequest(t), t);
for (const t of ['תבנה לי אתר', 'hello', 'מה חדש באתר של הלקוח הגדול הזה', 'update the readme', '']) assert.ok(!isStatusRequest(t), t);
// digest builder
const NOW = 1_000_000_000_000, MIN = 60000;
assert.ok(ok(buildDigest({ seats: [{ name: 'ops', usage: null, convs: [{ id, title: 'old', status: 'idle', updatedAt: NOW - 25 * 3600000, result: '' }] }] }, NOW, BASE).text).includes('😴 No activity in the last 24 hours.'));
const dg = buildDigest({ seats: [
  { name: 'studio', usage: 0.234, convs: [{ id: 'a1', title: 'T'.repeat(60), status: 'working', updatedAt: NOW - 12 * MIN, result: 'x\nסיכום: עשיתי. עובד.' }, { id: 'a2', title: 'asks <b>&', status: 'waiting', updatedAt: NOW - 2 * 3600000, result: '' }] },
  { name: 'dev', usage: 0.18, convs: [{ id: 'b1', title: 'done one', status: 'idle', updatedAt: NOW - 5 * MIN, result: 'plain text only' }, { id: 'b2', title: 'broke', status: 'error', updatedAt: NOW - 30 * MIN, result: '' }, { id: 'b3', title: 'cut', status: 'interrupted', updatedAt: NOW - 40 * MIN, result: '' }] },
  { name: 'ops', usage: 0.5, convs: [] }, { name: 'info', usage: null, convs: [] }] }, NOW, BASE);
ok(dg.text);
assert.ok(dg.text.startsWith("<b>📊 Status</b> · <i>last 24 hours</i>\n\n<b>🧑‍💻 dev</b>  🟢 ▰▰▱▱▱▱▱▱▱▱ 18%\n✅ <b>done one</b> · <i>5 min ago</i>\n❌ <b>broke</b> · <i>30 min ago</i>\n⏸ <b>cut</b>"), dg.text);   // newest first; no quote when there is no summary
assert.ok(dg.text.includes("<b>🎨 studio</b>  🟢 ▰▰▱▱▱▱▱▱▱▱ 23%\n⚙️ <b>" + 'T'.repeat(39) + "…</b> · <i>12 min ago</i>\n<blockquote>עשיתי. עובד.</blockquote>\n⏳ <b>asks &lt;b&gt;&amp;</b> · <i>2 h ago</i>"), dg.text);
assert.ok(dg.text.includes('⏳ Waiting for approval: <b>1</b>') && dg.text.endsWith('😴 Quiet: ops, info'));
assert.equal(dg.rows.length, 5); assert.equal(dg.rows[0][0].text, '✅ done one'); assert.equal(dg.rows[0][0].url, `${BASE}/#b1`);
const many = buildDigest({ seats: [{ name: 'ops', usage: null, convs: Array.from({ length: 11 }, (_, i) => ({ id: 'c' + i, title: 'c' + i, status: 'idle', updatedAt: NOW - i * MIN, result: '' })) }] }, NOW, BASE);
ok(many.text); assert.equal(many.rows.length, 8); assert.ok(many.text.includes('<i>+3 more</i>') && many.text.includes('c0') && !many.text.includes('c8'));
// worst case: 8 conversations with max-length titles and summaries stays under the 4096 limit
ok(buildDigest({ seats: [{ name: 'dev', usage: 0.9, convs: Array.from({ length: 8 }, (_, i) => ({ id: 'w' + i, title: '&'.repeat(80), status: 'idle', updatedAt: NOW - i * MIN, result: 'סיכום: ' + '<&>'.repeat(100) })) }] }, NOW, BASE).text);

// crash bookkeeping: startup marking + crash detection
const mk = (flag) => ({ ...(flag === undefined ? {} : { cleanShutdown: flag }), conversations: { a: { id: 'a', working: true }, b: { id: 'b', working: false }, c: { id: 'c', working: true, interrupted: false } } });
for (const [flag, crash] of [[undefined, true], [false, true], [true, false]]) {   // no flag (old state file) and false = the last run died hard; true = it exited normally
  const s = mk(flag); assert.equal(markInterrupted(s), crash, 'crash detection for ' + flag);
  assert.equal(s.cleanShutdown, false);   // false again while this run is alive
  assert.deepEqual(Object.values(s.conversations).map((c) => [c.working, !!c.interrupted]), [[false, true], [false, false], [false, true]]);   // working ones become interrupted, an idle one stays untouched
}
const s2 = mk(false); markInterrupted(s2); assert.equal(markInterrupted(s2), true); assert.equal(s2.conversations.a.interrupted, true);   // a second crash before anyone resumed: still interrupted
// recover message builder
const RL = [{ id: 'aaaa1111-0', seat: 'ops', title: 'count <slowly> & wait', updatedAt: NOW - 7 * MIN }, { id: 'bbbb2222-0', seat: 'dev', title: 'T'.repeat(60), updatedAt: NOW - 3 * 3600000 }];
const rc = buildRecover(RL, NOW, true); ok(rc.text);
assert.ok(rc.text.startsWith('🔄 <b>The PC crashed or restarted</b> — 2 conversations were cut off\n\n⚙️ <b>ops</b> · <i>count &lt;slowly&gt; &amp; wait</i> · 7 min ago\n🧑‍💻 <b>dev</b>'), rc.text);
assert.deepEqual(rc.rows.map((r) => r[0].callback_data), ['r:all', 'r:aaaa1111', 'r:bbbb2222', 'r:no']);
assert.deepEqual(rc.rows.map((r) => r[0].text).filter((t) => t.startsWith('▶️ ops') || t.startsWith('▶️ dev')).length, 2); assert.equal(rc.rows[0][0].text, '▶️ Continue all'); assert.equal(rc.rows.at(-1)[0].text, '✖️ Not now');
assert.ok(buildRecover(RL, NOW, false).text.startsWith('🔄 <b>Interrupted conversations</b> — 2'));
assert.deepEqual(buildRecover([], NOW, true), { text: '✅ No interrupted conversations.', rows: null });

// ---- fake Bot API ----
const calls = []; let updates = []; let nextMsg = 100; let rejectHtml = false;
const api = http.createServer((req, res) => {
  let b = ''; req.on('data', (x) => b += x); req.on('end', () => {
    const method = req.url.split('/').pop(); const body = b ? JSON.parse(b) : {};
    calls.push({ method, body });
    let result = true;
    if (method === 'getUpdates') { result = updates; updates = []; if (!result.length) { setTimeout(() => res.end(JSON.stringify({ ok: true, result: [] })), 200); return; } }
    if (rejectHtml && body.parse_mode) { res.end(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: can't parse entities: Unsupported start tag at byte offset 5" })); return; }
    if (method === 'sendMessage') result = { message_id: ++nextMsg };
    res.end(JSON.stringify({ ok: true, result }));
  });
}).listen(0);
await new Promise((r) => api.once('listening', r));
const apiBase = `http://127.0.0.1:${api.address().port}`;
const cfgFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tgtest-')), 'tg.json');
const readCfg = () => JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^﻿/, ''));
const logs = [];
const decisions = [], replies = [], compacts = [];
const msgMap = {};
const tasks = []; let usageMap = {};
const rec = { sent: [], list: [{ id: 'aaaa1111-0', seat: 'ops', title: 'one', updatedAt: Date.now() - 5 * MIN }, { id: 'bbbb2222-0', seat: 'dev', title: 'two', updatedAt: Date.now() - 9 * MIN }, { id: 'cccc3333-0', seat: 'ops', title: 'three', updatedAt: Date.now() - 20 * MIN }] };
const linkCodeFile = path.join(path.dirname(cfgFile), 'link-code.txt');
let routines;   // built below, once tg exists; the bot only calls it when a button is tapped
const tg = createTelegram({ cfgFile, apiBase, onRoutineTap: (d) => routines.tap(d), onRoutineList: () => routines.listMessage(), linkCodeFile, seats: ['studio', 'dev', 'render', 'info', 'ops'], phoneBase: BASE,
  onRecoverList: async () => rec.list.filter((c) => !c.done), onRecover: async (w) => { const out = { resumed: [], failed: [] }; for (const c of rec.list.filter((x) => !x.done && (w === 'all' || x.id.startsWith(w)))) { if (c.fail) out.failed.push({ ...c, error: 'Seat is full' }); else { c.done = true; rec.sent.push(c.id); out.resumed.push(c); } } return out; },
  onNewTask: async (t) => { tasks.push(t); }, onCompact: async (c, i) => { compacts.push([c, i]); }, onList: async () => [{ id, seat: 'ops', title: 'T', status: 'idle' }], onUsage: async () => usageMap, onDigest: async (kind) => ({ text: kind === 'evening' ? '🌆 <b>evening</b>' : '☀️ <b>digest</b>', rows: [[{ text: '↗ x', url: BASE }]] }), onStatus: async () => ({ seats: [{ name: 'ops', usage: 0.07, convs: [{ id, title: 'T', status: 'idle', updatedAt: Date.now() - 3 * MIN, result: 'סיכום: הכל טוב.' }] }] }), findConv: (sh) => (id.startsWith(sh) ? { id, seat: 'ops', title: 'T' } : null), log: (l) => logs.push(l), idleMs: 50, msgMap,
  onDecision: async (c, r, a) => { decisions.push([c, r, a]); return a ? 'Allowed' : 'Denied'; },
  onReply: Object.assign(async (conv, p) => { replies.push([conv, p.text]); return '↪️ Sent to <b>ops</b> · <i>T</i>'; }, { acceptsImages: false }) });
const wait = async (f, ms = 4000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 30)); } };

// placeholder token: stays off, says so once, sends nothing
fs.writeFileSync(cfgFile, JSON.stringify({ botToken: 'PASTE-THE-TOKEN-FROM-BOTFATHER-HERE', chatId: '' }));
tg.start(); await new Promise((r) => setTimeout(r, 200));
await tg.notify('done', { seat: 's', title: 't', text: 'x', convId: id }, BASE);
assert.deepEqual(logs.filter((l) => l === 'telegram: not configured'), ['telegram: not configured']); assert.equal(calls.length, 0);

// real-looking token (with a BOM, like the file the user saved), no chat yet: a link code is made; a bare /start, other text and a wrong code do NOT link
fs.writeFileSync(cfgFile, '﻿' + JSON.stringify({ botToken: '123456:SECRETSECRETSECRETSECRETSECRETSEC', chatId: '' }));
await wait(() => fs.existsSync(linkCodeFile));
const code = fs.readFileSync(linkCodeFile, 'utf8');
assert.match(code, /^[0-9a-f]{8}$/); assert.ok(logs.includes(`telegram: send /start ${code} to link`));
const wrong = code[0] === '0' ? '1' + code.slice(1) : '0' + code.slice(1);
updates = [{ update_id: 90, message: { message_id: 1, chat: { id: 666, type: 'private' }, text: '/start' } },
  { update_id: 91, message: { message_id: 2, chat: { id: 666, type: 'private' }, text: 'hello' } },
  { update_id: 92, message: { message_id: 3, chat: { id: 666, type: 'private' }, text: '/start ' + wrong } }];
await wait(() => updates.length === 0); await new Promise((r) => setTimeout(r, 400));
assert.equal(readCfg().chatId, ''); assert.ok(!logs.includes('telegram chat linked'));
// the right code (phones may uppercase it) links, and the code file is removed
updates = [{ update_id: 1, message: { message_id: 4, chat: { id: 555, type: 'private' }, text: '/START ' + code.toUpperCase() } }];
await wait(() => readCfg().chatId === '555');
assert.ok(!fs.existsSync(linkCodeFile));
assert.equal(readCfg().botToken, '123456:SECRETSECRETSECRETSECRETSECRETSEC');
assert.ok(logs.includes('telegram chat linked'));
assert.ok(!logs.join('\n').includes('SECRET'));

// notify with buttons, message id remembered
await tg.notify('perm', { seat: 'ops', title: 'T', tool: 'Write', input: { file_path: 'C:\\x\\y.txt' }, convId: id }, BASE, tg.permButtons(id, 'rq1'));
const sent = calls.filter((c) => c.method === 'sendMessage' && c.body.text.startsWith('⏳')).at(-1).body;
assert.equal(sent.parse_mode, 'HTML'); ok(sent.text);
assert.equal(sent.chat_id, '555'); assert.deepEqual(sent.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['p:0123abcd:rq1:1', 'p:0123abcd:rq1:0']);
assert.equal(msgMap[nextMsg], id);
const notifId = nextMsg;

// an over-long approval is sent without buttons; a short one keeps them
await tg.notify('perm', { seat: 'ops', title: 'T', tool: 'Bash', input: { command: 'z'.repeat(PERM_MAX + 1) }, convId: id }, BASE, tg.permButtons(id, 'rq9'));
assert.equal(calls.filter((c) => c.method === 'sendMessage' && c.body.text.startsWith('⏳')).at(-1).body.reply_markup, undefined);

// Allow callback from the linked chat is applied and the message edited; from a stranger is not
updates = [{ update_id: 2, callback_query: { id: 'cb1', data: 'p:0123abcd:rq1:1', message: { message_id: nextMsg, chat: { id: 555 }, text: 'orig' } } },
  { update_id: 3, callback_query: { id: 'cb2', data: 'p:0123abcd:rq1:0', message: { message_id: 7, chat: { id: 999 }, text: 'orig' } } }];
await wait(() => calls.some((c) => c.method === 'editMessageReplyMarkup'));
assert.deepEqual(decisions, [['0123abcd', 'rq1', true]]);
assert.deepEqual(calls.find((c) => c.method === 'editMessageReplyMarkup').body.reply_markup, { inline_keyboard: [] });
const okMsg = calls.filter((c) => c.method === 'sendMessage').at(-1).body; assert.equal(okMsg.text, '✅ <b>Allowed</b>'); assert.equal(okMsg.parse_mode, 'HTML');

// reply routing: a reply to a notification reaches that conversation; a plain message gets a hint
updates = [{ update_id: 4, message: { message_id: 20, chat: { id: 555, type: 'private' }, text: 'do more', reply_to_message: { message_id: notifId } } },
  { update_id: 5, message: { message_id: 21, chat: { id: 555, type: 'private' }, text: 'hello' } },
  { update_id: 6, message: { message_id: 22, chat: { id: 555, type: 'private' }, photo: [{ file_id: 'f' }], reply_to_message: { message_id: notifId } } }];
try { await wait(() => calls.some((c) => c.method === "sendMessage" && c.body.text.startsWith("📷"))); } catch (e) { console.log(JSON.stringify(calls.filter((c) => c.method !== "getUpdates").map((c) => [c.method, c.body.text]).filter((c) => c[0] !== "getUpdates").slice(-8))); throw e; }
assert.deepEqual(replies, [[id, 'do more']]);
const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.text);
assert.ok(texts.includes('↪️ Sent to <b>ops</b> · <i>T</i>') && texts.some((t) => /Which seat\?$/.test(t)) && texts.includes('📷 Photos can only be sent through the console.'));
texts.forEach(ok);

// context meter: the finished-message shows the share, the Compact button only comes from the caller, the digest line carries it, a reply "/compact <what to keep>" and the k: button reach onCompact (never onReply)
assert.ok(buildMessage('done', { seat: 'ops', title: 'T', text: 'x', convId: id, ctxPct: 60 }, BASE).includes('🧠 60%'));
assert.ok(!buildMessage('done', { seat: 'ops', title: 'T', text: 'x', convId: id }, BASE).includes('🧠'));
assert.deepEqual(tg.compactButton('0123abcd-ffff'), [{ text: '🗜️ Compact', callback_data: 'k:0123abcd' }]);
assert.ok(buildDigest({ seats: [{ name: 'ops', usage: null, convs: [{ id, title: 'T', status: 'idle', updatedAt: NOW - MIN, ctxPct: 60, result: '' }] }] }, NOW, BASE).text.includes('🧠 60%'));
updates = [{ update_id: 40, message: { message_id: 30, chat: { id: 555, type: 'private' }, text: '/compact keep the plan', reply_to_message: { message_id: notifId } } },
  { update_id: 41, message: { message_id: 31, chat: { id: 555, type: 'private' }, text: '/compact', reply_to_message: { message_id: notifId } } }];
await wait(() => compacts.length === 2);
assert.deepEqual(compacts, [[id, 'keep the plan'], [id, undefined]]); assert.equal(replies.length, 1, '/compact is not delivered as chat text');
await wait(() => calls.filter((c) => c.method === 'sendMessage' && c.body.text === '🗜️ Compacting the context…').length === 2);
updates = [{ update_id: 42, callback_query: { id: 'ck', data: 'k:0123abcd', message: { message_id: 32, chat: { id: 555 }, text: 'orig' } } }];
await wait(() => compacts.length === 3); assert.deepEqual(compacts[2], ['0123abcd', undefined]);
await wait(() => calls.some((c) => c.method === 'answerCallbackQuery' && c.body.text === 'compacting…'));

// a reply to a desktop-app notification (🖥️, not in msgMap): one explanation, no picker, no task, no chat delivery
const nTasks = tasks.length, nReplies = replies.length, nPick = calls.filter((c) => c.method === 'sendMessage' && /Which seat\?$/.test(c.body.text)).length;
updates = [{ update_id: 50, message: { message_id: 40, chat: { id: 555, type: 'private' }, text: 'continue please', reply_to_message: { message_id: 9999, text: '🖥️ app · session done' } } }];
await wait(() => calls.some((c) => c.method === 'sendMessage' && c.body.text.startsWith('🖥️ This is a Claude desktop app session')));
assert.equal(calls.filter((c) => c.method === 'sendMessage').at(-1).body.text, '🖥️ This is a Claude desktop app session — the bot cannot continue it. Open it in the Claude app instead.');
assert.equal(tasks.length, nTasks); assert.equal(replies.length, nReplies); assert.equal(calls.filter((c) => c.method === 'sendMessage' && /Which seat\?$/.test(c.body.text)).length, nPick);



// plain message -> seat -> model -> mode keyboards -> task started with the right seat/model/mode
const cbk = (uid, data, mid) => ({ update_id: uid, callback_query: { id: 'c' + uid, data, message: { message_id: mid, chat: { id: 555 }, text: 'x' } } });
const seatMsg = calls.filter((c) => c.method === 'sendMessage' && /Which seat\?$/.test(c.body.text)).at(-1);
assert.deepEqual(seatMsg.body.reply_markup.inline_keyboard.map((r) => r[0].text), ['🎨 studio', '🧑‍💻 dev', '🎬 render', '💼 info', '⚙️ ops']);
const pid = seatMsg.body.reply_markup.inline_keyboard[0][0].callback_data.split(':')[1];
updates = [cbk(10, `s:${pid}:render`, 50)];
await wait(() => calls.some((c) => c.method === 'editMessageText' && /<b>render<\/b> · which model\?/.test(c.body.text)));
const modelKb = calls.filter((c) => c.method === 'editMessageText').at(-1).body.reply_markup.inline_keyboard.map((r) => r[0].text);
assert.deepEqual(modelKb, ['Opus 5.5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 5.5', 'Default']);
updates = [cbk(11, `m:${pid}:3`, 50)];
await wait(() => calls.some((c) => c.method === 'editMessageText' && /which mode\?/.test(c.body.text)));
const modeKb = calls.filter((c) => c.method === 'editMessageText').at(-1).body.reply_markup.inline_keyboard[0].map((b) => b.text);
assert.deepEqual(modeKb, ['auto', 'ask']);   // no bypass
updates = [cbk(12, `d:${pid}:bypass`, 50)];
await wait(() => calls.some((c) => c.method === 'answerCallbackQuery' && c.body.text === 'unknown mode'));
assert.equal(tasks.length, 0);
updates = [cbk(13, `d:${pid}:ask`, 50)];
await wait(() => tasks.length === 1);
assert.deepEqual(tasks[0], { seat: 'render', model: 'claude-haiku-5-5', mode: 'ask', text: 'hello' });
await wait(() => calls.some((c) => c.method === 'editMessageText' && /🚀 <b>render<\/b> · Haiku 5.5 · ask — started/.test(c.body.text)));
// the picker is single use
updates = [cbk(14, `d:${pid}:auto`, 50)];
await wait(() => calls.some((c) => c.method === 'answerCallbackQuery' && /expired/.test(c.body.text || '')));
// shortcut: /ops <task> goes straight to the seat with default model + auto
updates = [{ update_id: 15, message: { message_id: 30, chat: { id: 555, type: 'private' }, text: '/ops say pong' } }];
await wait(() => tasks.length === 2);
assert.deepEqual(tasks[1], { seat: 'ops', model: null, mode: 'auto', text: 'say pong' });
// /list + continue: the next plain message goes into that conversation
updates = [{ update_id: 16, message: { message_id: 31, chat: { id: 555, type: 'private' }, text: '/list' } }];
await wait(() => calls.some((c) => c.method === 'sendMessage' && /^<b>🗂 Recent conversations<\/b>\n\n1\. ✅ <b>ops<\/b> · <i>T<\/i>/.test(c.body.text)));
const lst = calls.filter((c) => c.method === 'sendMessage' && /^<b>🗂/.test(c.body.text)).at(-1).body.reply_markup.inline_keyboard[0];
assert.deepEqual(lst.map((b) => b.text), ['↪️ Continue 1', '↗ Open 1']); assert.equal(lst[1].url, `${BASE}/#${id}`);
updates = [cbk(17, lst[0].callback_data, 60)];
await wait(() => calls.some((c) => c.method === 'sendMessage' && /^↪️ Your next message goes to <b>ops<\/b> · <i>T<\/i>/.test(c.body.text)));
updates = [{ update_id: 18, message: { message_id: 32, chat: { id: 555, type: 'private' }, text: 'follow up' } }];
await wait(() => replies.length === 2);
assert.deepEqual(replies[1], [id, 'follow up']); assert.equal(tasks.length, 2);
// "מה חדש" and /status -> digest (no picker, no task); a real task text -> picker
const pickersBefore = calls.filter((c) => c.method === 'sendMessage' && /Which seat\?$/.test(c.body.text)).length;
updates = [{ update_id: 20, message: { message_id: 33, chat: { id: 555, type: 'private' }, text: 'מה חדש' } }, { update_id: 21, message: { message_id: 34, chat: { id: 555, type: 'private' }, text: '/status' } }];
await wait(() => calls.filter((c) => c.method === 'sendMessage' && c.body.text.includes('<b>⚙️ ops</b>')).length === 2);
const dgSent = calls.filter((c) => c.method === 'sendMessage' && c.body.text.includes('<b>⚙️ ops</b>')).at(-1).body;
assert.ok(ok(dgSent.text).includes("✅ <b>T</b> · <i>3 min ago</i>\n<blockquote>הכל טוב.</blockquote>")); assert.equal(dgSent.reply_markup.inline_keyboard[0][0].url, `${BASE}/#${id}`);
assert.equal(calls.filter((c) => c.method === 'sendMessage' && /Which seat\?$/.test(c.body.text)).length, pickersBefore); assert.equal(tasks.length, 2);
// /digest -> the morning digest on demand (no picker, no task)
updates = [{ update_id: 219, message: { message_id: 330, chat: { id: 555, type: 'private' }, text: '/digest' } }];
await wait(() => calls.some((c) => c.method === 'sendMessage' && c.body.text === '☀️ <b>digest</b>' && c.body.reply_markup?.inline_keyboard[0][0].url === BASE)); assert.equal(tasks.length, 2);
// /evening and "/digest evening" -> the evening digest on demand
updates = [{ update_id: 220, message: { message_id: 331, chat: { id: 555, type: 'private' }, text: '/evening' } }, { update_id: 221, message: { message_id: 332, chat: { id: 555, type: 'private' }, text: '/digest evening' } }];
await wait(() => calls.filter((c) => c.method === 'sendMessage' && c.body.text === '🌆 <b>evening</b>').length === 2); assert.equal(tasks.length, 2);
updates = [{ update_id: 22, message: { message_id: 35, chat: { id: 555, type: 'private' }, text: 'תבנה לי אתר' } }];
await wait(() => calls.filter((c) => c.method === 'sendMessage' && /Which seat\?$/.test(c.body.text)).length === pickersBefore + 1);
// picker with quota markers: the seat buttons carry 🟡/🔴 + percentage from onUsage; seats under 50 % stay plain
usageMap = { studio: 0.3, dev: 0.62, render: 0.85, ops: 0.5 };
updates = [{ update_id: 23, message: { message_id: 36, chat: { id: 555, type: 'private' }, text: 'עוד משימה' } }];
await wait(() => calls.filter((c) => c.method === 'sendMessage' && /Which seat\?$/.test(c.body.text)).length === pickersBefore + 2);
assert.deepEqual(calls.filter((c) => c.method === 'sendMessage' && /Which seat\?$/.test(c.body.text)).at(-1).body.reply_markup.inline_keyboard.map((r) => r[0].text), ['🎨 studio', '🟡 🧑‍💻 dev 62%', '🔴 🎬 render 85%', '💼 info', '🟡 ⚙️ ops 50%']);
usageMap = {};
// crash recovery: the post-crash message, tap on one conversation, tap twice (idempotent), "all", a failing one, "not now", /recover on demand, a stranger
const sm = () => calls.filter((c) => c.method === 'sendMessage');
const offered = await tg.offerRecover(true);
assert.ok(offered && offered.message_id);
const rm = sm().at(-1).body; ok(rm.text); assert.equal(rm.parse_mode, 'HTML'); assert.equal(rm.chat_id, '555');
assert.ok(rm.text.startsWith('🔄 <b>The PC crashed or restarted</b> — 3 conversations were cut off'));
assert.deepEqual(rm.reply_markup.inline_keyboard.map((r) => r[0].callback_data), ['r:all', 'r:aaaa1111', 'r:bbbb2222', 'r:cccc3333', 'r:no']);
const RID = offered.message_id;
updates = [cbk(30, 'r:bbbb2222', RID), cbk(31, 'r:bbbb2222', RID)];   // tapped twice
await wait(() => calls.filter((c) => c.method === 'answerCallbackQuery').length >= 2 && calls.some((c) => c.method === 'answerCallbackQuery' && c.body.text === 'already resumed'));
assert.deepEqual(rec.sent, ['bbbb2222-0']);   // resumed exactly once
const kbEdit = calls.filter((c) => c.method === 'editMessageReplyMarkup' && c.body.message_id === RID).at(0).body.reply_markup.inline_keyboard;
assert.deepEqual(kbEdit.map((r) => r[0].callback_data), ['r:all', 'r:aaaa1111', 'r:cccc3333', 'r:no']);   // the resumed conversation's button is gone
assert.ok(sm().some((c) => /^<b>Resumed 1<\/b>\n▶️ <b>dev<\/b> · <i>two<\/i>$/.test(c.body.text)));
rec.list[2].fail = true;   // "three" cannot start (e.g. its seat is full): reported, stays interrupted, so a later tap retries
updates = [cbk(32, 'r:all', RID)];
await wait(() => rec.sent.length === 2);
assert.deepEqual(rec.sent, ['bbbb2222-0', 'aaaa1111-0']);
await wait(() => sm().some((c) => /⚠️ <b>ops<\/b> · <i>three<\/i> · <code>Seat is full<\/code>/.test(c.body.text)));
assert.ok(!rec.list[2].done);
updates = [cbk(33, 'r:no', RID)];
await wait(() => calls.some((c) => c.method === 'answerCallbackQuery' && c.body.text === 'ok, not now'));
assert.deepEqual(calls.filter((c) => c.method === 'editMessageReplyMarkup').at(-1).body.reply_markup, { inline_keyboard: [] });
assert.equal(rec.sent.length, 2);   // "not now" resumes nothing
// /recover shows the list on demand (one conversation left); nothing interrupted -> a plain line and offerRecover stays silent
updates = [{ update_id: 34, message: { message_id: 50, chat: { id: 555, type: 'private' }, text: '/recover' } }];
await wait(() => sm().some((c) => c.body.text.startsWith('🔄 <b>Interrupted conversations</b> — 1')));
rec.list[2].done = true;
updates = [{ update_id: 35, message: { message_id: 51, chat: { id: 555, type: 'private' }, text: '/recover' } }];
await wait(() => sm().at(-1).body.text === '✅ No interrupted conversations.');
assert.equal(await tg.offerRecover(true), null);
// a stranger's tap does nothing
updates = [{ update_id: 36, callback_query: { id: 'x36', data: 'r:all', message: { message_id: RID, chat: { id: 999 }, text: 'x' } } }];
await new Promise((r) => setTimeout(r, 400)); assert.equal(rec.sent.length, 2);
// routines through the real bot: the ask goes out with buttons and starts NOTHING; the tap starts it; a second tap and an expired ask change nothing; /routines lists with run-now buttons
{
  const rdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgroutines-')), rfile = path.join(rdir, 'r.json'), started = []; let clock = new Date(2026, 9, 13, 19, 59).getTime();
  fs.writeFileSync(rfile, JSON.stringify([{ id: 'nightly', prompt: 'Say hi & <bye>', cron: '0 20 * * *', seat: 'ops', cwd: rdir }]));
  const rstate = {};
  routines = createRoutines({ file: rfile, state: rstate, save() {}, now: () => clock, deps: { ask: (t, r) => tg.send(t, r), edit: (mid, t, r) => tg.edit(mid, t, r), telegramOn: () => true, base: () => BASE,
    start: (x) => { started.push(x); return id; }, seatLoad: () => ({ alive: 0, max: 3, usage: 0.1 }), seatNames: () => ['studio', 'dev', 'render', 'info', 'ops'], log: (l) => logs.push(l) } });
  await routines.tick(); clock = new Date(2026, 9, 13, 20, 0).getTime(); await routines.tick();
  const rq = sm().at(-1).body; ok(rq.text); assert.ok(rq.text.startsWith('⏰ <b>nightly</b> · ⚙️ ops seat · due 20:00\n<blockquote expandable>Say hi &amp; &lt;bye&gt;</blockquote>'));
  assert.deepEqual(rq.reply_markup.inline_keyboard[0].map((b) => b.text), ['▶️ Run', '⏭️ Skip']); assert.equal(started.length, 0);
  const askId = nextMsg, run = rq.reply_markup.inline_keyboard[0][0].callback_data;
  updates = [cbk(60, run, askId), cbk(61, run, askId)];
  await wait(() => calls.filter((c) => c.method === 'answerCallbackQuery' && /^(started|already started)$/.test(c.body.text)).length === 2);
  assert.equal(started.length, 1); assert.equal(started[0].text, 'Say hi & <bye>'); assert.equal(started[0].seat, 'ops');
  const ed = calls.filter((c) => c.method === 'editMessageText' && c.body.message_id === askId).at(-1).body; ok(ed.text); assert.ok(ed.text.includes('▶️ Started on <b>ops</b>') && ed.text.includes(`${BASE}/#${id}`)); assert.equal(ed.reply_markup, undefined);
  // expiry edits the very same message
  clock = new Date(2026, 9, 14, 20, 0).getTime(); await routines.tick(); const ask2 = nextMsg;
  clock += 6 * 3600e3; await routines.tick();
  assert.ok(calls.filter((c) => c.method === 'editMessageText' && c.body.message_id === ask2).at(-1).body.text.endsWith('⌛ Expired'));
  // /routines + the run-now button
  updates = [{ update_id: 62, message: { message_id: 70, chat: { id: 555, type: 'private' }, text: '/routines' } }];
  await wait(() => sm().some((c) => c.body.text.startsWith('<b>⏰ Routines</b>')));
  const rl = sm().filter((c) => c.body.text.startsWith('<b>⏰ Routines</b>')).at(-1).body; ok(rl.text); assert.ok(rl.text.includes('nightly') && rl.text.includes('next: '));
  updates = [cbk(63, rl.reply_markup.inline_keyboard[0][0].callback_data, nextMsg)];
  await wait(() => started.length === 2); assert.equal(started[1].text, 'Say hi & <bye>');
  fs.rmSync(rdir, { recursive: true, force: true });
}
// setMyCommands registered /status first, then the shortcuts + /list + /recover + /routines
const cmds = calls.find((c) => c.method === 'setMyCommands').body.commands.map((c) => c.command);
assert.deepEqual(cmds, ['status', 'studio', 'dev', 'render', 'info', 'ops', 'digest', 'evening', 'list', 'recover', 'routines']);
// every message the bot sent through the flow was valid HTML
for (const c of calls) if (['sendMessage', 'editMessageText'].includes(c.method) && c.body.parse_mode) ok(c.body.text);
// HTML rejected -> one plain-text retry, logged, nothing lost
rejectHtml = true; const sendsBefore = calls.filter((c) => c.method === 'sendMessage').length;
const fm = await tg.send('<b>dev</b> · <i>a &lt;b&gt; &amp;</i>\n<a href="http://x/#1">Open in console ↗</a>');
rejectHtml = false;
assert.ok(fm && fm.message_id);
const retry = calls.filter((c) => c.method === 'sendMessage').at(-1).body;
assert.equal(retry.parse_mode, undefined); assert.equal(retry.text, 'dev · a <b> &\nOpen in console ↗ http://x/#1');
assert.equal(calls.filter((c) => c.method === 'sendMessage').length, sendsBefore + 2);   // the rejected HTML attempt + exactly one plain retry
assert.ok(logs.some((l) => /HTML rejected, resent as plain text/.test(l))); assert.ok(!logs.join('\n').includes('SECRET'));
// a stranger's message is ignored
const before = calls.length;
updates = [{ update_id: 19, message: { message_id: 40, chat: { id: 999, type: 'private' }, text: '/ops hack' } }];
await new Promise((r) => setTimeout(r, 600));
assert.equal(tasks.length, 2);

// surrogate-safe clipping: an emoji is never cut in half (Telegram rejects a lone surrogate)
{
  const e = escClip('ab' + '😀'.repeat(10), 5); assert.equal(e, 'ab😀😀…');
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(escClip('x😀'.repeat(40), 7)), 'no lone surrogate after clipping');
}
// the getUpdates offset survives a restart: a second bot instance resumes from the persisted offset and persists the next one
tg.stop(); await new Promise((r) => setTimeout(r, 600));
{
  const offs = [];
  const tg2 = createTelegram({ cfgFile, apiBase, linkCodeFile, seats: ['ops'], phoneBase: BASE, getOffset: () => 77, setOffset: (o) => offs.push(o), onNewTask: async () => {}, onList: async () => [], onStatus: async () => ({ seats: [] }), onDecision: async () => 'x', onReply: async () => 'x' });
  const mark = calls.length;
  updates = [{ update_id: 80, message: { message_id: 90, chat: { id: 999, type: 'private' }, text: 'hi' } }];
  tg2.start();
  await wait(() => offs.length > 0);
  assert.deepEqual(offs, [81]); assert.equal(calls.slice(mark).find((c) => c.method === 'getUpdates').body.offset, 77, 'first poll starts at the persisted offset');
  await wait(() => calls.slice(mark).some((c) => c.method === 'getUpdates' && c.body.offset === 81));
  tg2.stop();
}

tg.stop(); api.close(); console.log('telegram tests passed');
process.exit(0);
