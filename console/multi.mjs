// Multi-sided projects: one brief -> a planner turn on the owner seat writes PLAN.md + .multi/plan.json -> the user approves -> each task runs
// as its own conversation on the seat FIXED for its discipline (disciplines.json) -> dependent tasks start when their inputs are done ->
// the owner seat runs a final integration turn. Shared state: <project>/.multi/tasks.json (written by the console only) and
// <project>/.multi/out/<task>.md (written by each seat when its task is done).
// HARD RULE (each seat is its own account with its own usage limit): the seat of a task is disciplines[task.discipline], nothing else. A seat at its usage limit makes its tasks WAIT
// for the reset; there is no code path that picks another seat. test-multi.mjs proves it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { withUnknown } from './journal.mjs';

export const MARGIN_MS = 2 * 60e3;   // start this long after the reset (as quotawait.mjs)
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function loadDisciplines(file, seats) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const map = j.disciplines || {};
  for (const [d, s] of Object.entries(map)) if (!Object.hasOwn(seats, s)) throw new Error(`disciplines.json: ${d} -> unknown seat ${s}`);
  if (!Object.hasOwn(seats, j.owner)) throw new Error('disciplines.json: unknown owner seat ' + j.owner);
  return { map, owner: j.owner };
}

// The ONLY way a task gets a seat.
export function seatFor(map, discipline) {
  if (!Object.hasOwn(map, discipline)) throw new Error('unknown discipline: ' + discipline);
  return map[discipline];
}

// Epoch ms until which the seat is at a usage limit (a window at >= 99 % that has not reset yet), else 0.
export function blockedUntil(windows, now = Date.now()) {
  const full = Object.values(windows || {}).filter((w) => typeof w?.resetsAt === 'number' && w.resetsAt * 1000 > now && (w.utilization ?? 0) >= 0.99);
  return full.length ? Math.max(...full.map((w) => w.resetsAt * 1000)) + MARGIN_MS : 0;
}

// plan.json -> tasks. Any "seat" the planner wrote is ignored: the seat comes from the discipline map.
// models: { seat: [{ id, name }] } -- a task's "model" is kept only when its own seat offers it (else the seat's default).
export function validatePlan(raw, map, models = {}) {
  const list = Array.isArray(raw) ? raw : raw?.tasks;
  if (!Array.isArray(list) || !list.length) throw new Error('plan has no tasks');
  const ids = new Set();
  const tasks = list.map((t, i) => {
    const id = String(t?.id || ''); if (!ID_RE.test(id)) throw new Error(`task ${i + 1}: bad id "${id}" (a-z, 0-9, -)`);
    if (ids.has(id)) throw new Error('duplicate task id ' + id); ids.add(id);
    const discipline = String(t.discipline || '').toLowerCase();
    if (!Object.hasOwn(map, discipline)) throw new Error(`task ${id}: unknown discipline "${t.discipline}" (allowed: ${Object.keys(map).join(', ')})`);
    if (typeof t.brief !== 'string' || !t.brief.trim()) throw new Error(`task ${id}: empty brief`);
    return { id, title: String(t.title || id).slice(0, 120), discipline, seat: seatFor(map, discipline), deps: Array.isArray(t.deps) ? t.deps.map(String) : [], brief: t.brief.trim(), model: (models[seatFor(map, discipline)] || []).some((m) => m.id === t.model) ? t.model : null, status: 'pending', conv: null };
  });
  for (const t of tasks) for (const d of t.deps) if (!ids.has(d)) throw new Error(`task ${t.id}: unknown dependency ${d}`);
  const seen = new Set(), walk = (t, stack) => {   // cycle check
    if (stack.has(t.id)) throw new Error('dependency cycle at ' + t.id);
    if (seen.has(t.id)) return; stack.add(t.id);
    for (const d of t.deps) walk(tasks.find((x) => x.id === d), stack);
    stack.delete(t.id); seen.add(t.id);
  };
  for (const t of tasks) walk(t, new Set());
  return tasks;
}

