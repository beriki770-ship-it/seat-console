// A stand-in for `claude -p --input-format stream-json --output-format stream-json`: no login, no quota, no network. Used by smoke-fake.mjs
// through the test instance's `--claude` flag. Each user message gets an init, an assistant text and a result; the reply names this
// process's pid, so a test can prove the SAME claude answered before and after a console restart. A message containing "slow" answers after 6 s.
// "journalstop" (action journal) records an intent and stops on the limit. A message containing "perm" first asks the console for a tool permission (control_request can_use_tool, as in ask mode) and answers with the decision.
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const a = process.argv, i = Math.max(a.indexOf('--session-id'), a.indexOf('--resume'));
const session_id = i > 0 ? a[i + 1] : 'fake-session';
const out = (o) => process.stdout.write(JSON.stringify({ ...o, session_id }) + '\n');
let waiting = null;   // a "perm" turn waits here for the console's control_response
let ctxUsed = 0;   // "ctx=320000" in a message: every later reply reports that much context used of a 1M window (auto handoff tests)
const finish = (reply) => {
  out({ type: 'assistant', message: { role: 'assistant', model: 'fake', content: [{ type: 'text', text: reply }], ...(ctxUsed ? { usage: { input_tokens: ctxUsed, output_tokens: 0 } } : {}) } });
  out({ type: 'result', subtype: 'success', is_error: false, result: reply, total_cost_usd: 0, ...(ctxUsed ? { modelUsage: { fake: { contextWindow: 1000000 } } } : {}) });
};
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type === 'control_response' && waiting) { const w = waiting; waiting = null; return w(m.response?.response?.behavior === 'allow'); }
  if (m.type !== 'user') return;
  const text = typeof m.message?.content === 'string' ? m.message.content : (m.message?.content || []).map((b) => b.text || '').join(' ');
  const imgs = (Array.isArray(m.message?.content) ? m.message.content : []).filter((b) => b.type === 'image' && b.source?.data).length;   // attachment tests: image blocks arrive
  const cm = /ctx=(\d+)/.exec(text); if (cm) ctxUsed = +cm[1];
  // The console's auto handoff prompt (rollover.mjs autoHandoffPrompt): append to the named HANDOFF.md and answer with the READY line.
  const hm = /^🧭 Console: context at [\s\S]*?Update (\S+) \(create it/.exec(text);
  if (hm) { fs.mkdirSync(path.dirname(hm[1]), { recursive: true }); fs.appendFileSync(hm[1], `\n## ${new Date().toISOString().slice(0, 10)} (fake claude): handoff at ${ctxUsed} tokens\n- state: demo\n`); out({ type: 'system', subtype: 'init', model: 'fake', cwd: process.cwd() }); return setTimeout(() => finish(`Updated.\nHANDOFF-READY: ${hm[1]}`), 300); }
  const reply = `echo: ${text} (pid ${process.pid})${imgs ? ` [images: ${imgs}]` : ''}`;
  out({ type: 'system', subtype: 'init', model: 'fake', cwd: process.cwd() });
  if (/perm/.test(text)) {
    out({ type: 'control_request', request_id: `perm-${process.pid}-${Date.now()}`, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo fake' } } });
    waiting = (allow) => finish(`${allow ? 'allowed' : 'denied'}: ${reply}`);
    return;
  }
  // "journalstop": records an external action in the console's action journal (env SEAT_JOURNAL / SEAT_JOURNAL_CLI, journal.mjs) and then stops on the limit without its done.
  if (/journalstop/.test(text)) execFileSync(process.execPath, [process.env.SEAT_JOURNAL_CLI, 'intent', 'send the launch mail to the list', '--check', 'the Sent folder has it'], { encoding: 'utf8' });
  // "quotastop": the turn ends on the usage limit like the real CLI (429, usage_limit_reached), resetting one minute from now (UTC).
  if (/quotastop|journalstop/.test(text)) {
    const d = new Date(Date.now() + 60e3), h = d.getUTCHours(), resets = `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'} (UTC)`;
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit" }] }, error: 'rate_limit', api_error_status: 429 });
    return setTimeout(() => out({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, api_error: 'usage_limit_reached', result: `You've hit your session limit · resets ${resets}`, total_cost_usd: 0 }), 200);
  }
  setTimeout(() => finish(reply), /slow/.test(text) ? 6000 : 200);
});
