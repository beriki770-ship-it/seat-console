// Unit tests for hardening.mjs (retry, log rotation, pending-turn counter, host generations, event paging, idle pick, surrogate-safe clip).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isCleanExit } from './recovery.mjs';
import { convThrottle, retry, rotateLog, turnStart, turnEnd, clearTurns, lastHoff, eventWindow, pickIdle, clipChars, staleTurns, CLAMP_MS, isDeniedPath, lineHandler, compactFile, failCounter, isBenignCrash, guard, offsetFor, gate, viaServe, resolveIn, outFiles } from './hardening.mjs';

let ok = 0; const pass = (m) => { ok++; console.log('ok  ' + m); };

// retry: a transient failure is retried, a permanent one surfaces after 3 tries
{
  let n = 0; assert.equal(retry(() => { if (++n < 3) throw new Error('EBUSY'); return 'fine'; }, 3, 1), 'fine'); assert.equal(n, 3);
  let m = 0; assert.throws(() => retry(() => { m++; throw new Error('EPERM'); }, 3, 1), /EPERM/); assert.equal(m, 3);
  pass('retry: 2 failures then success; 3 failures throw');
}

// rotateLog: copy-truncate keeps the file usable for a holder with an open handle; two old copies at most
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rot-')), f = path.join(dir, 'server.log');
  const held = fs.openSync(f, 'a'); // like cmd's `>>` redirect: the file stays open
  fs.writeSync(held, 'x'.repeat(100));
  assert.equal(rotateLog(f, 1000), false);
  fs.writeSync(held, 'y'.repeat(1000));
  assert.equal(rotateLog(f, 1000), true);
  assert.equal(fs.statSync(f).size, 0); assert.equal(fs.statSync(f + '.1').size, 1100);
  fs.writeSync(held, 'after'); assert.equal(fs.readFileSync(f, 'utf8'), 'after', 'the holder keeps appending to the live file');
  fs.writeSync(held, 'z'.repeat(1000)); assert.equal(rotateLog(f, 1000), true);
  assert.equal(fs.readFileSync(f + '.2', 'utf8').length, 1100); assert.equal(fs.readFileSync(f + '.1', 'utf8').length, 1005);
  fs.writeSync(held, 'w'.repeat(1000)); rotateLog(f, 1000);
  assert.equal(fs.readFileSync(f + '.2', 'utf8').length, 1005, 'the oldest copy is replaced, never a .3');
  assert.ok(!fs.existsSync(f + '.3'));
  assert.equal(rotateLog(path.join(dir, 'missing.log'), 1), false);
  fs.closeSync(held); fs.rmSync(dir, { recursive: true, force: true });
  pass('rotateLog: copy-truncate under an open handle, keeps .1 and .2');
}

// pending turns: working while the counter is above zero
{
  const c = {};
  turnStart(c); assert.deepEqual([c.turns, c.working], [1, true]);
  turnStart(c); assert.deepEqual([c.turns, c.working], [2, true]);
  turnEnd(c); assert.deepEqual([c.turns, c.working], [1, true], 'first result: the second message is still queued');
  turnEnd(c); assert.deepEqual([c.turns, c.working], [0, false]);
  turnEnd(c); assert.deepEqual([c.turns, c.working], [0, false], 'a CLI-started turn ending never goes negative');
  turnStart(c); turnStart(c); clearTurns(c); assert.deepEqual([c.turns, c.working], [0, false]);
  pass('turn counter: inc on send, dec on result, clear on stop/crash');
}

