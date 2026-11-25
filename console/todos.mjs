// The owner's task board: things only the owner can do (open an account, log in, pay, sign, decide) that a seat would otherwise only mention in a
// reply that scrolls away. A seat adds one through SEAT_TODO_CLI; the page lists every open one; ticking it (or sending a comment) posts
// a message back into the conversation that asked for it (server.mjs /api/todo).
// One append-only JSONL file for all conversations (<data>/todos.jsonl, env SEAT_TODOS; the asking conversation = env SEAT_CONV).
//   CLI (the seats):  node todos.mjs add "<what the user has to do, where, why>" [--due <ISO time | +30m | +2h | +1d>]   -> prints the id
//   Library (server): readTodos(file), addTodo(file, conv, what, due), markTodo(file, id, 'done' | 'comment' | 'dismiss' | 'reopen', text), parseDue(s, now)
// No --due = due one hour after it was added (DEFAULT_DUE_MS); the server nags on Telegram once an hour after that (server.mjs todoTick).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const ID_RE = /^[0-9a-f]{6}$/;
export const DEFAULT_DUE_MS = 3600000;
// '+30m' / '+2h' / '+1d' relative to now, or anything Date.parse reads (a time without a zone = this machine's local time). Bad input throws.
export function parseDue(s, now = Date.now()) {
  const r = /^\+(\d+)\s*([mhd])$/i.exec(String(s).trim());
  const ms = r ? now + +r[1] * { m: 60000, h: 3600000, d: 86400000 }[r[2].toLowerCase()] : Date.parse(s);
  if (!Number.isFinite(ms)) throw new Error(`--due: cannot read "${s}" (use +30m, +2h, +1d or 2026-11-24T10:00)`);
  return new Date(ms).toISOString();
}
// Folds the log into tasks, newest first. A torn line (a write cut off by a crash) is skipped, the lines after it still count.
export function readTodos(file) {
  let raw = ''; try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const map = new Map();
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue; let e; try { e = JSON.parse(l); } catch { continue; }
    if (!ID_RE.test(e?.id)) continue;
    if (e.t === 'add') map.set(e.id, { id: e.id, conv: e.conv || null, what: e.what || '', at: e.at, due: e.due || new Date(Date.parse(e.at) + DEFAULT_DUE_MS).toISOString(), ...(typeof e.check === 'string' && e.check ? { check: e.check } : {}), ...(e.kind === 'approval' ? { kind: 'approval' } : {}), comments: [] });
    const x = map.get(e.id); if (!x || e.t === 'add') continue;
    if (['comment', 'done', 'dismiss', 'approve', 'reject'].includes(e.t)) { if (e.text) x.comments.push({ text: e.text, at: e.at, ...(e.src === 'telegram' ? { src: 'telegram' } : {}) }); }   // src: written from a Telegram reply (the page tags it)
    if (e.t === 'done') { x.doneAt = e.at; if (e.auto) x.auto = true; }
    if (e.t === 'approve' || e.t === 'reject') { x.doneAt = e.at; x.outcome = e.t === 'approve' ? 'approved' : 'rejected'; }   // closed like done (nags, lists), labelled by outcome
    if (e.t === 'checkbroken') x.checkBroken = true;
    if (e.t === 'dismiss') x.dismissedAt = e.at;   // closed like done, but "not relevant anymore": never nagged, listed on its own
    if (e.t === 'reopen') { delete x.doneAt; delete x.dismissedAt; delete x.auto; delete x.outcome; }
  }
  return [...map.values()].reverse();
}
function append(file, entry) {
  let lead = ''; try { const s = fs.statSync(file); if (s.size) { const fd = fs.openSync(file, 'r'), b = Buffer.alloc(1); try { fs.readSync(fd, b, 0, 1, s.size - 1); } finally { fs.closeSync(fd); } if (b[0] !== 10) lead = '\n'; } } catch {}
  fs.appendFileSync(file, lead + JSON.stringify({ ...entry, at: new Date().toISOString() }) + '\n');
}
export function addTodo(file, conv, what, due = null, check = null, kind = null) {
  what = String(what || '').trim(); if (!what) throw new Error('add needs a description of what the user has to do');
  const taken = new Set(readTodos(file).map((x) => x.id));
  let id; do id = crypto.randomBytes(3).toString('hex'); while (taken.has(id));
  append(file, { t: 'add', id, ...(conv ? { conv } : {}), what: what.slice(0, 600), ...(due ? { due } : {}), ...(check ? { check: String(check).slice(0, 1000) } : {}), ...(kind === 'approval' ? { kind } : {}) });
  return id;
}
// 'done' / 'dismiss' close an open task (an optional comment / reason rides along); 'comment' needs text and leaves the task open;
// 'reopen' puts a done or dismissed task back on the open list. 'approve' / 'reject' close any task with that outcome (the user's yes/no, also on regular tasks);
// an approval task is never 'done' (the user's yes/no is the only way it closes, or 'dismiss').
export function markTodo(file, id, kind, text = '', opts = {}) {
  text = String(text || '').trim().slice(0, 2000);
  if (!['done', 'comment', 'dismiss', 'reopen', 'approve', 'reject'].includes(kind)) throw new Error('kind must be done, comment, dismiss, reopen, approve or reject');
  const x = readTodos(file).find((k) => k.id === id);
  if (!x) throw new Error(`no task ${id}`);
  if (kind === 'done' && x.kind === 'approval') throw new Error('an approval task closes with approve or reject');
  if ((kind === 'done' || kind === 'dismiss' || kind === 'approve' || kind === 'reject') && (x.doneAt || x.dismissedAt)) throw new Error(x.doneAt ? (x.outcome ? 'already ' + x.outcome : 'already done') : 'already dismissed');
  if (kind === 'reopen' && !x.doneAt && !x.dismissedAt) throw new Error('already open');
  if (kind === 'comment' && !text) throw new Error('empty comment');
  append(file, { t: kind, id, ...(text ? { text } : {}), ...(opts.auto && kind === 'done' ? { auto: true } : {}), ...(opts.src === 'telegram' && kind === 'comment' ? { src: 'telegram' } : {}) });
  const now = new Date().toISOString();
  return { ...x, ...(kind === 'approve' || kind === 'reject' ? { doneAt: now, outcome: kind === 'approve' ? 'approved' : 'rejected' } : kind === 'done' ? { doneAt: now, ...(opts.auto ? { auto: true } : {}) } : kind === 'dismiss' ? { dismissedAt: now } : kind === 'reopen' ? { doneAt: undefined, dismissedAt: undefined, outcome: undefined } : {}) };
}

