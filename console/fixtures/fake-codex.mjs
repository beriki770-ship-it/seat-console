// A fake `codex` for test-agents.mjs: `exec --json ... [resume <thread>] <prompt>` prints Codex-shaped JSONL, `app-server` answers the
// account JSON-RPC calls. Every call's argv goes to FAKE_LOG; FAKE_FAIL=<text> prints it on stderr and exits 1.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const a = process.argv.slice(2);
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(a) + '\n');
if (a[0] === 'app-server') {
  readline.createInterface({ input: process.stdin }).on('line', (l) => {
    const m = JSON.parse(l), say = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
    if (m.method === 'initialize') say({});
    else if (m.method === 'account/rateLimits/read') say({ rateLimits: { primary: { usedPercent: 40, resetsAt: 2000000000 }, secondary: { usedPercent: 10, resetsAt: 2000500000 } },
      rateLimitResetCredits: { credits: [{ id: 'c2', status: 'available', title: 'Reset', expiresAt: 2000900000 }, { id: 'c1', status: 'available', expiresAt: 2000800000 }, { id: 'c0', status: 'used' }] } });
    else if (m.method === 'account/rateLimitResetCredit/consume') say({ consumed: m.params.creditId, key: m.params.idempotencyKey });
    else if (m.method === 'model/list') say({ data: [{ id: 'gpt-x', displayName: 'GPT X', isDefault: true }] });
  });
} else {
  if (process.env.FAKE_FAIL) { process.stderr.write(process.env.FAKE_FAIL + '\n'); process.exit(1); }
  const r = a.indexOf('resume'), thread = r >= 0 ? a[r + 1] : 'th-1', p = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '18'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rollout-${thread}.jsonl`), JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 42, resets_at: 2000000000 }, secondary: { used_percent: 7, resets_at: 2000500000 } } } }) + '\n');
  p({ type: 'thread.started', thread_id: thread });
  p({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls' } });
  p({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', aggregated_output: 'a.txt', exit_code: 0 } });
  p({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'done: ' + a[a.length - 1].split('\n').pop() } });
  p({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3, cached_input_tokens: 2 } });
}
