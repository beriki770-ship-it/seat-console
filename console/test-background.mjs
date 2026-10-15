// Unit tests for background-work tracking: node console\test-background.mjs
// The event shapes are the ones a real seat stream carries (neutral text); the sequence mirrors a real conversation:
// two background agents started, one resumed after a result, completions arriving after the turn's `result`.
import assert from 'node:assert/strict';
import { applyBackground, isActivity, backgroundText } from './background.mjs';

const agent = (id, d) => ({ task_id: id, task_type: 'local_agent', description: d });
const sh = (id, d) => ({ task_id: id, task_type: 'local_bash', description: d });
const seq = [
  { type: 'system', subtype: 'task_started', task_id: 'fg1', tool_use_id: 't0', description: 'foreground command', is_backgrounded: false, task_type: 'local_bash' },
  { type: 'system', subtype: 'task_notification', task_id: 'fg1', status: 'completed', summary: 'foreground command' },
  { type: 'system', subtype: 'background_tasks_changed', tasks: [agent('a1', 'Build part one')] },
  { type: 'system', subtype: 'task_started', task_id: 'a1', description: 'Build part one', is_backgrounded: true, task_type: 'local_agent' },
  { type: 'system', subtype: 'task_progress', task_id: 'a1', usage: { total_tokens: 1 } },
  { type: 'system', subtype: 'background_tasks_changed', tasks: [agent('a1', 'Build part one'), sh('b1', 'Generate draft')] },
  { type: 'system', subtype: 'task_started', task_id: 'b1', owned_by_subagent: true, description: 'Generate draft', is_backgrounded: true, task_type: 'local_bash' },
  { type: 'result', subtype: 'success', result: 'ok' },                               // the turn ends, the list is untouched
  { type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { status: 'completed' } },
  { type: 'system', subtype: 'background_tasks_changed', tasks: [agent('a1', 'Build part one')] },
  { type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed' },
  { type: 'system', subtype: 'task_notification', task_id: 'zz', status: 'completed' }, // unknown id: ignored
  { type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'stopped' },
];
const steps = []; let list = [];
for (const ev of seq) { list = applyBackground(list, ev); steps.push(list.map((t) => t.id).join(',')); }
assert.deepEqual(steps, ['', '', 'a1', 'a1', 'a1', 'a1,b1', 'a1,b1', 'a1,b1', 'a1', 'a1', 'a1', 'a1', '']);
console.log('ok  background list follows real event order, result does not clear it, foreground tasks ignored');

// task_started alone (no list event yet) adds a backgrounded task once; a repeated start does not duplicate
{
  const ev = { type: 'system', subtype: 'task_started', task_id: 'x', is_backgrounded: true, task_type: 'local_agent', description: 'd' };
  let l = applyBackground([], ev); l = applyBackground(l, ev);
  assert.equal(l.length, 1);
  assert.equal(applyBackground(l, { type: 'assistant' }), l);   // other events return the same array: the server compares by identity
  console.log('ok  task_started adds once, other events are identity-preserving');
}
const A = { type: 'local_agent' }, S = { type: 'local_bash' };   // the server keeps {id, type, description}
assert.equal(backgroundText([]), '');
assert.equal(backgroundText([A]), '1 background agent');
assert.equal(backgroundText([A, A]), '2 background agents');
assert.equal(backgroundText([S]), '1 background task');
assert.equal(backgroundText([A, S, S]), '1 background agent, 2 tasks');
console.log('ok  backgroundText');
assert.ok(isActivity({ type: 'assistant' }) && isActivity({ type: 'user' }) && isActivity({ type: 'system', subtype: 'task_progress' }) && isActivity({ type: 'tool_progress' }));
assert.ok(!isActivity({ type: 'result' }) && !isActivity({ type: 'system', subtype: 'init' }) && !isActivity({ type: 'console_user' }));
console.log('ok  isActivity');
