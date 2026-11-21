// Run: node console/test-project.mjs. The project page only opens folders the Projects page lists.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { allowedDir, convProject, detectProject, handoffHead, gitInfo, newChatCwd } from './project.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-')), a = path.join(root, 'a'), b = path.join(root, 'b');
fs.mkdirSync(path.join(a, 'docs'), { recursive: true }); fs.mkdirSync(b);
const dirs = [a];
assert.equal(allowedDir(a, dirs), a);
assert.equal(allowedDir(path.join(a, 'x', '..'), dirs), a, 'a path that resolves to a listed folder is that folder');
for (const bad of [b, root, path.join(a, '..'), path.join(a, '..', 'b'), path.join(a, 'docs'), a + path.sep + '..' + path.sep + 'b', 'a', '', null, undefined, a + '\0', '/etc'])
  assert.equal(allowedDir(bad, dirs), null, String(bad));
// Move to project: a conversation's own choice wins while that folder is listed; otherwise its cwd decides, deepest listed folder first.
const inner = path.join(a, 'sub'), pdirs = [a, inner, b];
assert.equal(convProject({ cwd: path.join(inner, 'x') }, pdirs), inner, 'cwd in a nested project: the deepest one');
assert.equal(convProject({ cwd: path.join(a, 'docs') }, pdirs), a);
assert.equal(convProject({ cwd: root }, pdirs), null, 'cwd outside every project');
assert.equal(convProject({ cwd: a + 'x' }, pdirs), null, 'a sibling with the same prefix is not inside');
assert.equal(convProject({ cwd: path.join(inner, 'x'), project: b }, pdirs), b, 'moved by hand: listed under the chosen folder');
assert.equal(convProject({ cwd: path.join(inner, 'x'), project: path.join(root, 'gone') }, pdirs), inner, 'chosen folder no longer listed: back to the cwd');
assert.equal(convProject({ cwd: root, project: null }, pdirs), null);
// the endpoint's guard (allowedDir) refuses a dir the Projects page does not list
assert.equal(allowedDir(path.join(a, 'sub', '..', '..'), pdirs), null);
assert.equal(allowedDir(inner, pdirs), inner);
// A new chat's folder from its first message (send() without a picked folder): one named project -> its dir; none or several -> null (the projects root).
const P = '/p', F = [{ name: 'tools/seats', dir: '/p/tools/seats' }, { name: 'apps/shop', dir: '/p/apps/shop' }, { name: 'apps', dir: '/p/apps' }, { name: 'video/pinpoint-promo', dir: '/p/video/pinpoint-promo' }, { name: 'robo-lion/docs', dir: '/p/robo-lion/docs' }, { name: 'robo-lion', dir: '/p/robo-lion' }];
assert.equal(detectProject('seats/docs/HANDOFF.md read it and continue', F), path.resolve(P, 'tools/seats'), 'a path starting with the folder name');
assert.equal(detectProject('look at tools/seats/console/app.js', F), path.resolve(P, 'tools/seats'), 'the relative path');
assert.equal(detectProject('cat /srv/x/Desktop/projects/apps/shop/product/engine/x.ts', F), path.resolve(P, 'apps/shop'), 'an absolute path; the nested folder beats its parent apps');
assert.equal(detectProject('fix the Seats console', F), path.resolve(P, 'tools/seats'), 'a whole-word name, any case');
assert.equal(detectProject('Pinpoint-Promo render', F), path.resolve(P, 'video/pinpoint-promo'));
assert.equal(detectProject('seats and shop both need it', F), null, 'two projects -> root');
assert.equal(detectProject('write a poem', F), null, 'no project -> root');
assert.equal(detectProject('seatsmanager and myseats', F), null, 'part of a longer word is no mention');
assert.equal(detectProject('edit seats.json', F), null, 'a file name is not the project');
assert.equal(newChatCwd({ picked: '/p/apps', text: 'seats/docs/HANDOFF.md', folders: F, root: P }), '/p/apps', 'an explicit pick wins over the message');
assert.equal(newChatCwd({ text: 'seats/docs/HANDOFF.md', folders: F, root: P }), path.resolve(P, 'tools/seats'));
assert.equal(newChatCwd({ text: 'seats and shop', folders: F, root: P }), P, 'ambiguous -> root');
assert.equal(newChatCwd({ text: 'hello', folders: F, root: P }), P, 'no mention -> root');
assert.equal(detectProject('cat /srv/x/Desktop/projects/robo-lion/x.md', F), path.resolve(P, 'robo-lion'), 'a top-level project right after projects/');
assert.equal(detectProject('update the docs', F), path.resolve(P, 'robo-lion/docs'), 'one folder called docs: a word mention is that folder');
assert.equal(detectProject('תמשיך ב-seats', F), path.resolve(P, 'tools/seats'), 'a Hebrew prefix with a hyphen');
assert.equal(detectProject('robo-lion and the-seats', F), path.resolve(P, 'robo-lion'), 'a hyphen after a Latin letter joins the name');
assert.equal(detectProject('', F), null); assert.equal(detectProject(undefined, F), null);
fs.writeFileSync(path.join(a, 'docs', 'HANDOFF.md'), Array.from({ length: 40 }, (_, i) => 'line ' + i).join('\n'));
assert.equal(handoffHead(a).text.split('\n').length, 25); assert.equal(handoffHead(a).file, path.join('docs', 'HANDOFF.md'));
assert.equal(handoffHead(b), null);
fs.writeFileSync(path.join(root, 'secret.md'), 'secret'); fs.symlinkSync(path.join(root, 'secret.md'), path.join(b, 'HANDOFF.md'));
assert.equal(handoffHead(b), null, 'a symlink out of the folder is not read');
assert.equal(await gitInfo(a), null, 'not a git repo');
const run = (...args) => execFileSync('git', ['-C', b, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
run('init', '-q'); fs.writeFileSync(path.join(b, 'f'), 'x'); run('add', 'f'); run('commit', '-qm', 'first\tcommit');
const gi = await gitInfo(b);
assert.equal(gi.commits.length, 1); assert.equal(gi.commits[0].subject, 'first\tcommit'); assert.ok(Math.abs(gi.commits[0].at - Date.now()) < 120e3, 'commit time in ms');
fs.rmSync(root, { recursive: true });
console.log('test-project: all passed');
