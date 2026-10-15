// Remote follower (remote.mjs): byte offsets over chunked ssh output, and the config check that keeps anything but a plain path off the remote command line.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { takeLines, loadRemotes, parseLine } from './remote.mjs';
import { remoteAlive, remoteKill, remoteFile, remoteOutFrom, remoteClean, spawnRemoteHost, sshSocket, setup } from './rhost.mjs';
let ok = 0; const pass = (m) => { ok++; console.log('ok  ' + m); };

{ // one buffer: complete lines with their end offsets, the unfinished last line is held back and not counted
  const t = takeLines(Buffer.from('{"a":1}\n{"b":2}\n{"c":'), 100);
  assert.deepEqual(t.lines, [{ line: '{"a":1}', end: 108 }, { line: '{"b":2}', end: 116 }]);
  assert.equal(t.off, 116); assert.equal(t.rest.toString(), '{"c":');
  pass('complete lines carry the byte offset after them; a partial last line waits');
}
{ // the same bytes in arbitrary chunks (as ssh delivers them, a Hebrew letter split between two chunks) give the same lines and offsets
  const text = '{"t":"שלום"}\n{"t":"x"}\n{"t":"עוד"}\n', all = Buffer.from(text), whole = takeLines(all, 0);
  for (const cut of [1, 7, 9, 10, 14, 20, all.length - 1]) {
    let pending = Buffer.alloc(0), at = 0; const got = [];
    for (const b of [all.subarray(0, cut), all.subarray(cut)]) { const t = takeLines(Buffer.concat([pending, b]), at); pending = t.rest; at = t.off; got.push(...t.lines); }
    assert.deepEqual(got, whole.lines, 'cut at ' + cut); assert.equal(at, all.length);
  }
  pass('chunk boundaries (also inside a multi-byte letter) change nothing');
}
{ // resume: reading again from the stored offset yields exactly the lines after it, none twice
  const all = Buffer.from('l1\nl2\nl3\n'), first = takeLines(all.subarray(0, 5), 0);   // "l1\nl2" -> only l1 counted
  assert.deepEqual(first.lines.map((x) => x.line), ['l1']); assert.equal(first.off, 3);
  const next = takeLines(all.subarray(first.off), first.off);   // what `tail -c +4` returns
  assert.deepEqual(next.lines.map((x) => x.line), ['l2', 'l3']); assert.equal(next.off, all.length);
  pass('a re-read from the stored offset continues exactly after the last counted line');
}
{ // config: anything that could reach the remote shell as more than a path is refused
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-test-')), f = path.join(dir, 'remotes.json'), logs = [];
  try {
    assert.deepEqual(loadRemotes(path.join(dir, 'missing.json'), 'H', (l) => logs.push(l)), []); assert.equal(logs.length, 0, 'missing file is silent');
    const base = { name: 'render-box', target: 'ubuntu@203.0.113.10', identity: '~/.ssh/k', paths: ['~/runs/*-run.jsonl'] };
    fs.writeFileSync(f, JSON.stringify({ remotes: [base, { ...base, name: 'b', paths: ['~/x; rm -rf ~'] }, { ...base, name: 'c', paths: ['$(id)'] }, { ...base, name: 'd', target: 'a@b -oProxyCommand=x' }, { ...base, name: 'Bad Name' }, { ...base, name: 'e', target: '-p22@host' }, base] }));
    const r = loadRemotes(f, 'C:\\Users\\me', (l) => logs.push(l));
    assert.equal(r.length, 1); assert.equal(r[0].identity, 'C:\\Users\\me/.ssh/k'); assert.equal(logs.length, 6, 'each refused entry is logged');
    fs.writeFileSync(f, '{not json'); assert.deepEqual(loadRemotes(f, 'H', (l) => logs.push(l)), []);
    pass('loadRemotes keeps only safe entries (no shell characters, no ssh options in the target, no duplicates)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
{ // a line that is valid JSON but not an event object must be skipped, not crash the server (remoteLine reads ev.type / ev.subtype)
  for (const l of ['null', '42', '"x"', '[]', 'true', '{bad', '']) assert.equal(parseLine(l), null, JSON.stringify(l));
  assert.deepEqual(parseLine('{"type":"result","result":"ok"}'), { type: 'result', result: 'ok' });
  const t = takeLines(Buffer.from('null\n42\n"x"\n{"type":"user"}\n'), 0);   // the offset moves past the skipped lines too
  assert.deepEqual(t.lines.map((x) => parseLine(x.line)), [null, null, null, { type: 'user' }]); assert.equal(t.off, 28);
  pass('parseLine: only JSON objects are events; null / 42 / "x" / [] are skipped and the offset still moves past them');
}
{ // control remotes: control / port / node / claude are checked like the rest; a control remote needs no paths, a read-only one still does
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-test-')), f = path.join(dir, 'remotes.json'), logs = [];
  try {
    const base = { target: 'root@127.0.0.1', identity: 'k' };
    fs.writeFileSync(f, JSON.stringify({ remotes: [
      { ...base, name: 'ctl', control: true, port: 2299, node: '~/node/bin/node', claude: '~/.local/bin/claude' },
      { ...base, name: 'ro' },                                                   // read-only without paths: nothing to do
      { ...base, name: 'p1', control: true, port: '22; id' }, { ...base, name: 'p2', control: true, port: 70000 },
      { ...base, name: 'n1', control: true, node: 'node $(id)' }, { ...base, name: 'n2', control: true, claude: 'claude;id' },
      { ...base, name: 'yes', control: 'yes', paths: ['~/a.jsonl'] }] }));   // only the boolean true grants control
    const r = loadRemotes(f, 'H', (l) => logs.push(l));
    assert.deepEqual(r.map((x) => [x.name, x.control]), [['ctl', true], ['yes', false]]); assert.equal(logs.length, 5);
    assert.equal(r[0].port, 2299); assert.equal(r[0].node, '~/node/bin/node'); assert.equal(r[1].node, 'node'); assert.equal(r[1].claude, 'claude');
    pass('loadRemotes: control needs the boolean true, port / node / claude are checked, a control remote may have no paths');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
await (async () => { // rhost.mjs: nothing unsafe reaches a remote command line; every one of these is refused BEFORE an ssh is started (the target does not exist)
  const r = { name: 'x', target: 'nobody@192.0.2.1', identity: 'none', port: null, control: true, node: 'node', claude: 'claude' };
  for (const [what, run] of [['pid', () => remoteAlive(r, '1; id', 'a')], ['needle', () => remoteAlive(r, 12, 'a b')], 
    ['id', () => remoteClean(r, '../x')], ['id', () => remoteOutFrom(r, 'x y', 0)], ['id', () => spawnRemoteHost(r, { id: 'not-a-uuid', args: [], cwd: '/', token: 't' })], ['port', () => sshSocket(r, '22 -oProxyCommand=x')]])
    await assert.rejects(async () => run(), /refused: unsafe/, what);
  assert.equal(await remoteFile(r, '/home/u', 'a b.png'), 'forbidden'); assert.equal(await remoteFile(r, '/home/u', '/tmp/$(id).png'), 'forbidden'); assert.equal(await remoteFile(r, '/home/u x', 'a.png'), 'forbidden');
  assert.equal(await remoteKill(r, 12, ['$(id)'], true), false); assert.equal(await remoteKill(r, '1;id', ['a'], true), false);   // a kill with unsafe input reports false, never runs
  await assert.rejects(setup({ ...r, control: false }), /read-only/);
  pass('rhost refuses unsafe pid / needle / id / port / path before any ssh, and setup refuses a read-only remote');
})();
console.log(`remote tests passed (${ok})`);