export const planPrompt = (p, map, models = {}) => `You are the PLANNER of a multi-sided project. Do NOT build anything in this turn.

Project: ${p.name}
Project folder: ${p.dir}

Brief from the user:
${p.brief}

Split the work into tasks. Every task gets exactly one discipline from this list (each discipline runs on its own fixed seat, in parallel):
${Object.entries(map).map(([d, s]) => `- ${d} (seat ${s})`).join('\n')}

Models each seat can run (pick per task, field "model", the id before the colon):
${[...new Set(Object.values(map))].map((s) => `- ${s}: ${(models[s] || []).map((m) => `${m.id}: ${m.name}`).join(' | ') || 'its default only'}`).join('\n')}
Choose the MOST SUITABLE model for each task, not always the biggest: the strongest model for hard design, architecture, tricky logic or long integration; a mid model for routine building; the fast/cheap one for simple copy, renames or checks. Leave "model" out to use the seat's default.

Write two files:
1. ${path.join(p.dir, 'PLAN.md')}: the plan for the user, short: goal, the tasks (id, discipline, what it produces, depends on), how the parts fit together, how the end result is verified.
2. ${path.join(p.dir, '.multi', 'plan.json')}: {"tasks":[{"id":"kebab-id","title":"...","discipline":"<one of the list>","deps":["ids this task needs finished first"],"model":"<optional: a model id of that seat>","brief":"..."}]}
   Each "brief" must be SELF-CONTAINED: the seat that runs it sees only that brief and the files in the project folder. Name exact files/folders it owns, the interfaces it must match, and what "done" means.
   Keep tasks few and big (one per discipline is often enough); add a dependency only when a task really needs another's output.

Then end your reply with a 3-line summary of the plan. The user approves it before anything runs.`;

export const planFixPrompt = (err) => `The console could not use .multi/plan.json: ${err}\nFix .multi/plan.json (and PLAN.md if needed) and reply with a short summary. Do not build anything yet.`;

export const taskPrompt = (p, t) => `You are one seat in the multi-sided project "${p.name}". Other seats work on the other tasks in parallel.

Project folder: ${p.dir}
Project brief (context only):
${p.brief}

YOUR TASK: ${t.id}: ${t.title} (discipline: ${t.discipline})
${t.brief}
${t.deps.length ? `\nInputs: these tasks are done, read their notes first: ${t.deps.map((d) => path.join('.multi', 'out', d + '.md')).join(', ')}\n` : ''}${t.fresh ? `\nThis task already ran in an earlier conversation that grew too long and was closed to save quota. Do NOT start over: read ${path.join('.multi', 'out', t.id + '.progress.md')} and what is already on disk, then continue from there.\n` : ''}
Token budget (the usage limit is shared, keep this conversation SHORT):
- Hand heavy reading, searching and long command output to subagents and take back only their short conclusion; never paste big files or logs into this conversation.
- Work in few, large steps; no exploratory chatter, no re-reading files you already know.
- After each milestone, overwrite ${path.join(p.dir, '.multi', 'out', t.id + '.progress.md')} with 5-10 lines: done so far, next step, open questions. The console may move this task to a fresh conversation when this one grows; that file is how it continues.
Rules:
- Do only this task. Do not change files another task owns (see PLAN.md).
- Do not edit .multi/tasks.json (the console owns it).
- When the task is DONE, write ${path.join(p.dir, '.multi', 'out', t.id + '.md')}: what you made (paths), how to check it, anything the other seats or the integration must know. The console marks the task done only when that file exists.
- If you need a decision from the user, ask and stop; do not write the out file yet.`;

export const retryPrompt = (t) => `Continue task ${t.id} (${t.title}) from where it stopped: check what is already on disk, finish it, and write .multi/out/${t.id}.md when it is done.`;

