// Codex CLI as a console seat. The console drives every seat with claude's stream-json protocol (stdin: user messages + control
// requests, stdout: system/assistant/user/result lines). This adapter speaks that protocol and runs one `codex exec --json` per
// message, resuming the same Codex thread every time, and translates Codex's JSONL events into the console's event shapes.
// seats.json: "codex": { ..., "agent": "codex" }. Login is Codex's own (~/.codex, `codex login`), never the console's.
// Modes (the console's mode select): auto = workspace-write sandbox, ask = read-only sandbox, bypass = no sandbox, no approvals.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2), opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const SID = opt('--session-id') || opt('--resume') || 'codex';
const CODEX = process.env.CODEX_BIN || 'codex';
const CODEX_CMD = /\.m?js$/.test(CODEX) ? [process.execPath, CODEX] : [CODEX];   // a .mjs CODEX_BIN (the offline test's fake CLI) runs under this node
const STATE = path.join(process.env.AGENT_STATE || path.join(os.homedir(), '.seat-console', 'agents'), 'codex-' + SID.replace(/[^\w-]/g, '') + '.json');
const MODE = { auto: 'auto', default: 'ask', manual: 'ask', bypassPermissions: 'bypass' };
let mode = MODE[opt('--permission-mode')] || 'auto';
const model = opt('--model'), role = opt('--append-system-prompt'), effort = opt('--effort');   // effort: the console's slider (low..max); Codex calls it model_reasoning_effort

const out = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: SID }) + '\n');
const readThread = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')).thread || null; } catch { return null; } };
const saveThread = (thread) => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify({ thread })); };
const say = (text) => out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolUse = (id, name, input) => out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id, content, isError) => out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: String(content ?? '').slice(0, 20000), is_error: !!isError }] } });

out({ type: 'system', subtype: 'init', cwd: process.cwd(), model: model || 'codex', agent: 'codex' });

// Codex writes its own limits (5-hour "primary" and weekly "secondary" window, used % + reset) into the thread's session log.
// They go to the console as the same rate_limit_event a Claude seat sends, so the seat gets the meter with its resets, the 90 % warning,
// and multi-sided projects wait for its reset like for any other seat.
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
function sessionLog(thread, dir = path.join(CODEX_HOME, 'sessions'), depth = 0) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of ents.sort((a, b) => b.name.localeCompare(a.name))) {   // newest year/month/day first
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith(thread + '.jsonl')) return p;
    if (e.isDirectory() && depth < 3) { const hit = sessionLog(thread, p, depth + 1); if (hit) return hit; }
  }
  return null;
}
function reportLimits(thread) {
  const f = thread && sessionLog(thread); if (!f) return;
  let rl = null; try { const t = fs.readFileSync(f, 'utf8'); for (const l of t.slice(-200000).split('\n')) if (l.includes('"rate_limits"')) { try { rl = JSON.parse(l).payload?.rate_limits || rl; } catch {} } } catch { return; }
  if (!rl) return;
  const win = (w) => w && typeof w.used_percent === 'number' && w.resets_at ? { utilization: w.used_percent / 100, resetsAt: w.resets_at } : undefined;
  const unifiedWindows = { five_hour: win(rl.primary), seven_day: win(rl.secondary) };
  if (unifiedWindows.five_hour || unifiedWindows.seven_day) out({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows } });
}

