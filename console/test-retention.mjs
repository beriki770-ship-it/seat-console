// Run: node console/test-retention.mjs. Log retention: which conversations qualify, gzip + verify + archive, the transparent read, restore on the next append, dry run changes nothing,
// orphan uploads, test-data leftovers, and the race where the log grows while it is being compressed.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { planRetention, runRetention, readLogText, restoreLog, purgeArchive, gzPath, DAY } from './retention.mjs';

const NOW = Date.now(), data = fs.mkdtempSync(path.join(os.tmpdir(), 'ret-')), td = path.join(data, 'test-data');
const uid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const body = (n) => Array.from({ length: n }, (_, i) => JSON.stringify({ type: 'assistant', i, text: 'hello world '.repeat(40) })).join('\n') + '\n';
const mk = (n, c, o = {}) => {
  const conv = { id: uid(n), seat: 'ops', updatedAt: NOW - 1000, ...c };
  fs.mkdirSync(path.join(data, 'logs', conv.seat), { recursive: true });
  const f = path.join(data, 'logs', conv.seat, conv.id + '.jsonl'); fs.writeFileSync(f, o.text ?? body(300));
  if (o.age) { const t = (NOW - o.age) / 1000; fs.utimesSync(f, t, t); }
  return conv;
};
const old = 15 * DAY;
const cs = {
  archived: mk(1, { archived: true }),
  idleOld: mk(2, { updatedAt: NOW - old }, { age: old }),
  recent: mk(3, { updatedAt: NOW - 13 * DAY }, { age: 13 * DAY }),
  oldButWorking: mk(4, { updatedAt: NOW - old, working: true }, { age: old }),
  oldInterrupted: mk(5, { updatedAt: NOW - old, interrupted: true }, { age: old }),
  oldBusyInServer: mk(6, { updatedAt: NOW - old }, { age: old }),
  oldWithHost: mk(7, { updatedAt: NOW - old }, { age: old }),
  oldTouchedFile: mk(8, { updatedAt: NOW - old }),           // state says old, but the file was written just now: not idle
  empty: mk(9, { archived: true }, { text: '' }),
  hostOut: mk(10, { archived: true }),
};
fs.writeFileSync(path.join(data, 'logs', 'ops', cs.oldWithHost.id + '.host.json'), JSON.stringify({ pid: process.pid }));
fs.writeFileSync(path.join(data, 'logs', 'ops', cs.hostOut.id + '.host-out'), body(50));
const state = { conversations: Object.fromEntries(Object.values(cs).map((c) => [c.id, c])) };
const busy = (c) => c.id === cs.oldBusyInServer.id;
// uploads: one orphan (old), one orphan younger than a day, one that belongs to a conversation, _staged
const up = path.join(data, 'uploads'); const orphan = path.join(up, uid(90)), young = path.join(up, uid(91));
for (const d of [orphan, young, path.join(up, cs.archived.id), path.join(up, '_staged')]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'x.png'), 'x'.repeat(100)); }
const t3 = (NOW - 3 * DAY) / 1000; fs.utimesSync(orphan, t3, t3);
// test-data: one entry older than 2 days, one fresh
fs.mkdirSync(path.join(td, 'smoke-old'), { recursive: true }); fs.writeFileSync(path.join(td, 'smoke-old', 'state.json'), '{}'); fs.writeFileSync(path.join(td, 'fresh.txt'), 'x');
fs.utimesSync(path.join(td, 'smoke-old'), t3, t3);
// the persistent TEST instance lives in test-data itself (start-test.ps1): its old files and folders are never swept, only smoke-* run folders
for (const n of ['state.json', 'token.txt', 'routines.json']) { fs.writeFileSync(path.join(td, n), '{}'); fs.utimesSync(path.join(td, n), t3, t3); }
fs.mkdirSync(path.join(td, 'logs', 'ops'), { recursive: true }); fs.utimesSync(path.join(td, 'logs'), t3, t3);