export const integratePrompt = (p) => `All tasks of the multi-sided project "${p.name}" are done. You are the owner: run the final INTEGRATION and VERIFICATION.

Project folder: ${p.dir}
Read PLAN.md and every note in .multi/out/. Fit the parts together, fix the seams, then verify the result the way PLAN.md says (run it, test it, look at it). Do not redo a task's work unless it is broken.
Write .multi/out/_integration.md: what you changed, how it was verified (commands + results), what is still open. End your reply with STATUS / CHANGED / VERIFIED-BY / NOTES.`;

// deps: { send({seat, conversationId, cwd, text, title}) -> conversation, windows(seat), map, owner, seats, root, notify(project, kind), log, now(),
//         ctxPct(convId) -> % of its context window or null, freshAtPct() -> threshold (0 = never) }
export function createMulti({ state, save, broadcast, deps }) {
  state.multi ||= {};
  const now = () => (deps.now ? deps.now() : Date.now());
  const outFile = (p, id) => path.join(p.dir, '.multi', 'out', id + '.md');

  function persist(p) {
    p.updatedAt = now();
    try {
      fs.mkdirSync(path.join(p.dir, '.multi', 'out'), { recursive: true });
      const view = { project: p.name, status: p.status, owner: p.owner, updatedAt: new Date(p.updatedAt).toISOString(),
        tasks: p.tasks.map(({ id, title, discipline, seat, deps: d, status, conv }) => ({ id, title, discipline, seat, deps: d, status, conv })) };
      fs.writeFileSync(path.join(p.dir, '.multi', 'tasks.json'), JSON.stringify(view, null, 2) + '\n');
    } catch (e) { deps.log?.(`[multi] ${p.id} tasks.json: ${e.message}`); }
    save(); broadcast();
  }

  function create({ name, brief, dir, owner }) {
    name = String(name || '').trim(); brief = String(brief || '').trim();
    if (!name || !brief) throw new Error('name and brief are required');
    owner = owner || deps.owner;
    if (!Object.hasOwn(deps.seats, owner)) throw new Error('unknown owner seat ' + owner);
    dir = String(dir || '').trim() || path.join(deps.root, name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project');
    if (!path.isAbsolute(dir)) throw new Error('project folder must be an absolute path');
    dir = path.resolve(dir);
    if (!fs.existsSync(dir)) {
      if (!(dir + path.sep).startsWith(path.resolve(deps.root) + path.sep)) throw new Error('folder does not exist (only folders under ' + deps.root + ' are created)');
      fs.mkdirSync(dir, { recursive: true });
    }
    if (Object.values(state.multi).some((x) => x.dir === dir && !['done', 'cancelled'].includes(x.status))) throw new Error('a multi-sided project already runs in ' + dir);
    const old = path.join(dir, '.multi'); if (fs.existsSync(old)) fs.renameSync(old, `${old}.old-${now()}-${crypto.randomUUID().slice(0, 4)}`);   // a previous run's plan/out files must not count for this one
    let id; do id = crypto.randomUUID().slice(0, 8); while (state.multi[id]);
    const p = state.multi[id] = { id, name, brief, dir, owner, status: 'planning', tasks: [], planConv: null, planSent: false, integrateConv: null, createdAt: now() };
    persist(p); tick();
    return p;
  }

  async function dispatch(p, key, seat, text, conversationId, title, onDone, model) {
    const until = blockedUntil(deps.windows(seat), now());
    const t = key === 'plan' || key === 'integrate' ? p : p.tasks.find((x) => x.id === key);
    if (until) { if (t.waitUntil !== until) { t.waitUntil = until; persist(p); } return; }   // seat at its limit: WAIT. Never another seat.
    try {
      const c = await deps.send(conversationId ? { conversationId, text } : { seat, cwd: p.dir, text, title, ...(model ? { model } : {}) });
      c.multi = { pid: p.id, task: key };
      t.waitUntil = 0; t.sendError = undefined; onDone(c); persist(p);
    } catch (e) {
      t.sendError = String(e.message || e);
      if (conversationId && /unknown conversation/.test(t.sendError)) {   // its conversation was deleted: shown as an error, Retry starts a new one on the SAME seat
        if (t === p) { if (key === 'plan') { p.planConv = null; p.status = 'plan-error'; } else { p.integrateConv = null; p.status = 'integrate-error'; } p.error = t.sendError; }
        else { t.conv = null; t.status = 'error'; t.error = t.sendError; }
      } deps.log?.(`[multi] ${p.id}/${key} send failed: ${t.sendError}`); persist(p); }
  }

  // One pass at a time (a pass awaits sends; a second one could start the same task twice); a call during a pass runs one more pass after it.
  let running = null, again = false;
  function tick() {
    if (running) { again = true; return running; }
    return running = pass().catch((e) => deps.log?.('[multi] tick: ' + e.message)).finally(() => { running = null; if (again) { again = false; tick(); } });
  }
  async function pass() {
    for (const p of Object.values(state.multi)) {
      if (p.status === 'cancelled') continue;
      if (p.status === 'planning' && !p.planSent) {
        await dispatch(p, 'plan', p.owner, p.planConv ? planFixPrompt(p.error) : planPrompt(p, deps.map, deps.models?.() || {}), p.planConv, `[${p.name}] plan`, (c) => { p.planConv = c.id; p.planSent = true; });
      } else if (p.status === 'running') {
        const done = new Set(p.tasks.filter((t) => t.status === 'done').map((t) => t.id));
        if (done.size === p.tasks.length) { p.status = 'integrating'; p.integrateSent = false; persist(p); deps.notify?.(p, 'integrating'); }
        for (const t of p.tasks) {
          if (t.status !== 'pending' || !t.deps.every((d) => done.has(d))) continue;
          let seat; try { seat = seatFor(deps.map, t.discipline); } catch (e) { t.status = 'error'; t.error = e.message; persist(p); continue; }   // disciplines.json lost it: this task stops, the others go on
          // Open intents of the action journal (journal.mjs) ride along: the task's own conversation's and, for a fresh one, its predecessors'.
          await dispatch(p, t.id, seat, withUnknown(t.conv ? retryPrompt(t) : taskPrompt(p, t), deps.unknown?.(t.conv, t.prevConvs || []) || []), t.conv, `[${p.name}] ${t.title}`, (c) => { t.conv = c.id; t.status = 'running'; }, t.model);   // the model the planner chose for this task (from its own seat's list)
        }
      }
      if (p.status === 'integrating' && !p.integrateSent) {
        await dispatch(p, 'integrate', p.owner, p.integrateConv ? 'Continue the integration and verification from where it stopped.' : integratePrompt(p), p.integrateConv, `[${p.name}] integration`, (c) => { p.integrateConv = c.id; p.integrateSent = true; });
      }
    }
  }

  // A conversation of a project settled (its turn and its background work are over) or ended on an error.
  function settled(c, { error = null, needsAnswer = false } = {}) {
    const p = c.multi && state.multi[c.multi.pid]; if (!p) return;
    const key = c.multi.task;
    if (key === 'plan') {
      if (p.status !== 'planning' && p.status !== 'plan-error') return;
      if (error) { p.status = 'plan-error'; p.error = error; return persist(p); }
      try {
        p.tasks = validatePlan(JSON.parse(fs.readFileSync(path.join(p.dir, '.multi', 'plan.json'), 'utf8')), deps.map, deps.models?.() || {});
        p.status = 'plan-ready'; p.error = undefined; persist(p); deps.notify?.(p, 'plan-ready');
      } catch (e) { p.status = 'plan-error'; p.error = needsAnswer ? 'the planner asked a question: answer it in the plan conversation' : String(e.message || e); persist(p); }
      return;
    }
    if (key === 'integrate') {
      if (p.status !== 'integrating' && p.status !== 'integrate-error') return;
      const ok = !error && fs.existsSync(outFile(p, '_integration'));
      p.status = ok ? 'done' : 'integrate-error'; p.error = ok ? undefined : error || (needsAnswer ? 'the owner asked a question: answer it in the integration conversation' : 'no .multi/out/_integration.md');
      persist(p); deps.notify?.(p, p.status);
      return;
    }
    const t = p.tasks.find((x) => x.id === key); if (!t || t.status === 'done') return;
    t.status = error ? 'error' : fs.existsSync(outFile(p, t.id)) ? 'done' : needsAnswer ? 'needs-answer' : 'stuck';
    t.error = error || undefined;
    // Token economy: a task that stopped unfinished in a conversation already past the threshold continues in a FRESH conversation on the
    // same seat (the long one would re-read its whole history from the cache on every turn). Not for errors or questions to the user; capped.
    if (t.status === 'stuck' && freshIfLong(t) && (t.freshCount || 0) <= FRESH_MAX) t.status = 'pending';
    persist(p); if (t.status === 'done' || t.status === 'pending') tick();
  }

  // The task's conversation is past deps.freshAtPct() % of its context window: drop it (kept in prevConvs) so the next dispatch starts a new one.
  const FRESH_MAX = 5;
  function freshIfLong(t) {
    const pct = t.conv && deps.ctxPct?.(t.conv), at = deps.freshAtPct?.() ?? 40;
    if (pct == null || !(at > 0) || pct < at) return false;
    (t.prevConvs ||= []).push(t.conv); t.conv = null; t.fresh = true; t.freshCount = (t.freshCount || 0) + 1;
    deps.log?.(`[multi] task ${t.id}: conversation at ${Math.round(pct)}% of its context, continues in a fresh one (#${t.freshCount})`);
    return true;
  }

  function approve(id) {
    const p = state.multi[id]; if (!p) throw new Error('unknown project');
    if (p.status !== 'plan-ready') throw new Error('nothing to approve (status ' + p.status + ')');
    p.tasks = validatePlan(JSON.parse(fs.readFileSync(path.join(p.dir, '.multi', 'plan.json'), 'utf8')), deps.map, deps.models?.() || {});   // the plan as it is NOW (the user may have changed it with the planner)
    p.status = 'running'; persist(p); tick();
    return p;
  }

  // Retry: an errored/stuck task goes back to pending (its own conversation, its own seat); a failed plan or integration is asked again.
  function retry(id, taskId) {
    const p = state.multi[id]; if (!p) throw new Error('unknown project');
    if (!taskId || taskId === 'plan') { if (p.status !== 'plan-error') throw new Error('the plan has not failed'); p.status = 'planning'; p.planSent = false; }
    else if (taskId === 'integrate') { if (p.status !== 'integrate-error') throw new Error('the integration has not failed'); p.status = 'integrating'; p.integrateSent = false; }
    else {
      if (p.status !== 'running') throw new Error('the project is not running (' + p.status + ')');
      const t = p.tasks.find((x) => x.id === taskId); if (!t) throw new Error('unknown task');
      if (!['error', 'stuck', 'needs-answer'].includes(t.status) && !(t.status === 'running' && t.conv && deps.idle?.(t.conv))) throw new Error('task is ' + t.status);
      t.status = 'pending'; t.error = undefined; freshIfLong(t);   // Retry/Continue into a long conversation starts a fresh one instead
    }
    persist(p); tick();
    return p;
  }

  function cancel(id) {
    const p = state.multi[id]; if (!p) throw new Error('unknown project');
    if (p.status === 'done') throw new Error('the project is done');
    p.status = 'cancelled'; persist(p);   // nothing new starts; conversations already running are left to the user (Stop in the console)
    return p;
  }

  const view = () => Object.values(state.multi).sort((a, b) => b.createdAt - a.createdAt).map(({ brief, ...p }) => ({ ...p, tasks: p.tasks.map(({ brief: _, ...t }) => ({ ...t, unknownActions: deps.unknownCount?.([t.conv, ...(t.prevConvs || [])]) || 0 })) }));
  return { create, approve, retry, cancel, settled, tick, view, find: (short) => Object.values(state.multi).find((p) => p.id.startsWith(short)) };
}
