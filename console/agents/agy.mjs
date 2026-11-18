// Antigravity CLI (agy) as a console seat: the same idea as agents/codex.mjs. The console speaks claude's stream-json; this adapter
// runs one `agy -p=<message> --output-format stream-json [--conversation <id>]` per message and translates agy's
// {"event":"step_update"|"result", ...} lines into the console's assistant / tool_use / tool_result / result lines.
// seats.json: "antigravity": { ..., "agent": "agy" }. Login is agy's own (Google), done once in a terminal.
// Modes: auto = no permission prompts but terminal sandbox, ask = plan mode (no edits), bypass = no prompts, no sandbox.
// (Print mode cannot answer a permission prompt, so auto/bypass must not ask; that is what --dangerously-skip-permissions does.)
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2), opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const SID = opt('--session-id') || opt('--resume') || 'agy';
const AGY = process.env.AGY_BIN || path.join(os.homedir(), '.local', 'bin', 'agy');
const AGY_CMD = /\.m?js$/.test(AGY) ? [process.execPath, AGY] : [AGY];   // a .mjs AGY_BIN (the offline test's fake CLI) runs under this node
const STATE = path.join(process.env.AGENT_STATE || path.join(os.homedir(), '.seat-console', 'agents'), 'agy-' + SID.replace(/[^\w-]/g, '') + '.json');
const MODE = { auto: 'auto', default: 'ask', manual: 'ask', bypassPermissions: 'bypass' };
let mode = MODE[opt('--permission-mode')] || 'auto';
const model = opt('--model'), role = opt('--append-system-prompt'), effort = opt('--effort');

const out = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: SID }) + '\n');
const readConv = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')).conversation || null; } catch { return null; } };
const saveConv = (conversation) => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify({ conversation })); };
const say = (text) => out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolUse = (id, name, input) => out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id, content, isError) => out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: String(content ?? '').slice(0, 20000), is_error: !!isError }] } });

out({ type: 'system', subtype: 'init', cwd: process.cwd(), model: model || 'antigravity', agent: 'agy' });

// Images from the console arrive as base64 blocks; they are written to files the CLI can open.
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
function saveImages(blocks, dir) {
  const imgs = (Array.isArray(blocks) ? blocks : []).filter((b) => b.type === 'image' && b.source?.type === 'base64' && EXT[b.source.media_type]);
  if (!imgs.length) return [];
  fs.mkdirSync(dir, { recursive: true });
  return imgs.map((b, i) => { const p = path.join(dir, `${Date.now()}-${i + 1}.${EXT[b.source.media_type]}`); fs.writeFileSync(p, Buffer.from(b.source.data, 'base64')); return p; });
}
// New images in the CLI's own (hidden) folder are copied into the conversation's folder (generated-images/) after each turn and named in the reply,
// so the console shows them as image cards.
function collectImages(dir, since) {
  let names; try { names = fs.readdirSync(dir); } catch { return []; }
  const outDir = path.join(process.cwd(), 'generated-images'), got = [];
  for (const n of names) {
    const src = path.join(dir, n); let st; try { st = fs.statSync(src); } catch { continue; }
    if (!st.isFile() || st.mtimeMs < since || !/\.(png|jpe?g|webp|gif)$/i.test(n)) continue;
    try { fs.mkdirSync(outDir, { recursive: true }); const dst = path.join(outDir, n); fs.copyFileSync(src, dst); got.push(dst); } catch {}
  }
  return got;
}

const queue = []; let child = null, closing = false;
function next() {
  if (child) return;
  if (!queue.length) { if (closing) process.exit(0); return; }
  const { text, images } = queue.shift(), conv = readConv();
  const withImages = images.length ? `${text}\n\nAttached image(s), open them with view_file before answering:\n${images.join('\n')}` : text;
  const prompt = !conv && role ? `${role}\n\n${withImages}` : withImages;   // the seat's role line rides on the first message (agy -p has no system-prompt flag)
  const perm = mode === 'ask' ? ['--mode', 'plan'] : mode === 'bypass' ? ['--dangerously-skip-permissions'] : ['--dangerously-skip-permissions', '--sandbox'];
  const args = [`-p=${prompt}`, '--output-format', 'stream-json', ...perm, ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []), ...(conv ? ['--conversation', conv] : [])];
  let last = '', done = null, stderr = '', convId = conv;
  const turnAt = Date.now() - 2000;
  const started = new Set();
  child = spawn(AGY_CMD[0], [...AGY_CMD.slice(1), ...args], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    let e; try { e = JSON.parse(l); } catch { return; }
    const b = e[e.event] && typeof e[e.event] === 'object' ? e[e.event] : e;
    if (b.conversation_id && b.conversation_id !== convId) { convId = b.conversation_id; saveConv(convId); }
    if (e.event === 'step_update' && b.step_type === 'tool') {
      const id = `agy-${b.conversation_id || ''}-${b.step_index}`, info = b.tool_info || {};
      if (!started.has(id)) { started.add(id); toolUse(id, b.tool_name || info.name || 'tool', info.parameters || {}); }
      if (b.state === 'DONE' || b.state === 'ERROR' || b.state === 'FAILED') {
        const { parameters, name, ...rest } = info;
        toolResult(id, rest.output ?? rest.result ?? (Object.keys(rest).length ? JSON.stringify(rest) : 'done'), b.state !== 'DONE');
      }
    } else if (e.event === 'step_update' && b.step_type === 'agent_response' && b.state === 'DONE' && b.text_delta?.trim()) { last = b.text_delta.trim(); say(last); }
    else if (e.event === 'result') done = b;
  });
  child.on('close', (code, signal) => {
    child = null;
    const imgs = convId ? collectImages(path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', convId), turnAt) : [];   // agy's own folder for generated images
    if (imgs.length) { const line = imgs.map((p) => `Image: ${p}`).join('\n'); say(line); if (done) done.response = `${(done.response || last).trim()}\n\n${line}`; else last = last ? `${last}\n\n${line}` : line; }
    const ok = done && done.status === 'SUCCESS';
    const err = ok ? null : done?.error || (signal ? `antigravity stopped (${signal})` : `agy exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' ') || 'no output'}`);
    const u = done?.usage || {};
    const limit = !!err && /quota|resource.?exhausted|rate.?limit|usage limit|429/i.test(err);   // a limit stop: resumed on this same seat after the reset (quotawait.mjs)
    out({ type: 'result', subtype: err ? 'error_during_execution' : 'success', is_error: !!err, result: err || (done?.response || last).trim(), total_cost_usd: 0, ...(limit ? { api_error: 'usage_limit_reached' } : {}),
      usage: { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, cache_read_input_tokens: u.cache_read_tokens || 0 } });
    next();
  });
  child.on('error', (e) => { stderr += 'cannot start agy: ' + e.message; });
}

readline.createInterface({ input: process.stdin }).on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type === 'control_request') {
    const r = m.request || {};
    if (r.subtype === 'set_permission_mode' && MODE[r.mode]) { mode = MODE[r.mode]; return out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); }
    if (r.subtype === 'interrupt') { child?.kill('SIGTERM'); return out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); }
    return out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'not supported by the antigravity seat' } });
  }
  if (m.type !== 'user') return;
  const c = m.message?.content, text = typeof c === 'string' ? c : (c || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  queue.push({ text, images: saveImages(c, path.join(process.cwd(), '.console-attachments')) }); next();   // inside the workspace: agy's view_file reads files of the project folder
}).on('close', () => { closing = true; if (!child && !queue.length) process.exit(0); });
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => { child?.kill('SIGTERM'); process.exit(0); });