// host generations: an offset logged by an older host-out file is ignored after a respawn
{
  const ev = [{ hoff: 100 }, { hoff: 5000 }, { type: 'console_spawn' }]; // legacy events, generation 0
  assert.equal(lastHoff(ev, 0), 5000); assert.equal(lastHoff(ev, undefined), 5000);
  assert.equal(lastHoff(ev, 1), 0, 'new generation: nothing logged yet, replay from the start of the new file');
  ev.push({ hoff: 70, hgen: 1 }, { hoff: 120, hgen: 1 });
  assert.equal(lastHoff(ev, 1), 120);
  ev.push({ hoff: 40, hgen: 2 }); assert.equal(lastHoff(ev, 2), 40); assert.equal(lastHoff(ev, 1), 120);
  pass('lastHoff: only the current generation counts');
}

// paging: last N events, earlier on demand, the oldest open approval card stays inside the window
{
  const all = Array.from({ length: 1200 }, (_, i) => ({ i, type: 'x' }));
  const a = eventWindow(all, [], null, 500); assert.deepEqual([a.from, a.events.length, a.total, a.events[0].i], [700, 500, 1200, 700]);
  const b = eventWindow(all, [], 700, 500); assert.deepEqual([b.from, b.events.length, b.events.at(-1).i], [200, 500, 699]);
  const c = eventWindow(all, [], 200, 500); assert.deepEqual([c.from, c.events.length], [0, 200]);
  assert.equal(eventWindow(all, [], 99999, 500).events.length, 500, 'before beyond the end is clamped');
  assert.equal(eventWindow([], [], null).events.length, 0);
  all[50] = { type: 'console_perm', requestId: 'r1' };
  const d = eventWindow(all, ['r1'], null, 500); assert.equal(d.from, 50, 'an approval card still open is never left outside the window');
  assert.equal(eventWindow(all, ['r1'], 700, 500).from, 200, 'paging backwards ignores pending cards');
  pass('eventWindow: last page, earlier pages, open approvals kept');
}

// idle eviction: the idle conversation that was quiet longest; none when all are busy
{
  const live = [{ id: 'a', busy: false, q: 300 }, { id: 'b', busy: true, q: 100 }, { id: 'c', busy: false, q: 200 }];
  assert.equal(pickIdle(live, (x) => x.busy, (x) => x.q).id, 'c');
  assert.equal(pickIdle(live.filter((x) => x.busy), (x) => x.busy, (x) => x.q), undefined);
  pass('pickIdle: oldest idle, undefined when every conversation is busy');
}

