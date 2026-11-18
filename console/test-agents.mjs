// Run: node console/test-agents.mjs. The Codex / Antigravity adapters (agents/*.mjs) against fake CLIs (fixtures/fake-*.mjs via CODEX_BIN / AGY_BIN):
// the console lines they emit (init, tool_use + tool_result, exactly one result per message), the thread / conversation id saved and reused,
// the role line on the first message only, Codex limits as a rate_limit_event, and the Codex account calls (limits, resets, models).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { readCodexAccount, consumeCodexReset, codexModels } from './agents/codex-account.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), FX = path.join(HERE, 'fixtures');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));

// Sends each message after the previous result (as the console does), then closes stdin; resolves with every line the adapter printed.
function drive(agent, msgs, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(HERE, 'agents', agent + '.mjs'), '--session-id', 'conv-1', '--permission-mode', 'auto', '--append-system-prompt', 'ROLE LINE', ...(env.EFFORT ? ['--effort', env.EFFORT] : [])],
      { cwd: tmp, env: { ...process.env, AGENT_STATE: path.join(tmp, 'state'), ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
    const lines = [], send = () => { const m = msgs.shift(); if (m) p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: m } }) + '\n'); else p.stdin.end(); };
    readline.createInterface({ input: p.stdout }).on('line', (l) => { const e = JSON.parse(l); lines.push(e); if (e.type === 'result') send(); });
    const t = setTimeout(() => { p.kill(); reject(new Error(agent + ': no exit in 20 s')); }, 20000);
    p.on('close', () => { clearTimeout(t); resolve(lines); }); send();
  });
}
const blocks = (lines, type) => lines.flatMap((e) => e.message?.content || []).filter((b) => b.type === type);
const calls = (log) => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// ---- Codex ----
const clog = path.join(tmp, 'codex.log'), cenv = { CODEX_BIN: path.join(FX, 'fake-codex.mjs'), CODEX_HOME: path.join(tmp, 'codex-home'), FAKE_LOG: clog };
let out = await drive('codex', ['first task', 'second task'], cenv);
assert.equal(out[0].type, 'system'); assert.equal(out[0].subtype, 'init'); assert.equal(out[0].agent, 'codex');
assert.ok(out.every((e) => e.session_id === 'conv-1'));
assert.deepEqual(blocks(out, 'tool_use').map((b) => [b.id, b.name, b.input.command]), [['i1', 'Bash', 'ls'], ['i1', 'Bash', 'ls']]);
assert.deepEqual(blocks(out, 'tool_result').map((b) => [b.tool_use_id, b.content, b.is_error]), [['i1', 'a.txt', false], ['i1', 'a.txt', false]]);
let res = out.filter((e) => e.type === 'result');
assert.equal(res.length, 2, 'exactly one result per message');
assert.deepEqual(res.map((r) => [r.is_error, r.result]), [[false, 'done: first task'], [false, 'done: second task']]);
assert.equal(res[0].usage.input_tokens, 10); assert.equal(res[0].usage.cache_read_input_tokens, 2);
const rl = out.find((e) => e.type === 'rate_limit_event');
assert.deepEqual(rl.rate_limit_info.unifiedWindows, { five_hour: { utilization: 0.42, resetsAt: 2000000000 }, seven_day: { utilization: 0.07, resetsAt: 2000500000 } });
assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'codex-conv-1.json'), 'utf8')).thread, 'th-1');
let c = calls(clog);
assert.ok(c[0].includes('workspace-write') && !c[0].includes('resume') && c[0].at(-1) === 'ROLE LINE\n\nfirst task', 'first: role line + no resume');
assert.deepEqual(c[1].slice(-4), ['resume', 'th-1', '--', 'second task'], 'second: resumes the saved thread, no role line');
// a later adapter process (console restart) picks the thread up from the state file
// (a message that starts with '-' stays text after '--'; the console's 'max' effort becomes Codex's 'xhigh')
fs.rmSync(clog); out = await drive('codex', ['-v please'], { ...cenv, EFFORT: 'max' });
c = calls(clog)[0]; assert.deepEqual(c.slice(-4), ['resume', 'th-1', '--', '-v please']); assert.ok(c.includes('model_reasoning_effort=xhigh'), 'max -> xhigh');
// the CLI dies without output: still exactly one result, an error
out = await drive('codex', ['x'], { ...cenv, FAKE_FAIL: 'boom' });
res = out.filter((e) => e.type === 'result'); assert.equal(res.length, 1); assert.equal(res[0].is_error, true); assert.match(res[0].result, /codex exited 1: boom/); assert.equal(res[0].api_error, undefined);
// a limit stop is marked so quotawait.mjs resumes the same conversation after the reset
out = await drive('codex', ['x'], { ...cenv, FAKE_FAIL: "You've hit your usage limit." });
res = out.filter((e) => e.type === 'result'); assert.equal(res.length, 1); assert.equal(res[0].api_error, 'usage_limit_reached');

// ---- Codex account (app-server JSON-RPC) ----
const opts = { bin: cenv.CODEX_BIN };
const acc = await readCodexAccount(opts);
assert.deepEqual(acc.windows, { five_hour: { utilization: 0.4, resetsAt: 2000000000 }, seven_day: { utilization: 0.1, resetsAt: 2000500000 } });
assert.deepEqual(acc.resets.credits.map((x) => [x.id, x.title]), [['c1', 'Reset'], ['c2', 'Reset']], 'only available credits, earliest expiry first');
const used = await consumeCodexReset(null, { ...opts, key: 'gpt' });
assert.equal(used.consumed, 'c1', 'no id: the one that expires first');
assert.equal((await consumeCodexReset('c1', { ...opts, key: 'gpt' })).key, used.key, 'same seat + credit = same idempotency key');
assert.notEqual((await consumeCodexReset('c1', { ...opts, key: 'gpt2' })).key, used.key);
await assert.rejects(readCodexAccount({ bin: path.join(FX, 'fake-agy.mjs'), timeout: 5000 }), /exited|no answer/, 'an app-server that exits early fails fast');
assert.deepEqual(await codexModels(opts), [{ id: 'gpt-x', name: 'GPT X', default: true }]);

// ---- Antigravity ----
const alog = path.join(tmp, 'agy.log'), aenv = { AGY_BIN: path.join(FX, 'fake-agy.mjs'), FAKE_LOG: alog };
out = await drive('agy', ['hello', 'again'], aenv);
assert.equal(out[0].subtype, 'init'); assert.equal(out[0].agent, 'agy');
assert.deepEqual(blocks(out, 'tool_use').map((b) => [b.name, b.input.cmd]), [['run_command', 'ls'], ['run_command', 'ls']], 'one tool_use per step, not per update');
assert.deepEqual(blocks(out, 'tool_result').map((b) => [b.content, b.is_error]), [['a.txt', false], ['a.txt', false]]);
res = out.filter((e) => e.type === 'result');
assert.equal(res.length, 2); assert.deepEqual(res.map((r) => [r.is_error, r.result]), [[false, 'all good'], [false, 'all good']]);
assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'agy-conv-1.json'), 'utf8')).conversation, 'cv-1');
c = calls(alog);
assert.equal(c[0][0], '-p=ROLE LINE\n\nhello'); assert.ok(!c[0].includes('--conversation') && c[0].includes('--sandbox'));
assert.equal(c[1][0], '-p=again'); assert.deepEqual(c[1].slice(-2), ['--conversation', 'cv-1']);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('test-agents: all passed');
