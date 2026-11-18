// A fake `agy` for test-agents.mjs: `-p=<prompt> --output-format stream-json [--conversation <id>]` prints Antigravity-shaped JSONL. argv goes to FAKE_LOG.
import fs from 'node:fs';
const a = process.argv.slice(2), i = a.indexOf('--conversation'), conv = i >= 0 ? a[i + 1] : 'cv-1';
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(a) + '\n');
const p = (event, body) => process.stdout.write(JSON.stringify({ event, [event]: body }) + '\n');
p('step_update', { conversation_id: conv, step_index: 1, step_type: 'tool', tool_name: 'run_command', state: 'RUNNING', tool_info: { parameters: { cmd: 'ls' } } });
p('step_update', { conversation_id: conv, step_index: 1, step_type: 'tool', tool_name: 'run_command', state: 'DONE', tool_info: { parameters: { cmd: 'ls' }, output: 'a.txt' } });
p('step_update', { conversation_id: conv, step_index: 2, step_type: 'agent_response', state: 'DONE', text_delta: 'all good' });
p('result', { conversation_id: conv, status: 'SUCCESS', response: 'all good', usage: { input_tokens: 5, output_tokens: 2 } });
