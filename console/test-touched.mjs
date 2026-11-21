// Run: node console/test-touched.mjs. Which files a conversation touched (touched.mjs) and when that makes it related to a project.
import assert from 'node:assert/strict';
import { touchedOf, lineTouched, byProject, relatedFor } from './touched.mjs';
const T = (name, input) => touchedOf({ type: 'tool_use', name, input });
// writes: the tools that name their file
assert.deepEqual(T('Edit', { file_path: '/p/a/x.js', old_string: 'a' }), [{ path: '/p/a/x.js', kind: 'w' }]);
assert.deepEqual(T('Write', { file_path: '/p/a/./y.md' }), [{ path: '/p/a/y.md', kind: 'w' }], 'normalised');
assert.deepEqual(T('MultiEdit', { file_path: '/p/a/z' }), [{ path: '/p/a/z', kind: 'w' }]);
assert.deepEqual(T('NotebookEdit', { notebook_path: '/p/a/n.ipynb' }), [{ path: '/p/a/n.ipynb', kind: 'w' }]);
assert.deepEqual(T('write_file', { Path: '/p/b/out.md' }), [{ path: '/p/b/out.md', kind: 'w' }], 'Antigravity write_file');
// reads
assert.deepEqual(T('Read', { file_path: '/p/a/r.txt' }), [{ path: '/p/a/r.txt', kind: 'r' }]);
assert.deepEqual(T('Glob', { pattern: '**/*.js', path: '/p/a/src/' }), [{ path: '/p/a/src', kind: 'r' }], 'Glob path, trailing slash dropped');
assert.deepEqual(T('Glob', { pattern: '/p/a/src/**/*.js' }), [{ path: '/p/a/src', kind: 'r' }], 'Glob with an absolute pattern: the folder before the first glob character');
assert.deepEqual(T('Glob', { pattern: '*.js' }), [], 'relative pattern, no path: nothing known');
assert.deepEqual(T('Grep', { pattern: '/etc/passwd', path: '/p/a/docs/H.md' }), [{ path: '/p/a/docs/H.md', kind: 'r' }], 'Grep: its path, never its pattern');
assert.deepEqual(T('Read', { file_path: 'relative.txt' }), [], 'a relative path has no known base');
// shell: absolute paths only, always reads
assert.deepEqual(T('Bash', { command: 'cd /p/a && git -C "/p/b" status; cat /p/c/f.md > /tmp/out.txt' }).map((x) => x.path), ['/p/a', '/p/b', '/p/c/f.md', '/tmp/out.txt']);
assert.ok(T('Bash', { command: 'echo hi > /p/a/new.md' }).every((x) => x.kind === 'r'), 'no write guessing from a shell line');
assert.deepEqual(T('Bash', { command: 'curl http://127.0.0.1:4850/api/x; ls src/a; ls /p/a/*.js' }).map((x) => x.path), ['/p/a'], 'URLs, relative paths and globs are skipped');
assert.deepEqual(T('Bash', { command: "/bin/bash -lc 'git -C /p/a status\nls /p/b/docs'" }).map((x) => x.path), ['/p/a', '/p/b/docs'], 'Codex wrapper: the script inside, not /bin/bash');
assert.deepEqual(T('Bash', { command: '/bin/bash -lc "cd /p/c\nls"' }).map((x) => x.path), ['/p/c'], 'Codex wrapper with double quotes');
assert.deepEqual(T('run_command', { CommandLine: 'mkdir -p /p/a/research /p/b/.multi/out' }).map((x) => x.path), ['/p/a/research', '/p/b/.multi/out'], 'Antigravity run_command');
assert.deepEqual(T('schedule', { Prompt: 'check /p/a' }), [], 'other tools touch nothing');
assert.deepEqual(touchedOf(null), []);
// log lines: only assistant lines holding a tool_use are parsed
const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'see /p/z' }, { type: 'tool_use', name: 'Edit', input: { file_path: '/p/a/x' } }, { type: 'tool_use', name: 'Read', input: { file_path: '/p/b/y' } }] } });
assert.deepEqual(lineTouched(line), [{ path: '/p/a/x', kind: 'w' }, { path: '/p/b/y', kind: 'r' }]);
assert.deepEqual(lineTouched(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: '/p/a/x' }] } })), [], 'a tool result is no tool call');
assert.deepEqual(lineTouched('{"type":"assistant","tool_use" broken'), [], 'a broken line');
// split over projects: the deepest folder holds a path; a write wins (the Map keeps one kind per path)
const dirs = ['/p/a', '/p/a/sub', '/p/b', '/p/c'];
const split = byProject(new Map([['/p/a/1', 'w'], ['/p/a/sub/2', 'w'], ['/p/ab/3', 'r'], ['/p/b', 'r'], ['/q/4', 'r']]), dirs);
assert.equal(split.total, 5); assert.deepEqual(split.by.get('/p/a'), { w: 1, r: 0 }); assert.deepEqual(split.by.get('/p/a/sub'), { w: 1, r: 0 }); assert.deepEqual(split.by.get('/p/b'), { w: 0, r: 1 }); assert.equal(split.by.has('/p/ab'), false, 'a sibling with the same prefix is not inside');
// relatedness: w >= 2, or r >= 8, or w + r >= 25 % of everything it touched with at least 3
const rel = (by, total, own = '/own', not) => relatedFor({ by: new Map(Object.entries(by)), total }, own, not).map(([d]) => d);
assert.deepEqual(rel({ '/p/a': { w: 2, r: 0 } }, 1000), ['/p/a'], 'two edits');
assert.deepEqual(rel({ '/p/a': { w: 1, r: 7 } }, 1000), [], 'one edit, seven reads, a small share');
assert.deepEqual(rel({ '/p/a': { w: 0, r: 8 } }, 1000), ['/p/a'], 'eight reads');
assert.deepEqual(rel({ '/p/a': { w: 1, r: 2 } }, 12), ['/p/a'], '3 of 12 = 25 %');
assert.deepEqual(rel({ '/p/a': { w: 1, r: 2 } }, 13), [], '3 of 13 < 25 %');
assert.deepEqual(rel({ '/p/a': { w: 0, r: 2 } }, 2), [], 'all of it, but fewer than 3');
assert.deepEqual(rel({ '/p/a': { w: 5, r: 0 } }, 10, '/p/a'), [], 'never related to its own project');
assert.deepEqual(rel({ '/p/a': { w: 5, r: 0 }, '/p/b': { w: 3, r: 0 } }, 10, '/own', ['/p/a']), ['/p/b'], '"Not related" hides that folder only');
console.log('test-touched: all passed');
