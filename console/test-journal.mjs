// Run: node console/test-journal.mjs. Action journal (journal.mjs): the CLI round trip through SEAT_JOURNAL, open intents, a person settling
// one, torn lines, the refusal without SEAT_JOURNAL, id validation, and the continuation note (only when something is open) whose record
// command really works in this platform's shell (sh on Linux/macOS, cmd on Windows), also for another conversation's journal (--journal).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { openIntents, settle, readJournal, unknownNote, withUnknown, shq, CLI_PATH, CLI_CMD } from './journal.mjs';
import { RESUME_TEXT } from './quotawait.mjs';

const CLI = CLI_PATH, WIN = process.platform === 'win32';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-')), file = path.join(dir, 'conv.jsonl');
const baseEnv = { PATH: process.env.PATH, ...(WIN ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}) };
const run = (args, env = { SEAT_JOURNAL: file }) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...baseEnv, ...env } });
const ok = (args) => { const r = run(args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
// Runs a note's record command in the platform shell, the way a seat would (execSync: /bin/sh or cmd.exe).
const record = (note, text = 'seen') => execSync(note.match(/record: (.*?) "<result>"/)[1] + ` "${text}"`, { env: { ...baseEnv, SEAT_JOURNAL: file }, encoding: 'utf8' });

// ---- refusal without SEAT_JOURNAL: nothing is written anywhere ----
const no = run(['intent', 'x'], {}); assert.equal(no.status, 1); assert.match(no.stderr, /SEAT_JOURNAL is not set/);
assert.deepEqual(fs.readdirSync(dir), []);

// ---- CLI round trip ----
const a = ok(['intent', 'send the invoice mail to a customer', '--check', 'Sent folder has it']);
assert.match(a, /^[0-9a-f]{6}$/);
const b = ok(['intent', 'post', 'the', 'launch', 'tweet']);   // unquoted words are joined
assert.notEqual(a, b);
assert.deepEqual(openIntents(file).map((x) => [x.id, x.what, x.check]), [[a, 'send the invoice mail to a customer', 'Sent folder has it'], [b, 'post the launch tweet', '']]);
assert.equal(ok(['done', a, 'message-id 123']), 'ok');
assert.deepEqual(openIntents(file).map((x) => x.id), [b]);
const again = run(['done', a]); assert.equal(again.status, 1); assert.match(again.stderr, /no open intent/);   // a settled one cannot be settled twice
assert.equal(run(['fail', 'nope00']).status, 1);
assert.equal(run(['intent']).status, 1, 'an intent needs a description');
assert.equal(run(['bogus']).status, 1);
assert.equal(readJournal(file).find((e) => e.t === 'done').result, 'message-id 123');

// ---- a person settles one (the page: POST /api/journal) ----
settle(file, b, 'failed', { by: 'user' });
assert.deepEqual(openIntents(file), []);
const last = readJournal(file).at(-1); assert.equal(last.t, 'fail'); assert.equal(last.by, 'user');
assert.throws(() => settle(file, b, 'done'), /no open intent/);
const c = ok(['intent', 'charge card']);
assert.throws(() => settle(file, c, 'maybe'), /done or failed/);

// ---- torn lines: a write cut off mid-line is skipped, and the next entry is not glued to it ----
fs.appendFileSync(file, '{"t":"done","id":"' + c);   // crash in the middle of a done line: c stays open
const d = ok(['intent', 'create the GitHub issue']);
assert.deepEqual(openIntents(file).map((x) => x.id), [c, d]);
fs.appendFileSync(file, 'garbage\n\n{not json}\n');
ok(['done', c]);
assert.deepEqual(openIntents(file).map((x) => x.id), [d]);
assert.deepEqual(openIntents(path.join(dir, 'missing.jsonl')), [], 'no journal = nothing open');

// ---- the continuation note: only when something is open ----
assert.equal(unknownNote([]), '');
assert.equal(withUnknown(RESUME_TEXT, []), RESUME_TEXT, 'no open intents: the resume text is unchanged (no noise)');
const resumed = withUnknown(RESUME_TEXT, openIntents(file));
assert.ok(resumed.startsWith(RESUME_TEXT));
assert.match(resumed, /UNKNOWN OUTCOME — these external actions were started but never confirmed:/);
assert.match(resumed, new RegExp(`\\[${d}\\] create the GitHub issue`));
assert.match(resumed, /verify the real postcondition \(the --check\) BEFORE repeating it/);
assert.ok(resumed.includes(`${CLI_CMD} done ${d}`), 'the absolute path of the CLI, no env reference');
assert.doesNotMatch(resumed, /\$SEAT_JOURNAL|%SEAT_JOURNAL|--journal/, 'its own journal: the plain command, nothing shell-specific');
// ...and the command really settles it in this platform's shell
record(resumed); assert.deepEqual(openIntents(file), []);

// ---- another conversation's journal (a fresh project conversation carries its predecessor's open intents): --journal names it ----
const oldFile = path.join(dir, 'old.jsonl'), oid = execFileSync(process.execPath, [CLI, 'intent', 'send mail', '--check', 'Sent folder'], { encoding: 'utf8', env: { ...baseEnv, SEAT_JOURNAL: oldFile } }).trim();
const keep = ok(['intent', 'still open here']);
const other = unknownNote(openIntents(oldFile).map((x) => ({ ...x, file: oldFile })));
assert.ok(other.includes(`${CLI_CMD} --journal ${shq(oldFile)} done ${oid}`), other);
assert.match(other, /\(check: Sent folder\)/);
record(other); assert.deepEqual(openIntents(oldFile), []); assert.deepEqual(openIntents(file).map((x) => x.id), [keep], 'the current journal is untouched');

// ---- quoting: POSIX single quotes (a ' or $ is neither expanded nor breaks the command); Windows double quotes + forward slashes ----
assert.equal(shq("/a/it's $HOME", false), `'/a/it'\\''s $HOME'`);
assert.equal(shq('C:\\Tools\\a b\\journal.mjs', true), '"C:/Tools/a b/journal.mjs"');
const odd = path.join(dir, WIN ? "it's $HOME x" : "it's $HOME `x`"); fs.mkdirSync(odd); const oddFile = path.join(odd, 'j.jsonl');
execFileSync(process.execPath, [CLI, 'intent', 'post'], { encoding: 'utf8', env: { ...baseEnv, SEAT_JOURNAL: oddFile } });
record(unknownNote(openIntents(oddFile).map((x) => ({ ...x, file: oddFile }))));
assert.deepEqual(openIntents(oddFile), [], 'the quoted path reached the right journal');

// ---- ids: only the 6-hex ids intent() makes are read or settled; anything else is ignored ----
const idf = path.join(dir, 'ids.jsonl');
fs.writeFileSync(idf, ['{"t":"intent","id":"ABC123","what":"upper"}', '{"t":"intent","id":"abc1234","what":"long"}', '{"t":"intent","id":"../x","what":"path"}', '{"t":"intent","id":123456,"what":"number"}', '{"t":"intent","id":"0a1b2c","what":"good"}'].join('\n') + '\n');
assert.deepEqual(openIntents(idf).map((x) => x.id), ['0a1b2c']);
assert.throws(() => settle(idf, 'ABC123', 'done'), /no open intent/); assert.throws(() => settle(idf, '0a1b2c\n', 'done'), /no open intent/);
settle(idf, '0a1b2c', 'done'); assert.deepEqual(openIntents(idf), []);

fs.rmSync(dir, { recursive: true, force: true });
console.log('test-journal: all passed');