// ---- machine check (--check "<shell command>"): exit 0 = the step is done, the task closes by itself ----
// /bin/sh -c (cmd.exe /c on Windows). The command comes only from the seat CLI (stored in the add line), never from the page. A check that cannot run (timeout, 127 = command not
// found, spawn error) counts as an error; CHECK_MAX_ERRORS in a row and the check is marked broken and no longer run. A plain non-zero exit
// = "not done yet" and resets the count. state = { last: {id: ms}, errs: {id: n} } lives in the server's memory.
export const CHECK_EVERY_MS = 600000, CHECK_MAX_ERRORS = 5, CHECK_TIMEOUT_MS = 20000;
export function runCheck(cmd, timeoutMs = CHECK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const [sh, args] = process.platform === 'win32' ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${cmd}"`]] : ['/bin/sh', ['-c', cmd]];   // /s: cmd strips exactly these outer quotes (as node's shell: true does)
    execFile(sh, args, { timeout: timeoutMs, maxBuffer: 16384, killSignal: 'SIGKILL', windowsVerbatimArguments: true }, (err) => {
      if (!err) return resolve({ code: 0 });
      if (err.killed || err.signal) return resolve({ code: null, error: 'timeout' });   // output capped = killed too: counts as an error
      resolve(typeof err.code === 'number' ? { code: err.code, error: err.code === 127 || err.code === 9009 ? 'not found' : null } : { code: null, error: String(err.code || 'spawn') });
    });
  });
}
// Runs the checks that are due (never a done / dismissed / broken task, nor one whose conversation lives on a remote: skip(x) = true).
// Returns the ids it closed; the server tells each conversation. minAgeMs 0 = "right now" (before a Telegram nag).
export async function checkTodos(file, state, { now = Date.now(), minAgeMs = CHECK_EVERY_MS, skip = () => false, run = runCheck } = {}) {
  const closed = [];
  for (const x of readTodos(file)) {
    if (!x.check || x.doneAt || x.dismissedAt || x.checkBroken || skip(x)) continue;
    if (state.last[x.id] && now - state.last[x.id] < minAgeMs) continue;
    state.last[x.id] = now;
    const r = await run(x.check);
    if (r.code === 0) { markTodo(file, x.id, 'done', '', { auto: true }); closed.push(x.id); delete state.errs[x.id]; }
    else if (r.error) { state.errs[x.id] = (state.errs[x.id] || 0) + 1; if (state.errs[x.id] >= CHECK_MAX_ERRORS) append(file, { t: 'checkbroken', id: x.id }); }
    else delete state.errs[x.id];
  }
  return closed;
}

// ---- CLI ----
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const [cmd, ...rest] = process.argv.slice(2), file = process.env.SEAT_TODOS;
  const die = (m) => { process.stderr.write('todos: ' + m + '\n'); process.exit(1); };
  if (!file) die('SEAT_TODOS is not set (only a seat started by the Seat Console has a task board)');
  try {
    if (cmd === 'add') {
      const flag = (n) => { const i = rest.indexOf(n); if (i < 0) return null; const v = rest[i + 1]; rest.splice(i, 2); return v ?? ''; };
      const approve = rest.includes('--approve'); if (approve) rest.splice(rest.indexOf('--approve'), 1);   // the user's yes/no before an outward step
      const dueRaw = flag('--due'), check = flag('--check'), due = dueRaw === null ? null : parseDue(dueRaw);
      if (check === '') die('--check needs a command');
      if (approve && check) die('--approve and --check do not mix: only the user closes an approval');
      process.stdout.write(addTodo(file, process.env.SEAT_CONV || null, rest.join(' '), due, check, approve ? 'approval' : null) + '\n');
    } else if (cmd === 'done' || cmd === 'dismiss') {   // a seat closes its own task: only from the conversation that asked for it
      const [id, ...why] = rest, x = readTodos(file).find((k) => k.id === id);
      if (!x) die(`no task ${id}`);
      if (!x.conv || x.conv !== process.env.SEAT_CONV) die('that task was not added by this conversation');
      markTodo(file, id, cmd, why.join(' '), {});
      process.stdout.write('ok\n');
    } else die('usage: add "<what the user has to do, where, why>" [--due +2h | 2026-11-24T10:00] [--check "<command that exits 0 when done>"] [--approve = a yes/no for the user, closes only with their Approve/Reject] | done <id> "<how verified>" | dismiss <id> "<why>"');
  } catch (e) { die(e.message); }
}
