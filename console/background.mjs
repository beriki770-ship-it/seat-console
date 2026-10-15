// Background work of one claude process, read from its stream-json events (shapes taken from real logs, 2026-10-13).
// After a `result` the CLI keeps working while background agents / shell tasks run, and starts new turns by itself when they finish,
// so "the turn ended" does not mean "the conversation is idle".
//   system/background_tasks_changed {tasks:[{task_id, task_type:'local_agent'|'local_bash', description}]}  = the full running list (authoritative)
//   system/task_started {task_id, is_backgrounded, task_type, description}                                  = a task begins (only is_backgrounded:true counts)
//   system/task_notification {task_id, status}  and  system/task_updated {task_id, patch:{status}}          = a task ended (completed|failed|stopped)
const keep = (t) => ({ id: t.task_id, type: t.task_type, description: t.description || '' });

// Returns the new list (same array when nothing changed).
export function applyBackground(list, ev) {
  if (ev.type !== 'system') return list;
  if (ev.subtype === 'background_tasks_changed') return (ev.tasks || []).map(keep);
  if (ev.subtype === 'task_started' && ev.is_backgrounded && !list.some((t) => t.id === ev.task_id)) return [...list, keep(ev)];
  const ended = ev.subtype === 'task_notification' || (ev.subtype === 'task_updated' && ev.patch?.status && ev.patch.status !== 'running');
  if (ended && list.some((t) => t.id === ev.task_id)) return list.filter((t) => t.id !== ev.task_id);
  return list;
}

// Events that prove the process is still busy (a tool call, its result, a task heartbeat).
export const isActivity = (ev) => ev.type === 'assistant' || ev.type === 'user' || ev.type === 'tool_progress' || (ev.type === 'system' && /^(task_|background_tasks|thinking_tokens)/.test(ev.subtype || ''));

// "2 background agents" / "1 background task" (shell tasks only) / "1 background agent, 2 tasks"
export function backgroundText(list) {
  const a = list.filter((t) => t.type === 'local_agent').length, s = list.length - a, pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (!list.length) return '';
  return a && s ? `${pl(a, 'background agent')}, ${pl(s, 'task')}` : a ? pl(a, 'background agent') : pl(s, 'background task');
}
