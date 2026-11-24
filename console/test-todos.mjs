// todos.mjs: add via the CLI (env SEAT_TODOS + SEAT_CONV), fold, comment keeps it open, done closes it once, torn line skipped.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process'; import { fileURLToPath } from 'node:url';
import { readTodos, addTodo, markTodo, parseDue, DEFAULT_DUE_MS } from './todos.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-')), f = path.join(dir, 'todos.jsonl');
try {
  const id = execFileSync(process.execPath, [path.join(HERE, 'todos.mjs'), 'add', 'Open an account at example.com'], { env: { ...process.env, SEAT_TODOS: f, SEAT_CONV: 'conv-1' } }).toString().trim();
  assert.match(id, /^[0-9a-f]{6}$/);
  let [x] = readTodos(f); assert.equal(x.conv, 'conv-1'); assert.equal(x.what, 'Open an account at example.com'); assert.ok(!x.doneAt);
  fs.appendFileSync(f, '{"t":"add","id":"abc'); // torn
  const id2 = addTodo(f, null, 'second'); assert.equal(readTodos(f)[0].id, id2);   // newest first, torn line skipped
  assert.throws(() => markTodo(f, id, 'comment', ''), /empty comment/);
  markTodo(f, id, 'comment', 'which email?'); x = readTodos(f).find((k) => k.id === id); assert.ok(!x.doneAt); assert.equal(x.comments[0].text, 'which email?');
  markTodo(f, id, 'done', 'opened with info@'); x = readTodos(f).find((k) => k.id === id); assert.ok(x.doneAt); assert.equal(x.comments.length, 2);
  assert.throws(() => markTodo(f, id, 'done'), /already done/);
  assert.throws(() => markTodo(f, 'ffffff', 'done'), /no task/);
  assert.throws(() => execFileSync(process.execPath, [path.join(HERE, 'todos.mjs'), 'add', 'x'], { env: { ...process.env, SEAT_TODOS: '' }, stdio: 'pipe' }));
  const now = Date.parse('2026-11-23T10:00:00Z');
  assert.equal(parseDue('+2h', now), '2026-11-23T12:00:00.000Z'); assert.equal(parseDue('+30m', now), '2026-11-23T10:30:00.000Z');
  assert.throws(() => parseDue('tomorrow-ish', now), /cannot read/);
  const id3 = execFileSync(process.execPath, [path.join(HERE, 'todos.mjs'), 'add', 'Sign the form', '--due', '2026-11-24T09:00:00Z'], { env: { ...process.env, SEAT_TODOS: f, SEAT_CONV: 'c' } }).toString().trim();
  x = readTodos(f).find((k) => k.id === id3); assert.equal(x.what, 'Sign the form'); assert.equal(x.due, '2026-11-24T09:00:00.000Z');
  x = readTodos(f).find((k) => k.id === id2); assert.equal(Date.parse(x.due) - Date.parse(x.at), DEFAULT_DUE_MS);   // no --due: one hour
  // dismiss: closed (not done), reason kept, reopen puts it back, errors on repeats
  const id4 = addTodo(f, 'c', 'Cancel the old plan');
  markTodo(f, id4, 'dismiss', 'bought elsewhere'); x = readTodos(f).find((k) => k.id === id4);
  assert.ok(x.dismissedAt); assert.ok(!x.doneAt); assert.equal(x.comments[0].text, 'bought elsewhere');
  assert.throws(() => markTodo(f, id4, 'dismiss'), /already dismissed/); assert.throws(() => markTodo(f, id4, 'done'), /already dismissed/);
  markTodo(f, id4, 'reopen'); x = readTodos(f).find((k) => k.id === id4); assert.ok(!x.dismissedAt && !x.doneAt);
  assert.throws(() => markTodo(f, id4, 'reopen'), /already open/);
  // machine check: exit 0 closes (auto), non-zero stays, timeout/127 = error, 5 errors = broken, the page path cannot set a check
  const { checkTodos, runCheck } = await import('./todos.mjs'), SLOW = `"${process.execPath}" -e "setTimeout(() => {}, 5000)"`, WIN = process.platform === 'win32';   // cmd.exe exits 1 for an unknown command: no 'not found' there   // sh and cmd.exe alike
  const st = { last: {}, errs: {} }, ok = addTodo(f, 'c', 'ok one', null, 'exit 0'), no = addTodo(f, 'c', 'no one', null, 'exit 1'), nf = addTodo(f, 'c', 'bad cmd', null, 'no-such-cmd-xyz'), sl = addTodo(f, 'c', 'slow', null, SLOW);
  assert.equal((await runCheck('exit 3')).code, 3); if (!WIN) assert.equal((await runCheck('no-such-cmd-xyz')).error, 'not found'); assert.equal((await runCheck(SLOW, 200)).error, 'timeout');
  const run = (c) => runCheck(c, 300);
  assert.deepEqual(await checkTodos(f, st, { minAgeMs: 0, run }), [ok]);
  x = readTodos(f).find((k) => k.id === ok); assert.ok(x.doneAt && x.auto); assert.ok(!readTodos(f).find((k) => k.id === no).doneAt);
  assert.equal(st.errs[no], undefined); assert.equal(st.errs[sl], 1); if (!WIN) assert.equal(st.errs[nf], 1);   // plain non-zero is not an error
  const before = st.errs[sl]; assert.deepEqual(await checkTodos(f, st, { run }), []); assert.equal(st.errs[sl], before);   // not due again within 10 min
  for (let i = 0; i < 4; i++) await checkTodos(f, st, { minAgeMs: 0, run });
  assert.ok(readTodos(f).find((k) => k.id === sl).checkBroken); const n = st.errs[sl];
  await checkTodos(f, st, { minAgeMs: 0, run }); assert.equal(st.errs[sl], n);   // broken: no longer run
  // the page's POST can only name done / comment / dismiss / reopen: no check is written by markTodo
  markTodo(f, no, 'comment', 'hi', { check: 'touch /tmp/pwn' }); assert.equal(readTodos(f).find((k) => k.id === no).check, 'exit 1');
  // seat CLI: done / dismiss only from the asking conversation
  const cli = (env, ...a) => execFileSync(process.execPath, [path.join(HERE, 'todos.mjs'), ...a], { env: { ...process.env, SEAT_TODOS: f, ...env }, stdio: 'pipe' }).toString().trim();
  const id5 = cli({ SEAT_CONV: 'cc' }, 'add', 'two words', '--check', 'test -f /nope', '--due', '+1h'); x = readTodos(f).find((k) => k.id === id5); assert.equal(x.check, 'test -f /nope'); assert.equal(x.what, 'two words');
  assert.throws(() => cli({ SEAT_CONV: 'other' }, 'done', id5, 'x')); assert.ok(!readTodos(f).find((k) => k.id === id5).doneAt);
  cli({ SEAT_CONV: 'cc' }, 'done', id5, 'file exists now'); x = readTodos(f).find((k) => k.id === id5); assert.ok(x.doneAt); assert.equal(x.comments[0].text, 'file exists now');
  console.log('test-todos: all passed');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