const queue = []; let child = null, closing = false;
function next() {
  if (child) return;
  if (!queue.length) { if (closing) process.exit(0); return; }
  const text = queue.shift(), thread = readThread();
  const sandbox = mode === 'bypass' ? ['--dangerously-bypass-approvals-and-sandbox'] : ['-s', mode === 'ask' ? 'read-only' : 'workspace-write'];
  // The seat's role line goes in front of the first message of a thread (codex exec has no system-prompt flag).
  const prompt = !thread && role ? `${role}\n\n${text}` : text;
  const args = ['exec', '--json', '--skip-git-repo-check', ...sandbox, ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort === 'max' ? 'xhigh' : effort}`] : []), ...(thread ? ['resume', thread] : []), '--', prompt];   // '--': a message that starts with '-' is text, never a flag; Codex has no 'max' effort
  let last = '', usage = null, failed = null, stderr = '';
  child = spawn(CODEX_CMD[0], [...CODEX_CMD.slice(1), ...args], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    let e; try { e = JSON.parse(l); } catch { return; }
    const it = e.item;
    if (e.type === 'thread.started' && e.thread_id && e.thread_id !== thread) saveThread(e.thread_id);
    else if (e.type === 'item.started' && it?.type === 'command_execution') toolUse(it.id, 'Bash', { command: it.command });
    else if (e.type === 'item.started' && it?.type === 'file_change') toolUse(it.id, 'Edit', { file_path: (it.changes || []).map((c) => c.path).join(', ') });
    else if (e.type === 'item.started' && it?.type === 'mcp_tool_call') toolUse(it.id, `mcp__${it.server}__${it.tool}`, it.arguments || {});
    else if (e.type === 'item.completed' && it?.type === 'agent_message') { last = it.text || ''; say(last); }
    else if (e.type === 'item.completed' && it?.type === 'command_execution') toolResult(it.id, it.aggregated_output, it.exit_code !== 0 || it.status === 'failed');
    else if (e.type === 'item.completed' && it?.type === 'file_change') toolResult(it.id, (it.changes || []).map((c) => `${c.kind} ${c.path}`).join('\n') + (it.status === 'failed' ? '\n(failed)' : ''), it.status === 'failed');
    else if (e.type === 'item.completed' && it?.type === 'mcp_tool_call') toolResult(it.id, JSON.stringify(it.result ?? it.error ?? ''), !!it.error);
    else if (e.type === 'item.completed' && it?.type === 'web_search') { toolUse(it.id, 'WebSearch', { query: it.query }); toolResult(it.id, 'searched', false); }
    else if (e.type === 'item.completed' && it?.type === 'error') failed = it.message;
    else if (e.type === 'turn.completed') usage = e.usage || {};
    else if (e.type === 'turn.failed') failed = e.error?.message || 'turn failed';
    else if (e.type === 'error') failed = e.message || 'error';
  });
  child.on('close', (code, signal) => {
    child = null; reportLimits(readThread());
    const err = failed || (usage ? null : signal ? `codex stopped (${signal})` : `codex exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' ') || 'no output'}`);
    const limit = !!err && /usage limit|rate.?limit|hit your|quota|429/i.test(err);   // a limit stop: quotawait.mjs resumes this same conversation after the reset
    out({ type: 'result', subtype: err ? 'error_during_execution' : 'success', is_error: !!err, result: err || last, total_cost_usd: 0, ...(limit ? { api_error: 'usage_limit_reached' } : {}),
      usage: usage ? { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0, cache_read_input_tokens: usage.cached_input_tokens || 0 } : undefined });
    next();
  });
  child.on('error', (e) => { failed = 'cannot start codex: ' + e.message; });
}

readline.createInterface({ input: process.stdin }).on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type === 'control_request') {   // the console's own requests: a live mode switch is taken for the next message; anything else is refused politely
    const r = m.request || {};
    if (r.subtype === 'set_permission_mode' && MODE[r.mode]) { mode = MODE[r.mode]; return out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); }
    if (r.subtype === 'interrupt') { child?.kill('SIGTERM'); return out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); }
    return out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'not supported by the codex seat' } });
  }
  if (m.type !== 'user') return;
  const c = m.message?.content, text = typeof c === 'string' ? c : (c || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const images = Array.isArray(c) ? c.filter((b) => b.type === 'image').length : 0;
  queue.push(text + (images ? `\n\n(${images} image(s) were attached in the console; this Codex seat does not receive images yet.)` : '')); next();
}).on('close', () => { closing = true; if (!child && !queue.length) process.exit(0); });   // like claude -p: queued work finishes, then it exits (Stop kills via the signals below)
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => { child?.kill('SIGTERM'); process.exit(0); });
