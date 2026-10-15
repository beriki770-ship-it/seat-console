// Unit tests for the host/reattach logic: node console\test-host.mjs (uses a fake claude, no quota, no server).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paths, pidAlive, readOutFrom, readJson, spawnHost, connectHost, stopHost } from './hostlink.mjs';
import { markInterrupted } from './recovery.mjs';
import { isOurs, ownership, hostNeedle, guardedKillers } from './procid.mjs';
import { crashWarnDue } from './recovery.mjs';
import { crashLoop } from './recovery.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-host-test-'));
const fake = path.join(dir, 'fake-claude.mjs');
fs.writeFileSync(fake, `import readline from 'node:readline';
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  console.log(JSON.stringify({ echo: l }));
  if (l.includes('slow')) setTimeout(() => console.log(JSON.stringify({ late: 1 })), 600);
  if (l.includes('quit')) process.exit(3);
});`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 5000) => { for (let t = 0; t < ms; t += 50) { if (f()) return true; await sleep(50); } return false; };
const start = (name) => spawnHost({ base: path.join(dir, name), script: path.join(HERE, 'host.mjs'), exe: process.execPath, args: [fake], cwd: dir, env: process.env, token: 'tok-' + name });
let ok = 0; const pass = (m) => { ok++; console.log('ok  ' + m); };

