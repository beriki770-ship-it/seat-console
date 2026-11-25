// Auto handoff for local conversations: once a conversation passes a share of its context window (Settings > Usage, autoHandoff*,
// off by default), the console asks it to update its HANDOFF.md, and once that turn has settled a fresh conversation in the same
// folder/model/mode continues from that file (or the old one is compacted). Pure decisions here, the wiring is in server.mjs (autoHandoffTick).
// Why not just compact: a compaction summary loses detail the agent never wrote down, and a long-lived context re-reads all of it every turn.

// "Orchestrator" -> "Orchestrator ↻2", "Orchestrator ↻2" -> "Orchestrator ↻3": the sidebar shows which generation is live.
export function nextTitle(title) {
  const m = /^(.*?) ↻(\d+)$/.exec(title || '');
  return m ? `${m[1]} ↻${+m[2] + 1}` : `${title || 'conversation'} ↻2`;
}

// ---- Auto handoff for LOCAL Claude conversations: past the limit and not working -> fill the handoff file, then a new conversation (or
// /compact); a working conversation is handled as soon as it finishes. Per Settings (autoHandoff*), only for local Claude seats.
// c.autoHandoff: undefined -> { stage:'armed' } (crossed at a turn's result) -> 'asked' (prompt sent, tries 1..2, ready = path from the
// HANDOFF-READY line) -> 'done' (successor started / compact sent) | 'gave-up' (no fresh HANDOFF after 2 asks, the owner told on Telegram). The owner writing while
// it is 'asked' = 'cancel': state cleared, the next turn's result arms it again. 'done' / 'gave-up' re-arm only below pct - 5 (hysteresis).
// Arming happens ONLY at a turn's result: after a console restart an idle conversation already past the limit is not touched until it works again.
export const AH_MAX_TRIES = 2, AH_HYST = 5, AH_MAX_RUNNING = 2, AH_STUCK_MS = 30 * 60000;
// v: { pct, used, atResult, settled, blocked (pending approval / open question), running (handoffs in 'asked' elsewhere), agent, fresh (HANDOFF mtime after the ask), stuck }
// cfg: { on, pct, minTokens }
export function autoHandoffStep(c, v, cfg) {
  const s = c.autoHandoff?.stage;
  // v.agent: Codex / agy seats, project tasks. Switched off (Settings, ⋯, archived) while armed / asked: drop it, never frozen in a running slot.
  if (!cfg?.on || !cfg.pct || c.remote || c.phone || c.archived || c.noAutoHandoff || v.agent) return s === 'armed' || s === 'asked' ? 'disarm' : null;
  const over = v.pct != null && v.pct >= cfg.pct && (v.used || 0) >= (cfg.minTokens || 0);
  if (s === 'done' || s === 'gave-up') return v.pct != null && v.pct < cfg.pct - AH_HYST ? 'rearm' : null;
  if (!s) return over && v.atResult ? 'arm' : null;
  if (s === 'armed') {
    if (!over) return 'disarm';   // compacted by hand, or the limit was raised in Settings
    if (!v.settled || v.blocked || (v.running || 0) >= AH_MAX_RUNNING) return null;
    return 'ask';
  }
  if (s === 'asked') {
    if (c.autoHandoff.owner) return 'cancel';   // the owner wrote in between: no Step B now, re-evaluated at a later turn
    if (v.stuck) return 'giveup';   // the ask turn never came back to idle (error / stopped / interrupted) within AH_STUCK_MS
    if (!v.settled || v.blocked) return null;
    if (c.autoHandoff.ready && v.fresh) return 'continue';
    return (c.autoHandoff.tries || 1) >= AH_MAX_TRIES ? 'giveup' : 'retry';
  }
  return null;
}
// "HANDOFF-READY: /abs/path/docs/HANDOFF.md" anywhere in the reply (the last one wins); null without it.
export function handoffReadyPath(text) {
  const m = [...String(text || '').matchAll(/^\s*HANDOFF-READY:\s*(\S.*?)\s*$/gm)].pop();
  return m ? m[1].replace(/^[`'"]|[`'"]$/g, '') : null;
}
export const autoHandoffPrompt = (pct, file) => `🧭 Console: context at ${Math.round(pct)}% — time to hand off. Update ${file} (create it if it is missing) with everything a fresh conversation needs to continue without this one:
- current state (what works now, branch + last commit if in git)
- what changed in this conversation, with absolute dates
- what is left to do, in order
- key files and commands
- gotchas found on the way
- open decisions / anything waiting on the user
Use small edits on unique anchors (append a dated section or edit the existing one); never rewrite the whole file. Do not start new work or agents.
Then reply with exactly one line: HANDOFF-READY: <absolute path of the file>`;
export const continuePrompt = (prev, file) => `Continue from ${file}: read it first, then continue the open work. (The console opened this conversation because "${prev.title}" (${prev.id.slice(0, 8)}) reached ${Math.round(prev.pct)}% context and wrote that handoff.)`;
export const compactInstructions = (file) => `Keep the HANDOFF path ${file} and the open items from it.`;
// Which HANDOFF.md: the nearest folder from cwd upwards (never above home) that already has docs/HANDOFF.md, else the nearest git root, else cwd.
export function handoffFileFor(cwd, home, exists, join = (...p) => p.join('/'), dirname) {
  const up = (d) => { const p = dirname(d); return p === d ? null : p; }, stop = (d) => !d || d === home || d === dirname(home);
  for (let d = cwd; !stop(d); d = up(d)) if (exists(join(d, 'docs', 'HANDOFF.md'))) return join(d, 'docs', 'HANDOFF.md');
  for (let d = cwd; !stop(d); d = up(d)) if (exists(join(d, '.git'))) return join(d, 'docs', 'HANDOFF.md');
  return join(cwd, 'docs', 'HANDOFF.md');
}
