// Slim events for the page: size, what is dropped, what stays, on-demand detail.
import assert from 'node:assert/strict';
import { slimEvent, slimEvents, toolDetail, memTrim, memSlim, CLIP_RESULT, CLIP_FIELD } from './slim.mjs';
let ok = 0; const pass = (m) => { ok++; console.log('ok  ' + m); };
const big = 'x'.repeat(50000);
const tu = { type: 'assistant', message: { content: [{ type: 'thinking', thinking: big }, { type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'a.txt', content: big } }], usage: { a: 1 } }, hoff: 5, hgen: 1, ts: 1 };
const tr = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: big }, { type: 'image', source: { data: big } }] }] }, tool_use_result: big, ts: 2 };
{
  const a = slimEvent(tu, 7); assert.equal(a.i, 7); assert.equal(a.message.content.length, 2, 'thinking dropped');
  assert.equal(a.message.content[1].input.content.length, CLIP_FIELD); assert.equal(a.message.content[1].input.file_path, 'a.txt'); assert.equal(a.message.content[1].slim, true);
  assert.equal(a.hoff, undefined); assert.ok(JSON.stringify(a).length < 1500);
  const r = slimEvent(tr, 8); assert.equal(r.message.content[0].content.length, CLIP_RESULT); assert.equal(r.message.content[0].slim, true); assert.equal(r.tool_use_result, undefined);
  assert.ok(JSON.stringify(r).length < 2000); pass('assistant/user events: thinking, usage, tool_use_result dropped; big input/result clipped and flagged');
}
{
  assert.equal(slimEvent({ type: 'system', subtype: 'init', tools: [1, 2] }, 0), null); assert.equal(slimEvent({ type: 'system', subtype: 'task_progress' }, 0), null);
  assert.equal(slimEvent({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }] } }, 0), null, 'thinking-only draws nothing');
  assert.equal(slimEvent({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash' }, 3).tool_name, 'Bash');
  assert.equal(slimEvent({ type: 'console_perm', requestId: 'r', tool: 'Bash', input: { command: 'ls' } }, 4).input.command, 'ls');
  assert.equal(slimEvent({ type: 'result', is_error: false, result: 'ok', total_cost_usd: 1, duration_ms: 5, usage: big }, 5).usage, undefined);
  assert.deepEqual(slimEvents([tu, { type: 'system', subtype: 'init' }, tr], 10).map((e) => e.i), [10, 12]); pass('non-drawn events dropped, approvals/denials/results kept, indexes are positions in the full list');
}
{
  const d = toolDetail([tu, tr], 't1'); assert.equal(d.input.content.length, 50000); assert.equal(toolDetail([tu], 'nope'), null);
  assert.equal(toolDetail([tu, tr], 't1').resultLen, 50000 + 1 + 7); pass('toolDetail returns the full input and the result of one tool call');
}
console.log(`all ${ok} slim tests passed`);
{ const e = memTrim(JSON.parse(JSON.stringify(tu))); assert.equal(e.message.content.length, 2); const u = memTrim(JSON.parse(JSON.stringify(tr))); assert.equal(u.tool_use_result, undefined); console.log('ok  memTrim drops thinking and tool_use_result'); }
{ const copy = (e) => JSON.parse(JSON.stringify(e)), small = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'ok' }, { type: 'image', source: { data: big } }] }] } };
  for (const e of [tu, tr, small]) assert.deepEqual(slimEvent(memSlim(memTrim(copy(e))), 3), slimEvent(memTrim(copy(e)), 3), 'the page copy of a memory copy equals the page copy of the full event');
  const m = memSlim(memTrim(copy(tr))); assert.equal(m.message.content[0].content.length, CLIP_RESULT); assert.ok(JSON.stringify(m).length < 2000);
  assert.equal(memSlim(copy(small)).message.content[0].content, 'ok\n[image]'); assert.equal(memSlim(copy(small)).message.content[0].slim, undefined);
  console.log('ok  memSlim clips memory copies like the page copy (slim flag kept, images -> [image])'); }