// 1. markInterrupted keeps conversations whose host is alive, flips the others
{
  const st = { conversations: { a: { id: 'a', working: true }, b: { id: 'b', working: true }, c: { id: 'c', working: false } } };
  assert.equal(markInterrupted(st, new Set(['a'])), true);
  assert.equal(st.conversations.a.working, true); assert.ok(!st.conversations.a.interrupted);
  assert.equal(st.conversations.b.working, false); assert.equal(st.conversations.b.interrupted, true);
  assert.equal(markInterrupted({ conversations: {}, cleanShutdown: true }), false);
  pass('markInterrupted skips live hosts');
}
// 2. readOutFrom: complete lines only, offsets are byte offsets (UTF-8), resume works
{
  const f = path.join(dir, 'o'); fs.writeFileSync(f, 'a\nשלום\npartial');
  const r = readOutFrom(f, 0);
  assert.deepEqual(r.lines.map((x) => x.line), ['a', 'שלום']); assert.equal(r.end, Buffer.byteLength('a\nשלום\n'));
  assert.deepEqual(readOutFrom(f, 2).lines.map((x) => x.line), ['שלום']);
  assert.deepEqual(readOutFrom(path.join(dir, 'missing'), 7), { lines: [], end: 7 });
  pass('readOutFrom byte offsets, partial line held back, missing file');
}
// 3. host round trip, server "dies" (connection dropped) mid-turn, host keeps running, reconnect replays only what is new
{
  const info = await start('h1'); const p = paths(path.join(dir, 'h1'));
  assert.ok(pidAlive(info.pid) && pidAlive(info.claudePid));
  const got = []; let off = 0;
  const l1 = connectHost(info, 0, { onLine: (l, e) => { got.push(l); off = e; } });
  await l1.ready;
  l1.write('hello\n'); l1.write('slow turn\n');
  assert.ok(await until(() => got.length >= 2)); assert.equal(JSON.parse(got[0]).echo, 'hello');
  l1.close();                                   // server crash: the socket just goes away
  await sleep(1000);                            // the "late" line is produced while nobody is connected
  assert.ok(pidAlive(info.pid), 'host survives a dropped server');
  assert.equal(readOutFrom(p.out, off).lines.map((x) => x.line).join(), '{"late":1}', 'output kept on disk for a dead/absent server');
  const again = []; const l2 = connectHost(info, off, { onLine: (l) => again.push(l) });
  await l2.ready; assert.ok(await until(() => again.length >= 1)); assert.deepEqual(again, ['{"late":1}'], 'reconnect replays from the offset only');
  l2.write('after\n'); assert.ok(await until(() => again.length === 2)); assert.equal(JSON.parse(again[1]).echo, 'after');
  pass('host survives server loss, replay from offset, input after reattach');
  // wrong token is refused
  const bad = connectHost({ ...info, token: 'nope' }, 0, { timeout: 1500 });
  await assert.rejects(bad.ready); pass('wrong token refused');
  // claude exits -> onExit, host exits, exit file written
  let ex = null; l2.close();
  const l3 = connectHost(info, 1e15, { onExit: (c, e) => { ex = [c, e]; } }); await l3.ready; l3.write('quit\n');
  assert.ok(await until(() => ex)); assert.equal(ex[0], 3);
  assert.ok(await until(() => !pidAlive(info.pid))); assert.equal(readJson(p.exit).code, 3);
  pass('claude exit reported, host exits, exit file written');
}
// 4. a host started by a process that then exits is NOT a child that dies with it
{
  const code = `import {spawnHost} from ${JSON.stringify('file:///' + path.join(HERE, 'hostlink.mjs').replace(/\\/g, '/'))};
    const i = await spawnHost({base:${JSON.stringify(path.join(dir, 'h2'))},script:${JSON.stringify(path.join(HERE, 'host.mjs'))},exe:process.execPath,args:[${JSON.stringify(fake)}],cwd:${JSON.stringify(dir)},env:process.env,token:'t2'});
    console.log(JSON.stringify(i));`;
  const info = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }).trim());
  await sleep(800); // the spawning node has exited by now
  assert.ok(pidAlive(info.pid) && pidAlive(info.claudePid), 'host and claude outlive the process that spawned them');
  // 5. stopHost kills claude and the host
  assert.equal(await stopHost(info), true);
  assert.ok(await until(() => !pidAlive(info.pid) && !pidAlive(info.claudePid)));
  assert.equal(await stopHost(info), false, 'stopHost on a dead host reports false');
  pass('host outlives its spawner; stopHost kills claude + host');
}
// 6. a claude that cannot start fails spawnHost with its error
{
  await assert.rejects(spawnHost({ base: path.join(dir, 'h3'), script: path.join(HERE, 'host.mjs'), exe: path.join(dir, 'nope.exe'), args: [], cwd: dir, env: process.env, token: 't3' }), /ENOENT/);
  pass('spawn failure surfaces');
}
// Finding 3: pid reuse. A fake process table: pid 10 is really this conversation's host, pid 11 is the same pid number reused by someone else's node, pid 12 is its claude, 13 is a reused claude pid.
{
  const base = path.join('C:', 'x', 'logs', 'ops', 'abc-123');
  const table = new Map([[10, 'node.exe C:\c\host.mjs ' + base + '.host-cfg.json'], [11, 'node.exe server.js --other'], [12, 'claude.exe -p --resume sess-1'], [13, 'claude.exe -p --resume other-session']]);
  const lookup = async (pid) => table.get(pid) ?? null;
  assert.equal(hostNeedle(base), 'abc-123.host-cfg.json');
  assert.equal(await isOurs(10, hostNeedle(base), lookup), true); assert.equal(await isOurs(11, hostNeedle(base), lookup), false); assert.equal(await isOurs(99, hostNeedle(base), lookup), false, 'no such process');
  assert.equal(await isOurs(10, '', lookup), false, 'no marker: refuse');
  assert.equal(await isOurs(10, 'x', async () => { throw new Error('wmi down'); }), false, 'query failure: treated as dead, not killed');
  const killed = []; const k = guardedKillers({ taskkill: async (a) => killed.push(a.join(' ')), lookup });
  await k.killHost(11, base); await k.killClaude(13, 'sess-1'); await k.killClaudeTree(13, 'sess-1'); await k.killHost(99, base);
  assert.deepEqual(killed, [], 'reused pids are never killed');
  await k.killHost(10, base); await k.killClaude(12, 'sess-1'); await k.killClaudeTree(12, 'sess-1');
  assert.equal(killed.length, 3); assert.ok(killed[0].includes('PID eq 10') && killed[1].includes('PID eq 12') && killed[2].includes('/PID 12 /T'));
  pass('procid: kills only pids whose command line carries this conversation (fake process table)');
}
{ // review findings: a failed WMI query is not "dead"
  let calls = 0; const flaky = async () => (++calls === 1 ? undefined : 'node host.mjs x.host-cfg.json');
  assert.equal(await ownership(5, 'x.host-cfg.json', flaky), 'yes'); assert.equal(calls, 2, 'one retry after a failed query');
  assert.equal(await ownership(5, 'n', async () => undefined), 'unknown', 'failed twice: unknown, not no');
  const killed = [], logs = []; const k = guardedKillers({ taskkill: async (a) => killed.push(a.join(' ')), lookup: async () => undefined, created: async () => 1000, log: (l) => logs.push(l) });
  await k.killHost(7, 'a/b', 2000); await k.killClaude(8, ['s1'], 1000); await k.killClaudeTree(9, ['s1'], 5000);
  assert.equal(killed.length, 3, 'unknown + alive + created no later than the spawn record: kills, with the image-name filter');
  assert.ok(killed[0].includes('IMAGENAME eq node.exe') && killed[1].includes('IMAGENAME eq claude.exe') && killed[2].includes('IMAGENAME eq claude.exe'));
  { // review finding: unknown ownership must not kill a reused pid
    const kl = [], lg = []; const mk = (created) => guardedKillers({ taskkill: async (a) => kl.push(a.join(' ')), lookup: async () => undefined, created, log: (l) => lg.push(l) });
    await mk(async () => 3000).killClaude(8, ['s1'], 2000); assert.equal(kl.length, 0, 'process newer than the spawn record = a reused pid: skipped');
    await mk(async () => null).killHost(8, 'a/b', 2000); assert.equal(kl.length, 0, 'no such process: nothing to kill');
    await mk(async () => undefined).killClaude(8, ['s1'], 2000); assert.equal(kl.length, 0, 'creation time unavailable: skipped');
    await mk(async () => 1000).killClaude(8, ['s1']); assert.equal(kl.length, 0, 'no spawn time recorded: skipped');
    assert.equal(lg.length, 4); assert.ok(lg.every((l) => l.includes('[kill] SKIPPED')), 'every skip is logged');
    await mk(async () => 1000).killClaude(8, ['s1'], 2000); assert.equal(kl.length, 1, 'older than the spawn record: killed');
  }
  const k2 = guardedKillers({ taskkill: async (a) => killed.push(a.join(' ')), lookup: async () => 'claude.exe --resume spawn-id' }); killed.length = 0;
  await k2.killClaude(8, ['new-id', 'spawn-id']); assert.equal(killed.length, 1, 'session id drifted since spawn: the spawn-time id still matches');
  await k2.killClaude(8, ['new-id']); assert.equal(killed.length, 1, 'no needle matches: a reused pid is left alone');
  const src = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.ok(!/isOurs/.test(src), 'reattach must not depend on the WMI lookup');
  { const st = {}; const T = 1e12; // review finding: the supervisor restarts ~6/min, the warning must not follow
    assert.equal(crashWarnDue(st, T), true); assert.equal(st.lastCrashWarnAt, T, 'persisted in state');
    for (let i = 1; i <= 12; i++) assert.equal(crashWarnDue(st, T + i * 10000), false, 'restarts within 30 min: no second warning');
    assert.equal(crashWarnDue(st, T + 29 * 60000), false); assert.equal(crashWarnDue(st, T + 31 * 60000), true, '30 min later: again'); }
  assert.equal(crashLoop({ lastExit: 'uncaught', lastStartAt: 1000 }, 30000), true); assert.equal(crashLoop({ lastExit: 'uncaught', lastStartAt: 1000 }, 90000), false); assert.equal(crashLoop({ lastStartAt: 1000 }, 2000), false);
  pass('procid: failed WMI query retried, then falls back to the filtered kill; drifted session id; no isOurs at reattach; crash loop detection');
}
{ // the real WMI query on this machine: our own process answers, a nonsense pid does not
  const { cmdlineOf } = await import('./procid.mjs');
  const mine = await cmdlineOf(process.pid); assert.ok(mine && mine.includes('test-host.mjs'), 'own command line: ' + mine);
  assert.equal(await cmdlineOf(4194300), null); pass('cmdlineOf: real Get-CimInstance answers for this pid, null for a missing one');
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(`all ${ok} host tests passed`);