// ---- plan: only what qualifies ----
const plan = planRetention({ data, state, now: NOW, busy, testDataDir: td });
const ids = plan.files.map((f) => path.basename(f.from));
assert.deepEqual(ids.sort(), [cs.archived.id + '.jsonl', cs.idleOld.id + '.jsonl', cs.hostOut.id + '.host-out', cs.hostOut.id + '.jsonl'].sort(), 'archived + idle > 14 d; not recent, working, interrupted, busy, with a host record, freshly written, empty');
assert.deepEqual(plan.orphanUploads.map((x) => path.basename(x.path)), [uid(90)], 'only the old orphan folder');
assert.deepEqual(plan.testData.map((x) => path.basename(x.path)), ['smoke-old']);

// ---- dry run: measures, changes nothing ----
const before = fs.readdirSync(path.join(data, 'logs', 'ops')).sort();
const dry = await runRetention({ data, state, now: NOW, dryRun: true, busy, testDataDir: td });
assert.equal(dry.compressed.length, 4); assert.ok(dry.saved > 0 && dry.compressed.every((f) => f.after < f.before), 'gz is smaller');
assert.deepEqual(fs.readdirSync(path.join(data, 'logs', 'ops')).sort(), before, 'dry run left every file alone');
assert.ok(fs.existsSync(orphan) && fs.existsSync(path.join(td, 'smoke-old')) && !fs.existsSync(path.join(data, 'logs', 'archive')));

// ---- real run ----
const orig = fs.readFileSync(path.join(data, 'logs', 'ops', cs.archived.id + '.jsonl'), 'utf8'), flagged = [];
const rep = await runRetention({ data, state, now: NOW, busy, testDataDir: td, onCompressed: (seat, id, from) => flagged.push(path.basename(from)) });
assert.equal(rep.compressed.length, 4); assert.equal(rep.skipped.length, 0);
assert.ok(!fs.existsSync(path.join(data, 'logs', 'ops', cs.archived.id + '.jsonl')) && fs.existsSync(gzPath(data, cs.archived)), 'jsonl gone, gz in logs/archive/<seat>/');
assert.ok(fs.existsSync(path.join(data, 'logs', 'ops', cs.recent.id + '.jsonl')) && fs.existsSync(path.join(data, 'logs', 'ops', cs.oldWithHost.id + '.jsonl')), 'the others are untouched');
assert.ok(fs.existsSync(path.join(data, 'logs', 'archive', 'ops', cs.hostOut.id + '.host-out.gz')) && !fs.existsSync(path.join(data, 'logs', 'ops', cs.hostOut.id + '.host-out')));
assert.equal(flagged.length, 4);
assert.ok(!fs.existsSync(orphan) && fs.existsSync(young) && fs.existsSync(path.join(up, cs.archived.id)) && fs.existsSync(path.join(up, '_staged')), 'only the orphan upload folder went');
assert.ok(!fs.existsSync(path.join(td, 'smoke-old')) && fs.existsSync(path.join(td, 'fresh.txt')), 'only the old test-data entry went');
assert.ok(['state.json', 'token.txt', 'routines.json', 'logs'].every((n) => fs.existsSync(path.join(td, n))), 'the TEST instance data in test-data survived although older than 2 days');
assert.ok(!fs.readdirSync(path.join(data, 'logs', 'archive', 'ops')).some((n) => n.endsWith('.tmp')));