// clip by characters: an emoji is never cut in half
{
  const s = 'ab😀😀😀cd';
  assert.equal(clipChars(s, 3), 'ab😀'); assert.equal(clipChars(s, 4), 'ab😀😀');
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(clipChars(s, 3)), 'no lone high surrogate');
  assert.equal(clipChars('x'.repeat(100), 60).length, 60);
  pass('clipChars is surrogate-safe');
}
// M2: a line that throws is logged and skipped, the replay offset stays before it, the next lines are still handled
{
  const c = { hostOff: 100 }, r = {}, seen = [], errs = []; let adv = 0;
  const h = lineHandler({ c, r, handle: (line, end) => { if (line === 'boom') throw new Error('bad line'); seen.push([line, end]); }, sizeOf: () => 9999, onAdvance: () => adv++, onError: (e, l) => errs.push([e.message, l]) });
  h('a', 150); assert.equal(c.hostOff, 150); assert.equal(adv, 1);
  h('boom', 200); assert.equal(c.hostOff, 150, 'the offset did not move past the failing line'); assert.deepEqual(errs, [['bad line', 'boom']]); assert.equal(r.lineFailed, true);
  h('b', 260); assert.deepEqual(seen.map((x) => x[0]), ['a', 'b'], 'the stream continues'); assert.equal(c.hostOff, 150, 'and the offset stays put for the rest of this host');
  pass('lineHandler: throwing line logged, offset not advanced, later lines still handled');
}
// L1: after a compaction a live line with an offset beyond the (now small) file is handled, but its stale offset is never stored
{
  const c = { hostOff: 0 }, r = { compacted: true }, got = []; let size = 40;
  const h = lineHandler({ c, r, handle: (line, end) => got.push([line, end]), sizeOf: () => size, onError: () => { throw new Error('no'); } });
  h('late', 5000); assert.deepEqual(got.at(-1), ['late', 0], 'handled without an offset'); assert.equal(c.hostOff, 0); assert.equal(r.compacted, true);
  h('fresh', 40); assert.deepEqual(got.at(-1), ['fresh', 40]); assert.equal(c.hostOff, 40); assert.equal(r.compacted, false, 'first line that fits the new file ends the check');
  pass('lineHandler: stale post-compaction offsets are ignored');
}
// L1: compactFile truncates only a fully handled file and confirms it is empty
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-')), f = path.join(dir, 'x.host-out');
  fs.writeFileSync(f, 'line one\n'); assert.equal(compactFile(f, 3), false, 'unhandled bytes in there: untouched'); assert.equal(fs.statSync(f).size, 9);
  assert.equal(compactFile(f, 9), true); assert.equal(fs.statSync(f).size, 0);
  // the host appended between our check and the truncate: re-stat shows content, so the caller bumps nothing
  fs.writeFileSync(f, 'abc\n'); let n = 0;
  const racy = { statSync: (p) => (n++ === 0 ? fs.statSync(p) : { size: 7 }), truncateSync: (p, l) => fs.truncateSync(p, l) };
  assert.equal(compactFile(f, 4, racy), false);
  assert.throws(() => compactFile(path.join(dir, 'missing'), 1), /ENOENT/);
  fs.rmSync(dir, { recursive: true, force: true });
  pass('compactFile: size guard, confirm-empty, missing file throws (caller skips)');
}
// M6: whole directory names are denied, loose names only for the file itself
{
  const deny = ['C:\\p\\secrets\\a.png', 'C:\\p\\secret\\a.png', 'C:\\p\\.env\\a.png', 'C:\\p\\.env.local\\a.png', 'C:\\p\\Credentials\\a.png', 'C:\\p\\tokens\\a.png', 'C:\\p\\password\\a.png',
    'C:\\p\\ok\\credentials.json', 'C:\\p\\ok\\my-token.txt', 'C:\\p\\ok\\.env', 'C:\\p\\ok\\server.pem', 'C:\\p\\ok\\id_rsa', 'C:/p/Secrets/a.png'];
  const allow = ['C:\\p\\design-tokens\\a.png', 'C:\\p\\tokenizer\\a.png', 'C:\\p\\ok\\out\\short1.mp4', 'C:\\p\\environment\\a.png', 'C:\\p\\secretary\\a.png', 'C:\\p\\keys\\a.png', 'C:\\p\\.environment\\a.png'];
  for (const p of deny) assert.equal(isDeniedPath(p), true, 'denied: ' + p);
  for (const p of allow) assert.equal(isDeniedPath(p), false, 'allowed: ' + p);
  pass('isDeniedPath: whole-segment directory rules, loose file-name rule');
}
// L2: copy-truncate of an APPEND-mode writer leaves no NUL bytes, even when it keeps writing after the rotation
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nul-')), f = path.join(dir, 'server.log');
  const held = fs.openSync(f, 'a');
  for (let i = 0; i < 3; i++) { fs.writeSync(held, 'x'.repeat(1500)); assert.equal(rotateLog(f, 1000), true); fs.writeSync(held, 'after-' + i + '\n'); }
  for (const g of [f, f + '.1', f + '.2']) assert.ok(!fs.readFileSync(g).includes(0), 'no NUL in ' + path.basename(g));
  assert.equal(fs.readFileSync(f, 'utf8'), 'after-2\n');
  fs.closeSync(held);
  // the failure mode the launcher scripts avoid: a handle that writes at its own offset (not append) leaves a NUL-filled hole after truncate
  const w = fs.openSync(f, 'w'); fs.writeSync(w, 'y'.repeat(1500)); rotateLog(f, 1000); fs.writeSync(w, 'z');
  assert.ok(fs.readFileSync(f).includes(0), 'documents why start-console.ps1 / start-test.ps1 use cmd >> instead of -RedirectStandardOutput');
  fs.closeSync(w); fs.rmSync(dir, { recursive: true, force: true });
  pass('rotateLog: no NUL bytes for append-mode writers (non-append handles are the launchers\' job)');
}
for (const f of ['start-console.ps1', 'start-test.ps1']) assert.ok(!/-RedirectStandardOutput/.test(fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8').replace(/^\s*#.*$/gm, '')) && /2>&1/.test(fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8')), f + ' appends with >>');
pass('L2: both launcher scripts redirect with >> (append)');
// L3: the persisted Telegram offset belongs to one bot token; only a hash is stored
{
  const st = { tgOffset: 500 };
  assert.equal(offsetFor(st, 'tokenA'), 500, 'legacy state without a hash: offset kept (a reset would replay old updates), hash recorded'); assert.ok(st.tgTokenHash && !JSON.stringify(st).includes('tokenA'), 'the token itself is never stored');
  st.tgOffset = 77; assert.equal(offsetFor(st, 'tokenA'), 77, 'same token: offset kept');
  assert.equal(offsetFor(st, 'tokenB'), 0, 'token changed: offset reset'); assert.equal(st.tgOffset, 0);
  st.tgOffset = 12; assert.equal(offsetFor(st, null), 12, 'no token configured: nothing changes');
  pass('offsetFor: reset on token change, hash only');
}
// L7: three failures in a row trip once, the first success clears
{
  let trips = 0, clears = 0; const f = failCounter(3, () => trips++, () => clears++);
  f.fail(); f.fail(); f.ok(); f.fail(); f.fail(); assert.equal(trips, 0, 'a success in between resets the run');
  f.fail(); assert.equal(trips, 1); f.fail(); f.fail(); assert.equal(trips, 1, 'one warning only'); assert.equal(f.tripped, true);
  f.ok(); assert.equal(clears, 1); f.ok(); assert.equal(clears, 1); f.fail(); f.fail(); f.fail(); assert.equal(trips, 2, 'trips again after recovery');
  pass('failCounter: trips at 3 consecutive failures, once, clears on success');
}
// M2: uncaughtException policy and throttled interval errors
{
  for (const e of [Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }), new Error('read ECONNRESET'), Object.assign(new Error('x'), { code: 'ERR_STREAM_DESTROYED' })]) assert.equal(isBenignCrash(e), true);
  for (const e of [new TypeError("Cannot read properties of undefined (reading 'x')"), new Error('boom'), new RangeError('Invalid string length')]) assert.equal(isBenignCrash(e), false);
  const logs = []; let t = 0; const g = guard('tick', () => { throw new Error('same'); }, (l) => logs.push(l), 1000, () => t);
  g(); g(); g(); assert.equal(logs.length, 1, 'the same error is logged once per window'); t = 1500; g(); assert.equal(logs.length, 2); assert.match(logs[1], /repeated 2x/);
  assert.equal(guard('ok', () => 5)(), 5);
  pass('isBenignCrash + guard: benign list is small, repeated interval errors are throttled');
}
// M5: a result that leaves turns pending clears them after settleMs of silence, never earlier, never while activity or an approval is open
{
  const c = { turns: 1 }, r = { clampAt: 1000, activityAt: 0, perms: new Map() };
  assert.equal(staleTurns(c, r, 1000 + 5999, 6000), false, 'too early');
  assert.equal(staleTurns(c, r, 1000 + 6000, 6000), true, 'quiet for settleMs: the folded message gets no result of its own');
  r.activityAt = 2000; assert.equal(staleTurns(c, r, 99999, 6000), false, 'activity after the result: the next turn is running');
  r.activityAt = 0; r.perms.set('x', {}); assert.equal(staleTurns(c, r, 99999, 6000), false, 'open approval: not stale');
  r.perms.clear(); c.turns = 0; assert.equal(staleTurns(c, r, 99999, 6000), false, 'nothing pending'); c.turns = 2; r.clampAt = 0; assert.equal(staleTurns(c, r, 99999, 6000), false, 'no result seen yet');
  pass('staleTurns: clamp only after a quiet settle window');
}
// Finding 1: a queued turn on a slow model may be silent for >6 s; the clamp waits CLAMP_MS and never runs while background work is listed
{
  assert.equal(CLAMP_MS, 120000);
  const c = { turns: 1, bg: [] }, r = { clampAt: 1000, activityAt: 0, perms: new Map() };
  assert.equal(staleTurns(c, r, 1000 + 7000, CLAMP_MS), false, '7 s of silence (queued turn, first event not there yet) is not stale');
  assert.equal(staleTurns(c, r, 1000 + CLAMP_MS - 1, CLAMP_MS), false); assert.equal(staleTurns(c, r, 1000 + CLAMP_MS, CLAMP_MS), true);
  c.bg = [{ id: 'a1' }]; assert.equal(staleTurns(c, r, 1e9, CLAMP_MS), false, 'background agents listed: never clamped');
  pass('staleTurns: CLAMP_MS window, skipped while c.bg has entries');
}
// Finding 6: compaction persists the new offset/generation BEFORE the file is truncated
{
  const log = [], fake = { statSync: () => ({ size: log.includes('truncate') ? 0 : 9 }), truncateSync: () => log.push('truncate') };
  assert.equal(compactFile('f', 9, fake, () => log.push('persist')), true); assert.deepEqual(log, ['persist', 'truncate']);
  const log2 = []; assert.equal(compactFile('f', 3, { ...fake, truncateSync: () => log2.push('truncate') }, () => log2.push('persist')), false); assert.deepEqual(log2, [], 'size mismatch: neither persisted nor truncated');
  pass('compactFile: beforeTruncate runs first, not at all when the size check fails');
}
// Finding 4: the exit(1) of the uncaughtException handler is not a crash for the next start
{
  assert.equal(isCleanExit(0, false), true); assert.equal(isCleanExit(1, false), false, 'a hard exit stays a crash'); assert.equal(isCleanExit(1, true), true, 'uncaught handler exit: no crash offer');
  pass('isCleanExit: uncaught-exception exit counts as clean');
}
// Review finding: a summary waiting on its timer when the conversation is removed must not go out as `data: undefined`
{
  const sent = [], timers = []; let t = 10000;
  const b = convThrottle((o) => sent.push(o), 500, () => t, (fn) => timers.push(fn));
  b({ conv: { id: 'a', n: 1 } }); b({ conv: { id: 'a', n: 2 } }); b({ conv: { id: 'a', n: 3 } });
  assert.deepEqual(sent.map((o) => o.conv.n), [1], 'first goes out, the rest wait'); assert.equal(timers.length, 1, 'one timer, newest summary replaces the waiting one');
  b({ removed: 'a' }); assert.equal(sent.at(-1).removed, 'a');
  const n = sent.length; timers.shift()(); assert.equal(sent.length, n, 'timer after removal sends nothing (no data: undefined)');
  assert.ok(sent.every((o) => o !== undefined));
  t += 1; b({ conv: { id: 'a', n: 9 } }); assert.equal(sent.at(-1).conv.n, 9, 'removed conversation lost its throttle timestamp: next summary is immediate');
  b({ conv: { id: 'b', n: 1 } }); b({ conv: { id: 'b', n: 2 } }); t += 600; timers.shift()(); assert.equal(sent.at(-1).conv.n, 2, 'normal path still flushes the newest');
  pass('convThrottle: removed conversation never sends undefined; normal throttling unchanged');
}
// gate: tailscale serve proxies the phone from 127.0.0.1, so loopback + serve markers must authenticate exactly like the Tailscale-IP listener
{
  const TS = 'pc.example-tailnet.ts.net', auth = 'Basic ' + Buffer.from('user:pw').toString('base64');
  const cfg = { hosts: ['127.0.0.1:4850', 'localhost:4850', '100.1.2.3:4850', `${TS}:4850`, TS], origins: ['http://127.0.0.1:4850', `http://${TS}:4850`, `https://${TS}`], tsName: TS, auth };
  const LO = '127.0.0.1';
  assert.equal(gate(LO, { host: '127.0.0.1:4850' }, cfg), 0, 'loopback without serve headers = local, no auth');
  assert.equal(gate('::ffff:127.0.0.1', { host: 'localhost:4850', origin: 'http://127.0.0.1:4850' }, cfg), 0, 'local browser with its own origin');
  assert.equal(gate(LO, { host: TS }, cfg), 401, 'loopback + bare ts Host (serve) = needs auth');
  assert.equal(gate(LO, { host: TS.toUpperCase() }, { ...cfg, hosts: [...cfg.hosts, TS.toUpperCase()] }), 401, 'Host compare is case-insensitive');
  assert.equal(gate(LO, { host: '127.0.0.1:4850', 'tailscale-user-login': 'user@example.com' }, cfg), 401, 'loopback + Tailscale-User-Login = needs auth');
  assert.equal(gate(LO, { host: '127.0.0.1:4850', 'tailscale-user-name': 'someone' }, cfg), 401, 'loopback + Tailscale-User-Name = needs auth');
  assert.equal(gate(LO, { host: '127.0.0.1:4850', 'x-forwarded-for': '100.64.0.9' }, cfg), 401, 'loopback + X-Forwarded-For = needs auth');
  assert.equal(gate(LO, { host: TS, authorization: 'Basic ' + Buffer.from('user:wrong').toString('base64') }, cfg), 401, 'wrong auth = 401');
  assert.equal(gate(LO, { host: TS, authorization: auth + 'x' }, cfg), 401, 'auth of another length = 401 (no throw)');
  assert.equal(gate(LO, { host: TS, origin: `https://${TS}`, authorization: auth }, cfg), 0, 'correct auth via serve = pass (200)');
  assert.equal(gate('100.70.1.1', { host: '100.1.2.3:4850' }, cfg), 401, 'Tailscale IP without auth = 401 (unchanged)');
  assert.equal(gate('100.70.1.1', { host: '100.1.2.3:4850', authorization: auth }, cfg), 0, 'Tailscale IP with auth = pass (unchanged)');
  assert.equal(gate(LO, { host: TS, origin: 'https://evil.example', authorization: auth }, cfg), 403, 'foreign Origin = 403 even with auth');
  assert.equal(gate(LO, { host: '127.0.0.1:4850', origin: `http://${TS}` }, cfg), 403, 'http (not https) origin of the bare name = 403');
  assert.equal(gate(LO, { host: 'evil.example' }, cfg), 403, 'foreign Host (DNS rebinding) = 403');
  assert.equal(gate(LO, { host: TS }, { ...cfg, tsName: null, hosts: cfg.hosts.filter((h) => h !== TS) }), 403, 'Tailscale not detected: the bare name is not even allowed');
  assert.equal(viaServe({ host: TS }, null), false, 'no tsName: Host alone never marks serve');
  for (const k of ['via', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'tailscale-user-login', 'tailscale-user-profile-pic', 'tailscale-anything'])
    assert.equal(gate(LO, { host: '127.0.0.1:4850', [k]: '1' }, { ...cfg, tsName: null }), 401, `loopback + ${k} = remote, needs auth (even with Tailscale not detected)`);
  assert.equal(gate(LO, { host: '127.0.0.1:4850', 'x-requested-with': '1', 'user-agent': 'curl' }, cfg), 0, 'ordinary headers keep loopback local');
  pass('gate: loopback local / serve needs auth / wrong auth 401 / right auth pass / foreign origin+host 403');
}
// resolveIn + outFiles: the /api/file rules, shared by the Telegram file sender
{
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'outf-'))), proj = path.join(root, 'projects'), here = path.join(root, 'console'), cwd = path.join(root, 'demo');
  for (const d of [proj, here, cwd, path.join(cwd, 'secrets'), path.join(cwd, '.claude')]) fs.mkdirSync(d, { recursive: true });
  const w = (f, n = 3) => { fs.writeFileSync(f, Buffer.alloc(n, 1)); return f; };
  const rules = { projects: proj, here, data: here, defaultCwd: proj, mime: { png: 1, mp4: 1, pdf: 1, json: 1, md: 1, html: 1, txt: 1 } }, c = { cwd };   // the /api/file viewer types
  const a = w(path.join(cwd, 'out.png')), b = w(path.join(proj, 'film.mp4'), 9);
  w(path.join(cwd, 'secrets', 'x.png')); w(path.join(cwd, '.claude', 'y.png')); w(path.join(here, 'token.png')); w(path.join(cwd, 'api-token.pdf')); w(path.join(cwd, 'notes.exe')); w(path.join(cwd, 'empty.png'), 0); w(path.join(root, 'outside.png'));
  const cfgs = ['config.json', '.mcp.json', 'settings.json', 'firebase-adminsdk-x.json', 'README.md', 'page.html', 'log.txt'].map((n) => w(path.join(cwd, n)));
  const old = w(path.join(cwd, 'old.mp4'), 5), oldDoc = w(path.join(cwd, 'old.pdf'), 5), T0 = Date.now() - 60000; fs.utimesSync(old, new Date(T0 - 3600e3), new Date(T0 - 3600e3)); fs.utimesSync(oldDoc, new Date(T0 - 3600e3), new Date(T0 - 3600e3));
  assert.equal(resolveIn('out.png', c, rules), a, 'relative to the conversation cwd');
  assert.equal(resolveIn(path.join(cwd, 'secrets', 'x.png'), c, rules), 'forbidden');
  const got = outFiles({ writes: ['out.png', a, b, 'secrets/x.png', '.claude/y.png', path.join(here, 'token.png'), 'api-token.pdf', 'notes.exe', 'empty.png', path.join(root, 'outside.png'), 'missing.png'] }, c, rules);
  assert.deepEqual(got, [{ path: a, name: 'out.png', size: 3 }, { path: b, name: 'film.mp4', size: 9 }], 'denied dir/.claude/console dir/secret name/unknown type/empty/outside/missing dropped, duplicate once');
  assert.deepEqual(outFiles({ writes: ['out.png'] }, { cwd: path.join(root, 'gone') }, rules), [], 'a vanished cwd sends nothing and does not throw');
  assert.equal(resolveIn('config.json', c, rules), path.join(cwd, 'config.json'), 'the /api/file viewer still serves json/md (rules unchanged)');
  assert.deepEqual(outFiles({ writes: cfgs, named: cfgs, since: 0 }, c, rules), [], 'Telegram: json/md/html/txt never pushed, neither written nor named (keys live in config.json, .mcp.json, *-adminsdk-*.json)');
  assert.deepEqual(outFiles({ named: ['old.mp4', 'old.pdf', 'out.png'], since: T0 }, c, rules).map((x) => x.name), ['out.png'], 'a named file older than the turn start is not re-sent');
  assert.deepEqual(outFiles({ writes: ['old.mp4'], since: T0 }, c, rules).map((x) => x.name), ['old.mp4'], 'a file the turn WROTE is sent whatever its mtime');
  assert.deepEqual(outFiles({ named: ['out.png'], since: Infinity }, c, rules), [], 'no known turn start (after a restart): no named files');
  fs.rmSync(root, { recursive: true, force: true });
  pass('outFiles: /api/file rules + media/pdf only + named files fresh only, each once, never throws');
}
console.log(`all ${ok} hardening tests passed`);
