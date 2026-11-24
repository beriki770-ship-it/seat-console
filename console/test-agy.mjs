// Run: node console/test-agy.mjs. agents/agy.mjs against a fake agy that replays recorded stream-json:
// agy streams an answer as many text_delta lines and the DONE line carries only the last one, so the adapter must
// accumulate per step (the bug: the console showed "ם פעולה." or nothing while Telegram, reading the result, had it all).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-test-'));
try {
  // the fake agy prints the file named in $AGY_REPLAY
  const fake = path.join(tmp, 'agy.mjs'); fs.writeFileSync(fake, "import fs from 'node:fs'; process.stdout.write(fs.readFileSync(process.env.AGY_REPLAY));\n");   // .mjs: agy.mjs runs it with node (Windows too)
  const run = (replay) => {
    const r = spawnSync(process.execPath, [path.join(HERE, 'agents', 'agy.mjs'), '--session-id', 't1'], { cwd: tmp, encoding: 'utf8', timeout: 15000,
      input: JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n',
      env: { ...process.env, AGY_BIN: fake, AGY_REPLAY: replay, AGENT_STATE: path.join(tmp, 'state') } });
    return r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  };
  const texts = (evs) => evs.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content).filter((b) => b.type === 'text').map((b) => b.text);

  // 1. a real recorded answer (103 lines, ~100 deltas): one assistant text = the whole response
  const rec = run(path.join(HERE, 'fixtures', 'agy-stream.jsonl'));
  const full = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'agy-stream.jsonl'), 'utf8').trim().split('\n').pop()).result.response.trim();
  assert.deepEqual(texts(rec), [full]);
  assert.ok(full.startsWith('The color of') && /\nסיכום: /.test(full));
  const res = rec.find((e) => e.type === 'result');
  assert.equal(res.result, full); assert.equal(typeof res.duration_ms, 'number');

  // 2. text, tools, text (the broken conversation's shape): each text step is its own full message, in order
  const c = 'c1', su = (o) => JSON.stringify({ event: 'step_update', step_update: { conversation_id: c, ...o } });
  const lines = [
    su({ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Let me ' }),
    su({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'check.' }),
    su({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } } }),
    su({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' }, output: 'a' } }),
    su({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'line one\nline ' }),
    su({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'two\nסיכום: ok' }),
    su({ step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '\n' }),
    JSON.stringify({ event: 'result', result: { conversation_id: c, status: 'SUCCESS', response: 'Let me check.line one\nline two\nסיכום: ok' } }),
  ];
  fs.writeFileSync(path.join(tmp, 'multi.jsonl'), lines.join('\n') + '\n');
  const m = run(path.join(tmp, 'multi.jsonl'));
  assert.deepEqual(texts(m), ['Let me check.', 'line one\nline two\nסיכום: ok']);
  assert.ok(m.findIndex((e) => e.message?.content?.[0]?.type === 'tool_use') < m.findIndex((e) => texts([e])[0]?.startsWith('line one')));

  // 3. a step cut off before DONE (agy killed) still shows what streamed
  fs.writeFileSync(path.join(tmp, 'cut.jsonl'), lines.slice(4, 6).join('\n') + '\n');
  assert.deepEqual(texts(run(path.join(tmp, 'cut.jsonl'))), ['line one\nline two\nסיכום: ok']);
  console.log('test-agy: all passed');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
