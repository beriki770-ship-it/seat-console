// Slim copies of logged events for the page. The raw log keeps everything; the page gets only what it draws, with long tool inputs/outputs clipped.
// A tool row's full input/output is fetched on demand (toolDetail, GET /api/tool). Pure functions, tested by test-slim.mjs.
export const CLIP_RESULT = 1500;   // chars of a tool result sent by default (previews of named files are found in this part)
export const CLIP_FIELD = 400;     // chars of any string in a tool_use input sent by default
export const DETAIL_MAX = 20000;   // chars of one tool result sent on demand

const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);
const resultText = (c) => Array.isArray(c) ? c.map((x) => x.type === 'text' ? x.text || '' : x.type === 'image' ? '[image]' : '').filter(Boolean).join('\n') : String(c ?? '');

function slimInput(input) {
  if (!input || typeof input !== 'object') return { input, slim: false };
  let slim = false; const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.length > CLIP_FIELD) { out[k] = v.slice(0, CLIP_FIELD); slim = true; }
    else if (v && typeof v === 'object') { const s = JSON.stringify(v); if (s.length > CLIP_FIELD) { out[k] = s.slice(0, CLIP_FIELD); slim = true; } else out[k] = v; }
    else out[k] = v;
  }
  return { input: out, slim };
}

// null = the page draws nothing for this event type (init, task progress, thinking tokens...). `i` = position in the conversation's event list.
export function slimEvent(ev, i) {
  const t = ev.type, base = { type: t, ts: ev.ts, i };
  if (t === 'console_user' || t === 'console_error' || t === 'console_spawn' || t === 'console_perm_done') return { ...ev, i, hoff: undefined, hgen: undefined };
  if (t === 'console_perm') return { ...ev, i, hoff: undefined, hgen: undefined };   // the approval card shows the whole command: never clipped
  if (t === 'assistant') {
    const content = [];
    for (const c of ev.message?.content || []) {
      if (c.type === 'text') content.push({ type: 'text', text: c.text });
      else if (c.type === 'tool_use') { const s = slimInput(c.input); content.push({ type: 'tool_use', id: c.id, name: c.name, input: s.input, ...(s.slim || c.slim ? { slim: true } : {}) }); }   // c.slim: already clipped in memory (memSlim)
    }
    return content.length ? { ...base, message: { content } } : null;
  }
  if (t === 'user') {
    const content = [];
    for (const c of ev.message?.content || []) if (c.type === 'tool_result') {
      const text = resultText(c.content), cut = text.length > CLIP_RESULT;
      content.push({ type: 'tool_result', tool_use_id: c.tool_use_id, is_error: !!c.is_error, content: clip(text, CLIP_RESULT), ...(cut || c.slim ? { slim: true } : {}) });
    }
    return content.length ? { ...base, message: { content } } : null;
  }
  if (t === 'result') return { ...base, is_error: ev.is_error, result: ev.result, total_cost_usd: ev.total_cost_usd, duration_ms: ev.duration_ms, local_command: ev.local_command };
  if (t === 'system' && (ev.subtype === 'permission_denied' || ev.subtype === 'compact_boundary')) return { ...ev, i, hoff: undefined, hgen: undefined };
  return null;
}
export const slimEvents = (events, from = 0) => { const out = []; events.forEach((e, k) => { const s = slimEvent(e, from + k); if (s) out.push(s); }); return out; };

// Full input and output of one tool call, newest match first (a tool_use id is unique per conversation).
export function toolDetail(events, id) {
  let input, result;
  for (let k = events.length - 1; k >= 0 && (input === undefined || result === undefined); k--) {
    const e = events[k];
    for (const c of e.message?.content || []) {
      if (e.type === 'assistant' && c.type === 'tool_use' && c.id === id) input = c.input;
      else if (e.type === 'user' && c.type === 'tool_result' && c.tool_use_id === id) result = resultText(c.content);
    }
  }
  if (input === undefined && result === undefined) return null;
  return { input, result: result === undefined ? undefined : clip(result, DETAIL_MAX), resultLen: result?.length };
}

// In-memory copy only (the jsonl keeps everything): drop what neither the page nor the server reads. tool_use_result duplicates the tool result, thinking is never drawn.
export function memTrim(ev) {
  delete ev.tool_use_result;
  if (Array.isArray(ev.message?.content)) ev.message.content = ev.message.content.filter((c) => c.type !== 'thinking');
  return ev;
}
// In-memory copy of an event whose whole line the server can read back from the jsonl (GET /api/tool reads it there by byte offset): tool inputs and
// tool results are clipped exactly like the page gets them, images become "[image]". `slim` on a block marks what was cut, so slimEvent of this copy
// equals slimEvent of the full event (the page still offers "load the rest"). Runs after memTrim; the 150 MB logs were mostly screenshot results.
export function memSlim(ev) {
  for (const c of Array.isArray(ev.message?.content) ? ev.message.content : []) {
    if (ev.type === 'assistant' && c.type === 'tool_use') { const s = slimInput(c.input); if (s.slim) { c.input = s.input; c.slim = true; } }
    else if (ev.type === 'user' && c.type === 'tool_result') { const text = resultText(c.content); if (text.length > CLIP_RESULT) c.slim = true; c.content = clip(text, CLIP_RESULT); }
  }
  return ev;
}
