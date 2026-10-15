// Unit tests for lifecycle.mjs (stop / start / lost host / eviction races) against fakes: node console\test-lifecycle.mjs. No server, no claude, no quota.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLifecycle } from './lifecycle.mjs';
import { turnStart, clearTurns, pickIdle } from './hardening.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-life-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0; const pass = (m) => { ok++; console.log('ok  ' + m); };

// A world of fakes. The "host files" are one info file per conversation; pids live in `alive` until a kill removes them.
function world({ killMs = 60, startMs = 10 } = {}) {
  const convs = [], rts = new Map(), alive = new Set(), calls = [], statuses = [], events = [];
  let nextPid = 1000, cleaned = 0;
  const R = (c) => { let r = rts.get(c.id); if (!r) rts.set(c.id, r = { proc: null, perms: new Map(), procCost: 0, activityAt: 0, done: null, starting: null, stopping: null, silent: false, silentGaveUp: false, lastAt: 0 }); return r; };
  const info = (c) => path.join(dir, c.id + '.host.json');
  const mkConv = (id, seat = 's') => { const c = { id, seat, working: false, turns: 0, bg: [] }; convs.push(c); return c; };
  const attachFake = (c) => { const pid = nextPid++, hostPid = nextPid++; alive.add(pid); alive.add(hostPid); fs.writeFileSync(info(c), JSON.stringify({ pid: hostPid, claudePid: pid })); R(c).proc = { pid, hostPid, link: { close() {} } }; return { pid, hostPid }; };
  const d = {
    R, convs: () => convs, QUIET_MS: 20000, MAX_PER_SEAT: 3,
    killHostPid: async (pid) => { calls.push(['host', pid]); await sleep(killMs); alive.delete(pid); },
    killClaudePid: async (pid) => { calls.push(['claude', pid]); alive.delete(pid); },
    killTree: async (pid) => { calls.push(['tree', pid]); await sleep(killMs); alive.delete(pid); },
    hostInfoOf: (c) => { try { return JSON.parse(fs.readFileSync(info(c), 'utf8')); } catch { return null; } },
    pidAlive: (pid) => alive.has(pid),
    cleanHostFiles: (c) => { cleaned++; fs.rmSync(info(c), { force: true }); },
    startProc: async (c) => { await sleep(startMs); attachFake(c); calls.push(['start', c.id]); },
    pickIdle: (...a) => { calls.push(['pick', Date.now()]); return pickIdle(...a); },
    clearTurns, setStatus: (c, s) => statuses.push([c.id, s]), pushEvent: (c, e) => events.push([c.id, e.type]), log: () => {} };
  return { L: createLifecycle(d), d, R, mkConv, attachFake, info, calls, statuses, events, alive, get cleaned() { return cleaned; } };
}

// H1: stop and send at once, five times. The new host's files must survive the old teardown and the new turn must not be zeroed.
for (let i = 0; i < 5; i++) {
  const w = world(), c = w.mkConv('h1-' + i); w.attachFake(c);
  const st = w.L.stopConv(c);                       // /api/stop: not awaited, the user already typed the next message
  await w.L.ensureProc(c); turnStart(c);            // /api/send: ensureProc, then the turn counter and status of the new turn
  w.d.setStatus(c, 'working');
  await st;
  assert.ok(fs.existsSync(w.info(c)), 'the new host info file exists after the old teardown finished');
  const info = w.d.hostInfoOf(c); assert.equal(info.pid, w.R(c).proc.hostPid, 'and it is the NEW host');
  assert.ok(w.R(c).proc, 'new process is attached'); assert.equal(c.turns, 1, 'the new turn is not zeroed by the old stop'); assert.equal(c.working, true);
  assert.notEqual(w.statuses.at(-1)[1], 'stopped', 'status is not overwritten with stopped');
  assert.equal(w.cleaned, 0, 'no cleanup ran after the new start was queued');
}
pass('H1: stop + immediate send x5: new host files survive, turn counter intact');