// ---- transparent read, restore on the next append ----
const jsonl = path.join(data, 'logs', 'ops', cs.archived.id + '.jsonl');
const got = readLogText(jsonl, gzPath(data, cs.archived)); assert.ok(got.fromGz && got.text === orig, 'the archived log reads back byte for byte');
assert.equal(readLogText(path.join(data, 'nope.jsonl'), path.join(data, 'nope.gz')), null);
assert.ok(restoreLog(jsonl, gzPath(data, cs.archived)) && fs.readFileSync(jsonl, 'utf8') === orig && !fs.existsSync(gzPath(data, cs.archived)), 'restore gives the jsonl back and removes the gz');
assert.equal(restoreLog(jsonl, gzPath(data, cs.archived)), false, 'nothing left to restore');
fs.appendFileSync(jsonl, '{"type":"new"}\n');
assert.ok(fs.readFileSync(jsonl, 'utf8').startsWith(orig), 'a new event lands after the old ones');
// a live jsonl is never overwritten by an old gz
fs.writeFileSync(gzPath(data, cs.archived), zlib.gzipSync('stale\n'));
assert.equal(restoreLog(jsonl, gzPath(data, cs.archived)), false); assert.ok(fs.readFileSync(jsonl, 'utf8').startsWith(orig));
// delete of a conversation removes its archive files too
purgeArchive(data, cs.hostOut); assert.ok(!fs.readdirSync(path.join(data, 'logs', 'archive', 'ops')).some((n) => n.startsWith(cs.hostOut.id)));
fs.rmSync(gzPath(data, cs.archived), { force: true });

// ---- the log grows while it is compressed: nothing is deleted, the gz is dropped, the next run retries ----
const big = mk(20, { archived: true }, { text: body(40000) });
state.conversations[big.id] = big;
const f = path.join(data, 'logs', 'ops', big.id + '.jsonl'), p = runRetention({ data, state, now: NOW, busy, testDataDir: null });
await new Promise((r) => setImmediate(r)); fs.appendFileSync(f, '{"type":"late"}\n');
const r2 = await p;
assert.ok(fs.existsSync(f) && fs.readFileSync(f, 'utf8').endsWith('{"type":"late"}\n'), 'the grown log is still there with its last line');
assert.ok(r2.skipped.some((x) => x.id === big.id && /changed/.test(x.reason)) && !fs.existsSync(gzPath(data, big)) && !fs.existsSync(gzPath(data, big) + '.tmp'), 'skipped, no gz or tmp left behind');
const r3 = await runRetention({ data, state, now: NOW, busy }); assert.ok(r3.compressed.some((x) => x.id === big.id), 'the next run compresses it');
assert.equal(readLogText(f, gzPath(data, big)).text.split('\n').filter(Boolean).length, 40001);

// ---- an archive already exists (failed restore beside a fresh jsonl): it is never overwritten, the jsonl stays too ----
const dup = mk(21, { archived: true }, { text: '{"type":"only-new"}\n' }), dupGz = gzPath(data, dup), full = zlib.gzipSync(body(500));
state.conversations[dup.id] = dup; fs.writeFileSync(dupGz, full);
const r4 = await runRetention({ data, state, now: NOW, busy });
assert.ok(r4.skipped.some((x) => x.id === dup.id && /exists/.test(x.reason)) && !r4.compressed.some((x) => x.id === dup.id), 'skipped because the archive exists');
assert.ok(fs.readFileSync(dupGz).equals(full) && fs.existsSync(path.join(data, 'logs', 'ops', dup.id + '.jsonl')), 'the full-history gz is byte-identical, the jsonl is still there');
// a corrupt gz: restore throws (the server then keeps new events in memory, no fresh jsonl) and leaves the gz alone; the read throws too (the server's loadLog catches it)
const bad = { id: uid(22), seat: 'ops' }, badJ = path.join(data, 'logs', 'ops', bad.id + '.jsonl'), badGz = gzPath(data, bad);
fs.writeFileSync(badGz, Buffer.from('not a gzip at all'));
assert.throws(() => restoreLog(badJ, badGz)); assert.ok(!fs.existsSync(badJ) && fs.existsSync(badGz), 'no jsonl created, corrupt gz kept');
assert.throws(() => readLogText(badJ, badGz), 'readLogText throws on a corrupt gz: loadLog in server.mjs must catch it');

fs.rmSync(data, { recursive: true, force: true });
console.log('retention tests passed');
