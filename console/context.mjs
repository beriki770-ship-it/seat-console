// Context-window meter: pure helpers (no I/O) so server.mjs and test-context.mjs share one implementation.
// All shapes below were captured from real stream-json output of claude 2.1.x (see docs/DECISIONS.md, "context meter").

// The CLI auto-compacts at (window - 20k reserved for output - 13k buffer) = window - 33k. 13000 is the constant `Rct` in the claude binary;
// the 20k reserve is min(maxOutputTokens, 20000). It matches the desktop app's own numbers (596.9k used + 370k "until auto-compact" of a 1M window).
export const AUTOCOMPACT_BUFFER = 33000;
export const autoCompactAt = (window) => (window > AUTOCOMPACT_BUFFER ? window - AUTOCOMPACT_BUFFER : null);

const sum = (u) => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
// "claude-haiku-4-5-20251001" (assistant message) and "claude-haiku-4-5" (init, modelUsage key) are the same model.
const sameModel = (a, b) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

// Folds one stream event into the conversation's ctx = {used, window, autoCompactAt, model, updatedAt}; returns true when it changed.
//  - system/init: the model name (needed to pick the right modelUsage entry later).
//  - assistant from the main thread: its usage = the context the model just saw (+ what it wrote). Subagent messages (parent_tool_use_id) have their own context;
//    slash-command replies (/context, /compact) are model "<synthetic>" with all-zero usage and must not reset the number.
//  - result: modelUsage[model].contextWindow is the only place the CLI reports the window size (200000 haiku, 1000000 opus/sonnet 5.5).
//  - system/compact_boundary: compact_metadata.post_tokens is the size right after a compaction, before the next assistant message.
export function applyCtx(ctx, ev, now = Date.now()) {
  let changed = false;
  const set = (k, v) => { if (v != null && ctx[k] !== v) { ctx[k] = v; changed = true; } };
  if (ev.type === 'system' && ev.subtype === 'init') set('model', ev.model);
  else if (ev.type === 'assistant' && !ev.parent_tool_use_id && ev.message?.model !== '<synthetic>' && ev.message?.usage) {
    const used = sum(ev.message.usage);
    if (used > 0) { set('used', used); if (!sameModel(ctx.model, ev.message.model)) set('model', ev.message.model); }
  } else if (ev.type === 'result' && ev.modelUsage) {
    const key = Object.keys(ev.modelUsage).find((k) => sameModel(ctx.model, k)) || (Object.keys(ev.modelUsage).length === 1 ? Object.keys(ev.modelUsage)[0] : null);
    set('window', key && ev.modelUsage[key].contextWindow);
  } else if (ev.type === 'system' && ev.subtype === 'compact_boundary') set('used', ev.compact_metadata?.post_tokens);
  if (changed) { ctx.autoCompactAt = autoCompactAt(ctx.window); ctx.updatedAt = now; }
  return changed;
}

// "45.6k" -> 45600, "1M" -> 1000000, "1.2M" -> 1200000, "512" -> 512, anything else -> null.
export function parseTokens(s) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(String(s ?? ''));
  return m ? Math.round(+m[1] * ({ '': 1, k: 1e3, m: 1e6 }[m[2].toLowerCase()])) : null;
}

// The text of a `/context` reply (the `result` event with local_command "context") -> {model, used, window, pct, categories}.
// categories = rows of "Estimated usage by category", kept as the CLI prints the names; "(deferred)" rows are listed but not part of the used total
// (45.6k used = system prompt + system tools + MCP instructions + agents + memory + skills + messages; the deferred tools are loaded on demand).
export function parseContextReply(text) {
  const t = String(text ?? '');
  const head = /\*\*Tokens:\*\*\s*([\d.]+[kKmM]?)\s*\/\s*([\d.]+[kKmM]?)\s*\((\d+(?:\.\d+)?)%\)/.exec(t);
  if (!head) return null;
  const model = /\*\*Model:\*\*\s*(\S+)/.exec(t)?.[1] ?? null;
  const categories = [];
  const sec = t.split(/^###\s+/m).find((s) => s.startsWith('Estimated usage by category'));
  for (const line of (sec || '').split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 4 || cells[1] === 'Category' || /^-+$/.test(cells[1])) continue;
    const tokens = parseTokens(cells[2]);
    if (cells[1] && tokens != null) categories.push({ name: cells[1], tokens, pct: parseFloat(cells[3]) || 0, deferred: /\(deferred\)/.test(cells[1]) });
  }
  return { model, used: parseTokens(head[1]), window: parseTokens(head[2]), pct: +head[3], categories };
}

// Colour band for the bar and the Telegram button: green < 60 %, yellow 60-80, red > 80.
export const ctxLevel = (pct) => (pct > 80 ? 'red' : pct >= 60 ? 'yellow' : 'green');
