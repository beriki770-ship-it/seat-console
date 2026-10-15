// A stand-in for `claude -p --input-format stream-json --output-format stream-json`: no login, no quota, no network. Used by smoke-fake.mjs
// through the test instance's `--claude` flag. Each user message gets an init, an assistant text and a result; the reply names this
// process's pid, so a test can prove the SAME claude answered before and after a console restart. A message containing "slow" answers after 6 s.
// A message containing "perm" first asks the console for a tool permission (control_request can_use_tool, as in ask mode) and answers with the decision.
import readline from 'node:readline';

const a = process.argv, i = Math.max(a.indexOf('--session-id'), a.indexOf('--resume'));
const session_id = i > 0 ? a[i + 1] : 'fake-session';
const out = (o) => process.stdout.write(JSON.stringify({ ...o, session_id }) + '\n');
let waiting = null;   // a "perm" turn waits here for the console's control_response
const finish = (reply) => {
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: reply, total_cost_usd: 0 });
};
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type === 'control_response' && waiting) { const w = waiting; waiting = null; return w(m.response?.response?.behavior === 'allow'); }
  if (m.type !== 'user') return;
  const text = typeof m.message?.content === 'string' ? m.message.content : (m.message?.content || []).map((b) => b.text || '').join(' ');
  const reply = `echo: ${text} (pid ${process.pid})`;
  out({ type: 'system', subtype: 'init', model: 'fake', cwd: process.cwd() });
  if (/perm/.test(text)) {
    out({ type: 'control_request', request_id: `perm-${process.pid}-${Date.now()}`, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo fake' } } });
    waiting = (allow) => finish(`${allow ? 'allowed' : 'denied'}: ${reply}`);
    return;
  }
  setTimeout(() => finish(reply), /slow/.test(text) ? 6000 : 200);
});
