// Run: node console/test-project.mjs. The project page only opens folders the Projects page lists.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedDir, handoffHead, gitInfo } from './project.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-')), a = path.join(root, 'a'), b = path.join(root, 'b');
fs.mkdirSync(path.join(a, 'docs'), { recursive: true }); fs.mkdirSync(b);
const dirs = [a];
assert.equal(allowedDir(a, dirs), a);
assert.equal(allowedDir(path.join(a, 'x', '..'), dirs), a, 'a path that resolves to a listed folder is that folder');
for (const bad of [b, root, path.join(a, '..'), path.join(a, '..', 'b'), path.join(a, 'docs'), a + path.sep + '..' + path.sep + 'b', 'a', '', null, undefined, a + '\0', '/etc'])
  assert.equal(allowedDir(bad, dirs), null, String(bad));
fs.writeFileSync(path.join(a, 'docs', 'HANDOFF.md'), Array.from({ length: 40 }, (_, i) => 'line ' + i).join('\n'));
assert.equal(handoffHead(a).text.split('\n').length, 25); assert.equal(handoffHead(a).file, path.join('docs', 'HANDOFF.md'));
assert.equal(handoffHead(b), null);
fs.writeFileSync(path.join(root, 'secret.md'), 'secret'); fs.symlinkSync(path.join(root, 'secret.md'), path.join(b, 'HANDOFF.md'));
assert.equal(handoffHead(b), null, 'a symlink out of the folder is not read');
assert.equal(await gitInfo(a), null, 'not a git repo');
fs.rmSync(root, { recursive: true });
console.log('test-project: all passed');