// H1: a lost host and an immediate send
{
  const w = world(), c = w.mkConv('h1-lost'); w.attachFake(c); c.working = true; c.turns = 1;
  const h = w.L.hostLost(c);
  await w.L.ensureProc(c); turnStart(c);
  await h;
  assert.ok(fs.existsSync(w.info(c))); assert.equal(c.turns, 1, 'the interrupted old turn was cleared, the new one counts'); assert.equal(c.working, true);
  assert.equal(w.R(c).stopping, null);
  assert.ok(w.events.some((e) => e[1] === 'console_error'), 'the interruption is logged');
  // and without a new start the files ARE cleaned
  const c2 = w.mkConv('h1-lost2'); w.attachFake(c2); await w.L.hostLost(c2); assert.ok(!fs.existsSync(w.info(c2)), 'no new start: host files removed');
  pass('H1: hostLost + immediate start keeps the new host; plain hostLost cleans up');
}

// H1: killProc with nothing new started cleans up; two kills in a row share the work
{
  const w = world(), c = w.mkConv('plain'); w.attachFake(c);
  await w.L.killProc(c); assert.ok(!fs.existsSync(w.info(c))); assert.equal(w.R(c).proc, null);
  await w.L.killProc(c); // second kill: nothing to do, no throw
  pass('killProc: cleans files when nothing restarted; a second kill is a no-op');
}

// L5: Stop during a start waits for it and then stops the process it created
{
  const w = world({ startMs: 120 }), c = w.mkConv('l5');
  const e = w.L.ensureProc(c); assert.ok(w.R(c).starting);
  await w.L.stopConv(c); await e.catch(() => {});
  assert.equal(w.R(c).proc, null, 'the process started meanwhile was stopped'); assert.equal(w.R(c).starting, null);
  assert.deepEqual(w.statuses.at(-1), ['l5', 'stopped']);
  assert.ok(w.calls.some((x) => x[0] === 'tree'), 'its claude tree was killed');
  pass('L5: stop waits for a start in progress, then stops it');
}

// ensureProc: a throw before the first await must not leave `starting` set for ever
{
  const w = world(), c = w.mkConv('stuck'); w.R(c).silent = true; w.attachFake(c); w.R(c).proc = null; // a live host nobody is connected to
  await assert.rejects(w.L.ensureProc(c), /not answering/); assert.equal(w.R(c).starting, null, 'starting is cleared after the throw');
  await assert.rejects(w.L.ensureProc(c), /not answering/);
  pass('ensureProc: refusal does not wedge the conversation');
}

// M1: a pending finished-notification keeps a conversation busy (not evictable); L6: a silent host counts against the cap
{
  const w = world(), s = ['a', 'b', 'c'].map((n) => { const c = w.mkConv(n); w.attachFake(c); w.R(c).lastAt = 1; return c; });
  assert.equal(w.L.isBusy(s[0]), false);
  w.R(s[0]).done = { info: {}, at: Date.now() };
  assert.equal(w.L.isBusy(s[0]), true, 'M1: r.done makes it busy'); assert.equal(w.L.busyCount('s'), 1);
  w.R(s[1]).done = {}; w.R(s[2]).done = {};
  const n = w.mkConv('n');
  await assert.rejects(w.L.makeRoom(n), /already has 3 conversations/, 'M1: nothing is evicted while every one has a pending notification');
  assert.equal(w.calls.filter((x) => x[0] === 'tree').length, 0, 'no process was killed');
  w.R(s[2]).done = null; await w.L.makeRoom(n);
  assert.equal(w.R(s[2]).proc, null, 'the one without a pending notification is the one evicted');
  pass('M1: pending finished-notification protects a conversation from eviction');

  const w2 = world(), a = w2.mkConv('a'), b = w2.mkConv('b'), q = w2.mkConv('q'); [a, b].forEach((c) => w2.attachFake(c)); w2.R(q).silent = true;
  assert.equal(w2.L.liveOf('s').length, 3, 'L6: the silent host counts');
  assert.equal(w2.L.isBusy(q), true, 'and is busy while the console still knocks');
  w2.R(q).silentGaveUp = true; assert.equal(w2.L.isBusy(q), false);
  pass('L6: silent-host conversations count against the seat cap');
}

