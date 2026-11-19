// Action journal (issue #1): a seat records an external action that is NOT safe to repeat (a message, a post, a payment, a non-idempotent
// API write) BEFORE it runs it and the outcome AFTER. A seat that stops in between (usage limit, crash, Stop, a fresh conversation) leaves an
// OPEN intent: every automatic continuation shows it as an unknown outcome to verify before repeating, the page shows it with Done / Didn't happen.
// One append-only JSONL file per conversation (server: <data>/journal/<convId>.jsonl, handed to the seat as env SEAT_JOURNAL).
//   CLI (the seats):  node journal.mjs intent "<what>" [--check "<how to verify>"]   -> prints the id
//                     node journal.mjs done <id> ["<result>"]  |  node journal.mjs fail <id> ["<error>"]
//                     --journal "<file>" (anywhere) names another conversation's journal instead of SEAT_JOURNAL
//   Library (server): openIntents(file), settle(file, id, outcome, { by, note }), unknownNote(list), withUnknown(text, list), CLI_CMD
// The seat prompt and the notes name this script by its ABSOLUTE path (CLI_CMD), never through an env reference: `$VAR` works in bash but
// not in cmd or PowerShell, and a seat on Windows may run any of them.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// A shell-safe quote for the commands a seat is told to run. POSIX: single quotes (nothing inside is expanded). Windows: double quotes and
// forward slashes, which cmd, PowerShell and Git Bash read the same way (node takes C:/x/y.mjs) for any ordinary path. Limitation: a
// Windows path with % (cmd) or $ / ` (PowerShell, Git Bash) in it is expanded by that shell; keep the console and its data out of such folders.
export const shq = (s, win = process.platform === 'win32') => win ? `"${String(s).replace(/\\/g, '/')}"` : `'${String(s).replace(/'/g, `'\\''`)}'`;
export const CLI_PATH = fileURLToPath(import.meta.url);
export const CLI_CMD = `node ${shq(CLI_PATH)}`;

const ID_RE = /^[0-9a-f]{6}$/, validId = (id) => typeof id === 'string' && ID_RE.test(id);   // the ids intent() makes; any other id (a hand-edited or foreign line) is ignored
// Every complete JSON line with a valid id; a torn line (a write cut off by a crash) is skipped, the lines after it still count.
export function readJournal(file) {
  let raw = ''; try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of raw.split('\n')) { if (!l.trim()) continue; try { const e = JSON.parse(l); if (validId(e?.id)) out.push(e); } catch {} }
  return out;
}
// A file that ends mid-line gets a newline first, so the new entry is never glued to the torn one.
function append(file, entry) {
  let lead = ''; try { const s = fs.statSync(file); if (s.size) { const fd = fs.openSync(file, 'r'), b = Buffer.alloc(1); try { fs.readSync(fd, b, 0, 1, s.size - 1); } finally { fs.closeSync(fd); } if (b[0] !== 10) lead = '\n'; } } catch {}
  fs.appendFileSync(file, lead + JSON.stringify({ ...entry, at: new Date().toISOString() }) + '\n');
}
// Intents with no done/fail after them, oldest first.
export function openIntents(file) {
  const open = new Map();
  for (const e of readJournal(file)) { if (e.t === 'intent') open.set(e.id, { id: e.id, what: e.what || '', check: e.check || '', at: e.at }); else if (e.t === 'done' || e.t === 'fail') open.delete(e.id); }
  return [...open.values()];
}
export function intent(file, what, check) {
  what = String(what || '').trim(); if (!what) throw new Error('intent needs a description of the action');
  const taken = new Set(readJournal(file).map((e) => e.id));
  let id; do id = crypto.randomBytes(3).toString('hex'); while (taken.has(id));
  append(file, { t: 'intent', id, what: what.slice(0, 500), ...(check ? { check: String(check).slice(0, 500) } : {}) });
  return id;
}
// outcome 'done' | 'failed' (the page) or 'fail' (the CLI). Only an OPEN intent can be settled.
export function settle(file, id, outcome, { by = 'agent', note = '' } = {}) {
  const t = outcome === 'done' ? 'done' : outcome === 'fail' || outcome === 'failed' ? 'fail' : null;
  if (!t) throw new Error('outcome must be done or failed');
  if (!validId(id) || !openIntents(file).some((x) => x.id === id)) throw new Error(`no open intent ${id} in this journal`);
  append(file, { t, id, by, ...(note ? { [t === 'done' ? 'result' : 'error']: String(note).slice(0, 500) } : {}) });
}

// The block an automatic continuation carries. list: [{ id, what, check, file? }]; `file` = the intent sits in ANOTHER conversation's
// journal (a fresh project conversation): the record command names that file with --journal. Empty list -> '' (no noise).
export function unknownNote(list, { cli = CLI_CMD, win } = {}) {
  if (!list?.length) return '';
  const cmd = (x, o) => `${cli} ${x.file ? `--journal ${shq(x.file, win)} ` : ''}${o} ${x.id}`;
  return 'UNKNOWN OUTCOME — these external actions were started but never confirmed:\n'
    + list.map((x) => `- [${x.id}] ${x.what}${x.check ? ` (check: ${x.check})` : ''} -> record: ${cmd(x, 'done')} "<result>"  or  ${cmd(x, 'fail')} "<error>"`).join('\n')
    + '\nFor each, verify the real postcondition (the --check) BEFORE repeating it; then record done/fail.';
}
export const withUnknown = (text, list, opts) => { const n = unknownNote(list, opts); return n ? `${text}\n\n${n}` : text; };

// ---- CLI ----
const main = (() => { try { return process.argv[1] ? fs.realpathSync(process.argv[1]) : ''; } catch { return ''; } })();   // never throws on import
if (main && CLI_PATH === main) {
  const rest = process.argv.slice(2), die = (m) => { process.stderr.write('journal: ' + m + '\n'); process.exit(1); };
  const opt = (name) => { const i = rest.indexOf(name); if (i < 0) return ''; const v = rest[i + 1] ?? ''; rest.splice(i, 2); return v; };
  const file = opt('--journal') || process.env.SEAT_JOURNAL, check = opt('--check'), cmd = rest.shift();
  if (!file) die('SEAT_JOURNAL is not set (only a seat started by the Seat Console has a journal)');
  try {
    if (cmd === 'intent') process.stdout.write(intent(file, rest.join(' '), check) + '\n');
    else if (cmd === 'done' || cmd === 'fail') {
      if (!rest[0]) die(`usage: ${cmd} <id> ["<${cmd === 'done' ? 'result' : 'error'}>"]`);
      settle(file, rest[0], cmd, { note: rest.slice(1).join(' ') }); process.stdout.write('ok\n');
    } else die('usage: intent "<what>" [--check "<how to verify>"] | done <id> ["<result>"] | fail <id> ["<error>"]  [--journal "<file>"]');
  } catch (e) { die(e.message); }
}