// L6: evictions of one seat are serialized (the second starts picking only after the first eviction finished)
{
  const w = world({ killMs: 80 }), live = ['a', 'b', 'c'].map((n, i) => { const c = w.mkConv(n); w.attachFake(c); w.R(c).lastAt = i + 1; return c; });
  const n1 = w.mkConv('n1'), n2 = w.mkConv('n2');
  await Promise.all([w.L.ensureProc(n1), w.L.ensureProc(n2)]);
  const running = live.filter((c) => w.R(c).proc);
  assert.equal(running.length, 1, 'cap 3: n1 + n2 + one survivor');
  assert.ok(w.R(n1).proc && w.R(n2).proc);
  const picks = w.calls.filter((x) => x[0] === 'pick').map((x) => x[1]);
  const evicted = w.calls.filter((x) => x[0] === 'tree').length; assert.equal(evicted, 2, 'exactly two evictions, none twice');
  assert.ok(picks.at(-1) - picks[0] >= 70, 'the second eviction waited for the first one to finish killing');
  pass('L6: makeRoom is serialized per seat');
}

// M3: a silent host is killed by Stop/Delete/eviction at once, and by ensureProc only after the console gave up knocking
{
  const w = world(), c = w.mkConv('m3'), h = w.attachFake(c); w.R(c).proc = null; w.R(c).silent = true;
  await assert.rejects(w.L.ensureProc(c), /not answering/);
  assert.ok(w.alive.has(h.hostPid), 'while still knocking nothing is killed');
  w.R(c).silentGaveUp = true;
  await w.L.ensureProc(c);
  assert.deepEqual(w.calls.filter((x) => x[0] === 'host' || x[0] === 'claude').slice(0, 2), [['host', h.hostPid], ['claude', h.pid]], 'gave up: host then claude killed by pid');
  assert.ok(w.R(c).proc && w.R(c).proc.hostPid !== h.hostPid, 'and a fresh process started'); assert.equal(w.R(c).silent, false);
  // explicit Stop on a silent host
  const c2 = w.mkConv('m3b'), h2 = w.attachFake(c2); w.R(c2).proc = null; w.R(c2).silent = true;
  await w.L.stopConv(c2);
  assert.ok(!w.alive.has(h2.hostPid) && !w.alive.has(h2.pid), 'Stop kills the silent host and its claude'); assert.equal(w.R(c2).silent, false);
  assert.ok(!fs.existsSync(w.info(c2)), 'files cleaned'); assert.deepEqual(w.statuses.at(-1), ['m3b', 'stopped']);
  // eviction picks a silent host that gave up
  const c3 = w.mkConv('m3c'); const h3 = w.attachFake(c3); w.R(c3).proc = null; w.R(c3).silent = true; w.R(c3).silentGaveUp = true;
  await w.L.killProc(c3); assert.ok(!w.alive.has(h3.hostPid));
  pass('M3: silent host is killed by stop / delete (killProc) / ensureProc-after-give-up, not before');
}

// Finding 2: a clampAt left by an earlier result must not survive stop / lost host (it would clamp the next turn before its first event)
{
  const w = world(), c = w.mkConv('clamp1'); w.attachFake(c); w.R(c).clampAt = 12345; c.turns = 1;
  await w.L.stopConv(c); assert.equal(w.R(c).clampAt, 0, 'stopConv resets clampAt');
  const c2 = w.mkConv('clamp2'); w.attachFake(c2); w.R(c2).clampAt = 12345; c2.working = true; c2.turns = 1;
  await w.L.hostLost(c2); assert.equal(w.R(c2).clampAt, 0, 'hostLost resets clampAt');
  pass('clampAt reset by stopConv and hostLost');
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(`all ${ok} lifecycle tests passed`);
