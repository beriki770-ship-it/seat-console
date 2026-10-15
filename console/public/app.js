// Seat Console front end: seats with their conversations in the sidebar, one conversation pane, live via SSE.
const TOKEN = document.querySelector('meta[name=seat-token]').content;
const $ = (id) => document.getElementById(id);
let seats = [];
let cur = { seat: localStorage.getItem('seat') || 'studio', id: null };   // id null = draft of a new conversation
const convo = {};            // conversation id -> { events, pending:Set }
const toolRows = {};         // tool_use_id -> <details> awaiting its result
const permCards = {};        // requestId -> card element

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = (path, body) => fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Seat-Token': TOKEN }, body: JSON.stringify(body) } : undefined).then((r) => r.json());
const div = (cls, html) => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; return d; };
const allConvs = () => seats.flatMap((s) => s.conversations);
const curConv = () => allConvs().find((c) => c.id === cur.id);
const label = { idle: 'idle', working: 'working', waiting: 'needs approval', error: 'error', stopped: 'stopped', interrupted: 'interrupted' };

// Minimal markdown: fenced code, lists, paragraphs, inline code, bold, links. Everything is escaped first.
// A code block gets a Copy button (raw text, see copyText) and ONE direction for the whole block (blockDir): per-line bidi broke the indentation of code with Hebrew comments.
function md(src) {
  const parts = src.split(/```[^\n]*\n?/);
  return parts.map((p, i) => i % 2 ? `<div class="code"><button type="button" class="copy" data-copy aria-label="Copy code">Copy</button><pre dir="${blockDir(p)}"><code>${esc(p.replace(/\n$/, ''))}</code></pre></div>` : p.split(/\n{2,}/).map((blk) => {
    if (!blk.trim()) return '';
    const inline = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    const lines = blk.split('\n');
    if (lines.every((l) => /^\s*[-*] /.test(l))) return '<ul>' + lines.map((l) => `<li dir="auto">${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('') + '</ul>';
    return `<p dir="auto">${lines.map(inline).join('<br>')}</p>`;
  }).join('')).join('');
}
// rtl only for a block of Hebrew prose: its first strong letter is Hebrew AND it holds no ASCII letter at all. Code, tree listings, mixed blocks: ltr.
const blockDir = (t) => { const m = /[A-Za-z\u00C0-\u024F\u0590-\u05FF\u0600-\u06FF]/.exec(t); return m && /[\u0590-\u06FF]/.test(m[0]) && !/[A-Za-z]/.test(t) ? 'rtl' : 'ltr'; };
// Cards touch the server (video metadata, the HEAD that checks a document exists) only once they are on screen: a long conversation names hundreds of files,
// and fetching all of them at render time starved the conversation request itself. Content inside a closed <details> is never "visible", so a folded run costs nothing.
const seen = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { seen.unobserve(e.target); e.target._go(); } }), { rootMargin: '300px' });
const whenVisible = (el, fn) => { el._go = fn; seen.observe(el); };
// Preview cards for files a message names (detector lives in paths.js). One card per path per message; a 403/404 turns into a quiet note.
function previews(text) {
  // `/`-rooted paths count only when the console runs on Linux / macOS: told by the seat's folder (C:\... on Windows), the page has no other hint.
  const posix = /^\//.test(seats.find((s) => s.name === cur.seat)?.cwd || '');
  const paths = findPaths(text, posix); if (!paths.length) return null;
  const box = div('previews', '');
  for (const p of paths) {
    const src = `/api/file?conv=${encodeURIComponent(cur.id || '')}&path=${encodeURIComponent(p)}`, name = p.split(/[\\/]/).pop(), kind = fileKind(p);
    const card = div('pcard', `<small dir="auto">${esc(name)}</small>`);
    const gone = () => { card.className = 'pcard gone'; card.innerHTML = `<small dir="auto">${esc(name)}: not available</small>`; };
    let el;
    if (kind === 'video') { el = document.createElement('video'); el.controls = true; el.preload = 'metadata'; el.playsInline = true; whenVisible(card, () => { el.src = src; }); }
    else if (kind === 'image') { el = document.createElement('a'); el.href = src; el.target = '_blank'; el.rel = 'noopener'; el.innerHTML = `<img loading="lazy" alt="${esc(name)}" src="${src}">`; el.firstChild.onerror = gone; }
    else { el = document.createElement('a'); el.href = src; el.target = '_blank'; el.rel = 'noopener'; el.className = 'open'; el.textContent = 'Open ' + name; whenVisible(card, () => fetch(src, { method: 'HEAD' }).then((r) => { if (!r.ok) gone(); }, gone)); }
    if (kind === 'video') el.onerror = gone;
    card.prepend(el); box.appendChild(card);
  }
  return box;
}
const short = (o) => { const v = o.command || o.file_path || o.pattern || o.url || o.description || o.path || JSON.stringify(o); return String(v).replace(/\s+/g, ' ').slice(0, 110); };

// Consecutive tool calls are folded into ONE quiet "🔧 N actions" line (a <details>); `run` is the open one, any other visible element ends it.
// The header toggle "Show actions" opens every run. Approval cards, text, errors, results and file previews are never folded.
let run = null, loading = null, showTools = (() => { try { return localStorage.getItem('showTools') === '1'; } catch { return false; } })();
function runSummary(r) {
  const n = Object.values(r._count).reduce((a, b) => a + b, 0);
  const parts = Object.entries(r._count).sort((a, b) => b[1] - a[1]), top = parts.slice(0, 4).map(([k, v]) => v > 1 ? `${esc(k)} ×${v}` : esc(k)).join(', ') + (parts.length > 4 ? ', …' : '');
  r.firstChild.innerHTML = `🔧 ${n === 1 ? '1 action' : n + ' actions'} · ${top}` + (r._err ? ` <span class="runerr">· ⚠ ${r._err} errors</span>` : '');
}
function newRun() {
  const r = document.createElement('details'); r.className = 'toolrun'; r.open = showTools; r._count = {}; r._err = 0;
  r.innerHTML = '<summary dir="auto"></summary><div class="runbody"></div>'; return r;
}
function render(ev, st, target = $('log')) {
  const out = [];
  if (ev.type === 'console_user') {
    const u = div('msg user', esc(ev.text)); u.dir = 'auto'; u.appendChild(pinBtn());
    if (ev.images?.length) { const t = div('thumbs', ''); for (const n of ev.images) { const src = `/api/file?conv=${encodeURIComponent(cur.id)}&upload=${encodeURIComponent(n)}`; t.insertAdjacentHTML('beforeend', `<a href="${src}" target="_blank" rel="noopener"><img class="thumb" loading="lazy" alt="attached image" src="${src}"></a>`); } u.appendChild(t); }
    if (ev.files?.length) { const t = div('thumbs', ''); for (const f of ev.files) t.insertAdjacentHTML('beforeend', `<a class="fchip" dir="ltr" href="/api/file?conv=${encodeURIComponent(cur.id)}&upload=${encodeURIComponent(f.name)}" target="_blank" rel="noopener">📎 <bdi>${esc(f.label)}</bdi> · ${sizeText(f.size)}</a>`); u.appendChild(t); }
    out.push(u);
  }
  else if (ev.type === 'console_error') out.push(div('msg note err', esc(ev.text)));
  else if (ev.type === 'console_spawn') out.push(div('msg note', `started · ${esc(ev.mode)} mode · pid ${ev.pid}`));
  else if (ev.type === 'console_perm') {
    const live = st.pending.has(ev.requestId);
    const card = div('msg perm', `<b>${esc(ev.tool)} wants to run</b><pre dir="auto">${esc(ev.input.command || ev.blockedPath || JSON.stringify(ev.input, null, 2))}</pre>`
      + (ev.description ? `<small dir="auto">${esc(ev.description)}</small>` : '')
      + `<div class="acts">${live ? '<button class="primary" data-a="1">Allow once</button><button data-a="0">Deny</button>' : '<em>expired</em>'}</div>`);
    card.dataset.req = ev.requestId; permCards[ev.requestId] = card; out.push(card);
  } else if (ev.type === 'console_perm_done') {
    const card = permCards[ev.requestId];
    if (card) card.querySelector('.acts').innerHTML = `<em>${ev.allow ? 'allowed' : 'denied'}</em>`;
  } else if (ev.type === 'assistant') {
    for (const c of ev.message.content || []) {
      if (c.type === 'text' && c.text.trim()) { run = null; const a = div('msg assistant', md(c.text)); a.appendChild(pinBtn()); out.push(a); const pv = previews(c.text); if (pv) out.push(pv); }
      else if (c.type === 'tool_use') {
        const d = document.createElement('details'); d.className = 'tool'; d.dataset.tid = c.id; if (c.slim) d.dataset.slim = '1';
        d.innerHTML = `<summary dir="auto">${esc(c.name)}: ${esc(short(c.input))}</summary><pre class="in">${esc(JSON.stringify(c.input, null, 2))}</pre>`;
        toolRows[c.id] = d;
        if (!run) { run = newRun(); out.push(run); }
        run._count[c.name] = (run._count[c.name] || 0) + 1; run.lastChild.appendChild(d); runSummary(run);
      }
    }
  } else if (ev.type === 'user') {
    for (const c of ev.message?.content || []) if (c.type === 'tool_result') {
      const text = Array.isArray(c.content) ? c.content.map((x) => x.text || '').join('\n') : String(c.content ?? '');
      const row = toolRows[c.tool_use_id];
      if (row) {
        row.insertAdjacentHTML('beforeend', `<pre class="res">${esc(text)}</pre>`); if (c.slim) row.dataset.slim = '1'; const pv = previews(text); if (pv) row.appendChild(pv);
        if (c.is_error && /permission|denied|not allowed|approval/i.test(text)) row.classList.add('blocked');
        if (c.is_error) { row.classList.add('err'); const r = row.closest('.toolrun'); if (r) { r._err++; runSummary(r); } }
      }
    }
  } else if (ev.type === 'system' && ev.subtype === 'permission_denied') {
    out.push(div('msg note err', `blocked: ${esc(ev.tool_name)}. ${esc(ev.message || '')}`));
  } else if (ev.type === 'system' && ev.subtype === 'compact_boundary') {
    const m = ev.compact_metadata || {};
    out.push(div('msg note', `compacted (${esc(m.trigger || 'manual')}): ${kfmt(m.pre_tokens || 0)} → ${kfmt(m.post_tokens || 0)} tokens`));
  } else if (ev.type === 'result' && ev.local_command) {
    // reply of a /context or /compact the console sent itself: the numbers live in the meter, nothing to show here
  } else if (ev.type === 'result') {
    const res = div('msg result', `${ev.is_error ? 'error · ' : ''}done · ~$${(ev.total_cost_usd || 0).toFixed(2)} API value · ${Math.round((ev.duration_ms || 0) / 1000)}s `);
    if (!ev.is_error && ev.result) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'hand'; b.textContent = 'Send to seat…';
      b.onclick = () => {
        const sel = document.createElement('select'); sel.setAttribute('aria-label', 'Target seat');
        sel.innerHTML = '<option value="">Send to seat…</option>' + seats.filter((s) => !s.remote).map((s) => `<option>${esc(s.name)}</option>`).join('');
        sel.onchange = () => sel.value && handoff(sel.value, ev.result);
        b.replaceWith(sel); sel.focus();
      };
      res.appendChild(b);
    }
    out.push(res);
    if (ev.is_error && ev.result) out.push(div('msg note err', esc(ev.result)));
  }
  // anything visible that is not a run ends the run; a perm_done only edits an existing card and adds nothing
  if (out.some((o) => !o.classList.contains('toolrun'))) run = null;
  for (const o of out) { if (ev.i != null) o.dataset.i = ev.i; target.appendChild(o); }   // the event index: a pin jumps to it
}
// Tool rows hold a clipped input/output; the full text is fetched the first time a row is opened.
$('log').addEventListener('toggle', async (e) => {
  const d = e.target; if (!d.matches?.('details.tool') || !d.open || d.dataset.slim !== '1' || d.dataset.loading) return;
  d.dataset.loading = '1';
  try {
    const r = await fetch(`/api/tool?conv=${encodeURIComponent(cur.id)}&id=${encodeURIComponent(d.dataset.tid)}`).then((x) => x.json());
    if (r.error) return;
    const inp = d.querySelector('pre.in'), res = d.querySelector('pre.res');
    if (inp && r.input !== undefined) inp.textContent = JSON.stringify(r.input, null, 2);
    if (res && r.result !== undefined) { res.textContent = r.result; const old = d.querySelector('.previews'), pv = previews(r.result); if (pv) { if (old) old.replaceWith(pv); else d.appendChild(pv); } }
    d.dataset.slim = '0';
  } catch {} finally { delete d.dataset.loading; }
}, true);

async function showConversation() {
  const log = $('log'), myId = cur.id; log.innerHTML = ''; run = null;
  for (const k in toolRows) delete toolRows[k]; for (const k in permCards) delete permCards[k];
  const s = seats.find((x) => x.name === cur.seat);
  if (cur.id && !convo[cur.id]) {
    // live events that arrive while the snapshot loads are kept and applied after it (snapshot.total says which ones it already holds)
    loading = { id: cur.id, buf: [] };
    const r = await api('/api/conversation?id=' + cur.id);
    if (cur.id !== myId) return;   // the user moved on while it loaded
    const st0 = convo[cur.id] = { events: r.events, pending: new Set(r.pending), from: r.from || 0, total: r.total || 0 };
    const buf = loading.buf, hello = loading.hello; loading = null;
    // The server's hello (first message of the stream) counts the events that existed when the stream registered: more than the snapshot holds = something was emitted in between (an approval card, say), so load again.
    if (hello > (r.total || 0)) { delete convo[myId]; return resync(); }
    for (const d of buf) applyEvent(d, st0, false);
  }
  const st = cur.id && convo[cur.id], c = curConv();
  if (!st || !st.events.length) log.appendChild(div('empty', 'New conversation. Write a task below.'));
  else {
    // The server sends the last 500 events; the ones before are fetched on demand (index = position in the server's list).
    if (st.from > 0) log.appendChild(div('note', `<button type="button" data-earlier="1">Load earlier (${st.from} more)</button>`));
    const frag = document.createDocumentFragment();   // one DOM insert for the whole window, not one per event
    st.events.forEach((e) => render(e, st, frag));
    log.appendChild(frag);
  }
  log.scrollTop = log.scrollHeight;
  $('head').innerHTML = `<button id="menu" aria-label="Seats">☰</button><span id="htitle" dir="auto" ${c ? 'title="Double-click to rename"' : ''}>${esc(c ? c.title : s.name + ': new conversation')}</span>`
    + (c ? '<button type="button" id="renamebtn" aria-label="Rename conversation">✎</button>' : '')
    + `<small>${esc(s.name)} · ${esc(s.email)}</small>` + (c ? `<span class="badge ${c.mode}">${c.mode}</span>` : '') + ctxBtnHtml(c)
    + `<button type="button" id="toolsbtn" aria-pressed="${showTools}">Show actions</button>`;
  closeCtx();
  $('cwd').value = c ? c.cwd : s.cwd;
  // An existing conversation's model and effort come from the conversation: left on whatever the last one used, the next message would silently restart it with those.
  if (c) { $('model').value = c.model || ''; $('effort').value = Math.max(0, EFFORTS.indexOf(c.effort || '')); $('effortOut').textContent = c.effort || 'default'; }
  $('mode').disabled = !!c; if (c) $('mode').value = c.mode;
  $('banner').hidden = !(c && (c.status === 'interrupted' || c.status === 'stopped'));
  $('banner').firstElementChild.textContent = c && c.status === 'interrupted' ? 'Interrupted: the server restarted while this turn was running. Resume continues the same session.' : 'Stopped. Sending a message resumes this conversation.';
  $('menu').onclick = () => document.body.classList.toggle('drawer');
  // A remote run (server: remote.mjs) is read-only: no composer, no pins; the server refuses every POST for it anyway.
  const ro = !!c?.remote; $('composer').hidden = ro; $('readonly').hidden = !ro; document.body.classList.toggle('readonly', ro);
  // A remote with "control": true can pick a finished run up again: Continue opens a NEW conversation there that resumes the run's session.
  const ctl = ro && !!s.control; $('continue').hidden = !ctl;
  $('readonly').firstElementChild.textContent = ctl ? 'A run on the remote server, shown as its log.' : 'Read-only: this run lives on a remote server. Nothing can be sent from here.';
  menuMark(); showMarks();
}

// ---- context window meter: header chip + panel (breakdown, "until auto-compact", Refresh, Compact session). Numbers come from the server (c.ctx), the CLI's own output. ----
const kfmt = (n) => (n = Number(n) || 0, n >= 1e6 ? +(n / 1e6).toFixed(2) + 'M' : n >= 1000 ? +(n / 1000).toFixed(1) + 'k' : String(n));
const ctxText = (x) => x.window ? `${kfmt(x.used)} / ${kfmt(x.window)} (${Math.round(x.pct)}%)` : kfmt(x.used);
const ctxBtnHtml = (c) => {
  const x = c?.ctx; if (!x) return '';
  return `<button type="button" id="ctxbtn" class="cx-${x.level || 'none'}" aria-haspopup="dialog" aria-expanded="${!$('ctxpanel').hidden}" title="Context window"><span class="cxbar"><i style="width:${Math.min(100, x.pct || 0)}%"></i></span><span>${x.compacting ? 'compacting…' : ctxText(x)}</span></button>`;
};
const ctxBusy = (c) => c.remote || c.status === 'working' || c.status === 'waiting' || c.status === 'interrupted' || c.ctx?.compacting;
function ctxPanelHtml(c) {
  const x = c.ctx, b = x.breakdown;
  const rows = b ? b.categories.map((k) => `<tr class="${/deferred/.test(k.name) || k.derived ? 'def' : ''}"><td>${esc(k.name)}</td><td>${kfmt(k.tokens)}</td><td>${k.pct}%</td></tr>`).join('') : '';
  return `<h3>Context window</h3><div><b>${esc(ctxText(x))}</b></div>`
    + (x.window ? `<span class="cxbar cx-${x.level}"><i style="width:${Math.min(100, x.pct)}%"></i></span>` : '')
    + (x.left != null ? `<small>${x.left ? kfmt(x.left) + ' until auto-compact' : 'at the auto-compact threshold'}</small>` : '')
    + (b ? `<table>${rows}</table><small>breakdown from ${clock(b.at)}</small>` : '<small>No breakdown yet. Refresh reads it from the CLI (/context) while the conversation is idle.</small>')
    + `<div class="cxacts"><button type="button" id="cxrefresh" ${ctxBusy(c) ? 'disabled' : ''}>Refresh</button><button type="button" id="cxcompact" class="primary" ${ctxBusy(c) ? 'disabled' : ''}>${x.compacting ? 'Compacting…' : 'Compact session'}</button></div><small id="cxmsg" role="status"></small>`;
}
// Redraws the chip and, when open, the panel; called when the conversation opens and on every server update of it.
function refreshCtx() {
  const c = curConv(), old = $('ctxbtn');
  if (!c?.ctx) { old?.remove(); $('ctxpanel').hidden = $('ctxscrim').hidden = true; return; }
  if (old) old.outerHTML = ctxBtnHtml(c); else $('head').insertAdjacentHTML('beforeend', ctxBtnHtml(c));
  if (!$('ctxpanel').hidden) { const msg = $('cxmsg')?.textContent || ''; $('ctxpanel').innerHTML = ctxPanelHtml(c); $('cxmsg').textContent = msg; }   // keep the last Refresh/Compact answer across live updates
}
const closeCtx = () => { $('ctxpanel').hidden = $('ctxscrim').hidden = true; $('ctxbtn')?.setAttribute('aria-expanded', 'false'); };
$('head').addEventListener('click', (e) => {
  if (!e.target.closest('#ctxbtn')) return;
  const open = $('ctxpanel').hidden; $('ctxpanel').hidden = $('ctxscrim').hidden = !open;
  if (open) $('ctxpanel').innerHTML = ctxPanelHtml(curConv());
  $('ctxbtn').setAttribute('aria-expanded', String(open));
});
$('head').addEventListener('click', (e) => {
  const b = e.target.closest('#toolsbtn'); if (!b) return;
  showTools = !showTools; try { localStorage.setItem('showTools', showTools ? '1' : '0'); } catch {}
  b.setAttribute('aria-pressed', String(showTools)); document.querySelectorAll('#log details.toolrun').forEach((r) => { r.open = showTools; });
});
$('ctxscrim').onclick = closeCtx;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtx(); });
$('ctxpanel').addEventListener('click', async (e) => {
  const act = e.target.closest('#cxrefresh') ? 'context' : e.target.closest('#cxcompact') ? 'compact' : null; if (!act) return;
  let instructions;
  if (act === 'compact') { instructions = prompt('Compact this conversation. What should be kept? (optional)', ''); if (instructions === null) return; }
  $('cxmsg').textContent = act === 'compact' ? 'Compacting…' : 'Reading…';
  const r = await api('/api/' + act, { conversationId: cur.id, instructions: instructions || undefined });
  if (r.error) $('cxmsg').textContent = r.error;
});

// Usage meter: the CLI reports the account's rate-limit windows with each turn (rate_limit_event); a window already past its reset is stale and hidden.
// The 5 h window stays visible after its reset as "reset" at 0 % (until a new event arrives); other windows past their reset are hidden.
const p2 = (n) => String(n).padStart(2, '0');
const clock = (ms) => { const d = new Date(ms); return p2(d.getHours()) + ':' + p2(d.getMinutes()); };
const until = (ms) => { const m = Math.ceil((ms - Date.now()) / 60000); return m > 0 && m < 180 ? ` · in ${Math.floor(m / 60)}:${p2(m % 60)}` : ''; };
const resetText = (ms) => ms <= Date.now() ? 'reset' : 'resets ' + clock(ms) + until(ms);
const meter = (u) => !u ? '' : Object.entries(u.windows).filter(([k, v]) => k === 'five_hour' || v.resetsAt * 1000 > Date.now()).map(([k, v]) => {
  const gone = v.resetsAt * 1000 <= Date.now(), pct = gone ? 0 : Math.round(v.utilization * 100);
  return `<small class="meter" title="resets ${esc(new Date(v.resetsAt * 1000).toLocaleString())}">${esc(k.replace(/_/g, ' '))} <span class="bar"><i style="width:${Math.min(100, pct)}%"></i></span> ${pct}% <span class="reset" dir="auto">${resetText(v.resetsAt * 1000)}</span></small>`;
}).join('');
// Composer warning: at 80 % or more of the 5 h window, name the seat with the most quota left ("ops at 85%, info free (12%)").
function showQuota() {
  const util = (s) => { const w = s.usage?.windows?.five_hour; return w ? (w.resetsAt * 1000 <= Date.now() ? 0 : w.utilization) : null; };
  const me = seats.find((s) => s.name === cur.seat), u = me && util(me), box = $('quota');
  if (u == null || u < 0.8) { box.hidden = true; return; }
  const alt = seats.filter((s) => s !== me && util(s) != null).sort((a, b) => util(a) - util(b))[0];
  const iso = (n) => '\u2068' + n + '\u2069';   // FSI/PDI: a Latin seat name inside a right-to-left sentence keeps its place
  box.textContent = `${iso(me.name)} at ${Math.round(u * 100)}%` + (alt ? `, ${iso(alt.name)} free (${Math.round(util(alt) * 100)}%)` : '');
  box.hidden = false;
}
const showArch = (() => { try { return JSON.parse(localStorage.getItem('showArch') || '{}'); } catch { return {}; } })();
let menuFor = null;   // conversation id whose ⋯ menu is open
const convRow = (c, seat) => `<div class="convrow ${c.archived ? 'archived' : ''}"><button class="conv ${c.id === cur.id ? 'on' : ''} ${c.pending ? 'ask' : ''} ${c.needsAnswer ? 'answer' : ''}" data-id="${c.id}" data-seat="${seat}">
      <span class="dot ${c.status === 'stopped' ? '' : c.status}"></span><span class="t" dir="auto">${esc(c.title)}</span>${c.ctx?.pct != null ? `<span class="cxpct cx-${c.ctx.level}" title="Context window ${esc(ctxText(c.ctx))}">${Math.round(c.ctx.pct)}%</span>` : ''}
      <span class="cost" title="API-price estimate, not billed (subscription)">~$${(c.cost || 0).toFixed(2)}</span>
      <small>${c.mode === 'bypass' ? '<span class="badge bypass">bypass</span> ' : ''}${label[c.status] || c.status}${c.background ? ' · ' + c.background : ''}${c.pending ? ' · ' + c.pending + ' waiting' : ''}</small>${c.needsAnswer ? '<span class="needs">❓ waiting for your answer</span>' : ''}</button>
      ${c.remote ? '' : `<button class="more" data-more="${c.id}" aria-label="Conversation menu">⋯</button>`}</div>`
  + (menuFor === c.id ? `<div class="cmenu"><button data-rename="${c.id}" data-seat="${seat}">Rename</button><button data-archive="${c.id}" data-to="${!c.archived}">${c.archived ? 'Unarchive' : 'Archive'}</button><button class="danger" data-del="${c.id}">Delete</button></div>` : '');

function showSeats() {
  showQuota(); menuMark();
  $('seats').innerHTML = seats.map((s) => {
    const live = s.conversations.filter((c) => !c.archived), arch = s.conversations.filter((c) => c.archived);
    return `<section class="seatbox"><div class="seathead ${s.name === cur.seat && !cur.id ? 'on' : ''}"><div><b>${esc(s.name)}</b><small>${esc(s.email)}</small><small class="role" dir="auto">${esc(s.role)}</small>${meter(s.usage)}</div>
    ${s.remote && !s.control ? '' : `<button data-new="${s.name}" title="New conversation">+ new</button>`}</div>`
    + live.slice(0, 12).map((c) => convRow(c, s.name)).join('')
    + (arch.length ? `<button class="archtoggle" data-archtoggle="${s.name}">${showArch[s.name] ? 'Hide' : 'Show'} archived (${arch.length})</button>` : '')
    + (showArch[s.name] ? arch.map((c) => convRow(c, s.name)).join('') : '') + '</section>';
  }).join('');
}

// The sidebar is rebuilt at most once per frame and not more than 4 times a second, however many updates arrive.
let seatsAt = 0, seatsTimer = 0;
function scheduleSeats() {
  if (seatsTimer) return;
  seatsTimer = setTimeout(() => { seatsTimer = 0; seatsAt = performance.now(); requestAnimationFrame(showSeats); }, Math.max(0, 250 - (performance.now() - seatsAt)));
}
async function pick(seat, id) {
  if (!id && seats.find((s) => s.name === seat && s.remote && !s.control)) seat = seats.find((s) => !s.remote).name;   // a read-only remote group has no new-conversation draft (no composer)
  cur = { seat, id }; localStorage.setItem('seat', seat);
  pending.length = 0; showThumbs();
  if (id) delete convo[id];                // events of a conversation that was not watched were not delivered: always load it fresh
  watch(true);                             // the stream carries full events only for the open conversation
  document.body.classList.remove('drawer'); showSeats(); await showConversation();
}

// ---- live stream (SSE): /api/events?conv=<open conversation>. A frozen background tab, a sleeping PC or a server restart can leave it dead without any error,
// so the server pings every 20 s: no ping for 50 s -> reopen. Every reopen and every return to the tab resyncs what was missed (not a deliberate switch).
let es = null, beat = Date.now(), opened = false, quiet = false;
function watch(deliberate) {
  if (es) es.close(); quiet = !!deliberate; beat = Date.now();
  es = new EventSource('/api/events' + (cur.id ? '?conv=' + encodeURIComponent(cur.id) : ''));
  es.onopen = () => { beat = Date.now(); if (opened && !quiet) resync(); opened = true; quiet = false; };
  es.addEventListener('ping', () => { beat = Date.now(); });
  es.onmessage = onEvent;
}
// Events of the open conversation are drawn once per animation frame, all in one fragment.
const queue = []; let flushing = false;
function applyEvent(d, st, draw = true) {
  if (d.event.i != null) { if (d.event.i < (st.total || 0)) return; st.total = d.event.i + 1; }   // already in the snapshot
  if (d.event.type === 'console_perm') st.pending.add(d.event.requestId);
  if (d.event.type === 'console_perm_done') st.pending.delete(d.event.requestId);
  st.events.push(d.event);
  if (draw && d.convId === cur.id) { queue.push(d.event); if (!flushing) { flushing = true; requestAnimationFrame(flush); } }
}
function flush() {
  flushing = false; const st = convo[cur.id]; if (!st || !queue.length) { queue.length = 0; return; }
  const log = $('log'), atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 120, frag = document.createDocumentFragment();
  if (log.querySelector('.empty')) log.innerHTML = '';
  for (const e of queue.splice(0)) render(e, st, frag);
  log.appendChild(frag); if (atEnd) log.scrollTop = log.scrollHeight;
}

async function init() {
  seats = await api('/api/seats');
  if (!seats.find((s) => s.name === cur.seat && (!s.remote || s.control))) cur.seat = seats[0].name;   // a read-only remote group has no "new conversation" draft
  await pick(cur.seat, null);
  openHash(); window.addEventListener('hashchange', openHash);
  loadRoutines(); setInterval(() => { if (!document.hidden) loadRoutines(); }, 30000);
  setInterval(() => { if (!document.hidden) showSeats(); }, 60000);   // keeps the "in 1:12" countdowns and expired windows current
  setInterval(() => { if (Date.now() - beat > 50000) watch(false); }, 10000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resync(); });
}

function onEvent(m) {
  beat = Date.now();
  const d = JSON.parse(m.data);
  if ('saveError' in d) { $('saveBanner').hidden = !d.saveError; return; }   // the server cannot write state.json: shown until a save works again
  if (d.removed) {
    for (const s of seats) s.conversations = s.conversations.filter((c) => c.id !== d.removed);
    delete convo[d.removed]; scheduleSeats();
    if (cur.id === d.removed) pick(cur.seat, null);
    return;
  }
  if (d.usage) { const s = seats.find((x) => x.name === d.usage.seat); if (s) { s.usage = { windows: d.usage.windows, at: d.usage.at }; scheduleSeats(); } return; }
  if (d.hello) {   // before d.conv: a hello carries `conv` as a plain id string, not a summary object
    if (d.conv !== cur.id) return;
    if (loading && loading.id === d.conv) loading.hello = d.total;   // snapshot still loading: compared when it arrives
    else { const st = convo[d.conv]; if (st && (st.total || 0) < d.total) resync(); }
    return;
  }
  if (d.conv) {
    const s = seats.find((x) => x.name === d.conv.seat), i = s.conversations.findIndex((c) => c.id === d.conv.id);
    if (i >= 0) s.conversations[i] = d.conv; else s.conversations.unshift(d.conv);
    s.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    scheduleSeats();
    if (d.conv.id === cur.id) { refreshCtx(); $('banner').hidden = !(d.conv.status === 'interrupted' || d.conv.status === 'stopped'); showMarks(); const h = $('htitle'); if (h && !h.isContentEditable) h.textContent = d.conv.title; }
    return;
  }
  if (loading && loading.id === d.convId && !convo[d.convId]) { loading.buf.push(d); return; }
  const st = convo[d.convId]; if (st) applyEvent(d, st);
}

// ---- what a finished turn leaves for the user (server: marks.mjs): the pin bar over the conversation, suggestion chips over the input, the "waiting for your answer" mark ----
const pinBtn = () => { const b = document.createElement('button'); b.type = 'button'; b.className = 'pinbtn'; b.dataset.pin = '1'; b.setAttribute('aria-label', 'Pin this message'); b.textContent = '📌'; return b; };
const PIN_ICON = { question: '❓', link: '🔗', error: '⚠️', manual: '📌' };
function showMarks() {
  const c = curConv(), pins = c?.pins || [], sug = c && c.status !== 'working' && c.status !== 'waiting' ? c.suggest || [] : [];
  $('pins').hidden = !pins.length;
  $('pins').innerHTML = pins.map((p) => `<span class="pin ${p.kind}"><button type="button" class="pjump" data-jump="${p.i}" dir="auto" title="Show the message">${PIN_ICON[p.kind] || '📌'} ${esc(p.text)}</button>`
    + (p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" aria-label="Open link">↗</a>` : '') + `<button type="button" class="pdone" data-done="${esc(p.id)}" aria-label="Done, release this pin">✓</button></span>`).join('');
  $('suggest').hidden = !sug.length;
  $('suggest').innerHTML = sug.map((t) => `<button type="button" class="chip" dir="auto" data-sug="${esc(t)}">↩ ${esc(t)}</button>`).join('');
}
// Phone: the sidebar is a closed drawer, so the ☰ button carries the mark when ANOTHER conversation waits for an answer.
const menuMark = () => $('menu')?.classList.toggle('ans', allConvs().some((c) => c.needsAnswer && c.id !== cur.id && !c.archived));
$('pins').onclick = async (e) => {
  const d = e.target.closest('[data-done]'); if (d) { const r = await api('/api/pin', { conversationId: cur.id, action: 'done', id: d.dataset.done }); if (r.error) alert(r.error); return; }
  const j = e.target.closest('[data-jump]'); if (!j) return;
  // the message the pin points at = the last message at or before its event index (a question pin points at the turn's result, the reply text sits just before it)
  const at = +j.dataset.jump, el = [...$('log').querySelectorAll('.msg.assistant[data-i], .msg.user[data-i], .msg.note.err[data-i]')].filter((x) => +x.dataset.i <= at).pop();
  if (!el) return alert('That message is older than the loaded part: use "Load earlier" at the top.');
  el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600);
};
$('suggest').onclick = (e) => { const b = e.target.closest('[data-sug]'); if (!b) return; $('text').value = b.dataset.sug; $('text').focus(); };   // into the input, never sent by itself

// Copy: navigator.clipboard exists only in a secure context (https, 127.0.0.1); over http on the Tailscale IP the old execCommand path does the job.
async function copyText(text, btn) {
  let done = false;
  if (navigator.clipboard && isSecureContext) try { await navigator.clipboard.writeText(text); done = true; } catch {}
  if (!done) {   // the textarea trick moves focus and the selection: both are put back (a half-typed message keeps its cursor)
    const was = document.activeElement, sel = getSelection(), ranges = Array.from({ length: sel.rangeCount }, (_, k) => sel.getRangeAt(k));
    const t = document.createElement('textarea'); t.value = text; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;top:0;left:0;opacity:0'; document.body.appendChild(t);
    t.focus({ preventScroll: true }); t.select(); try { done = document.execCommand('copy'); } catch {} t.remove();
    const caret = was && 'selectionStart' in was ? [was.selectionStart, was.selectionEnd] : null;   // an input's caret is not part of the document selection
    sel.removeAllRanges(); ranges.forEach((r) => sel.addRange(r)); was?.focus?.({ preventScroll: true }); if (caret) was.setSelectionRange(...caret);
  }
  btn.textContent = done ? '✓ copied' : 'copy failed'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
}

// Rename: double-click the title or ✎ (header), or Rename in the row's ⋯ menu. Enter saves, Esc or leaving the field cancels.
function startRename() {
  const h = $('htitle'), c = curConv(); if (!h || !c || h.isContentEditable) return;
  try { h.contentEditable = 'plaintext-only'; } catch { h.contentEditable = 'true'; }   // older Firefox throws on plaintext-only
  h.classList.add('editing'); h.focus(); getSelection().selectAllChildren(h);
  const end = async (save) => {
    h.onkeydown = h.onblur = null; h.contentEditable = 'false'; h.classList.remove('editing');
    const t = h.textContent.trim();
    if (!save || !t || t === c.title) { h.textContent = c.title; return; }
    const r = await api('/api/rename', { conversationId: c.id, title: t });
    if (r.error) { alert(r.error); h.textContent = c.title; } else { c.title = r.title; h.textContent = r.title; showSeats(); }
  };
  h.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); end(true); } else if (e.key === 'Escape') { e.preventDefault(); end(false); } };
  h.onblur = () => end(false);
}
$('head').addEventListener('dblclick', (e) => { if (e.target.closest('#htitle')) startRename(); });
$('head').addEventListener('click', (e) => { if (e.target.closest('#renamebtn')) startRename(); });

// Refetch the seat list and the open conversation from the server (the source of truth).
async function resync() {
  seats = await api('/api/seats'); loadRoutines();
  for (const k in convo) delete convo[k];
  showSeats(); await showConversation();
}

// ---- routines: recurring prompts. At their due time the console only ASKS on Telegram; a run starts on a tap there, or on "Run now" here (that click is the approval). ----
let routineList = [];
const DECISION = { pending: 'asked, waiting for a tap', blocked: 'asked, seat busy', run: 'started', skip: 'skipped', expired: 'expired', initial: 'past at first start, not asked' };
const when = (ms) => (new Date(ms).toDateString() === new Date().toDateString() ? 'today' : new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'numeric' })) + ' ' + clock(ms);
async function loadRoutines() { try { routineList = await api('/api/routines'); } catch { return; } showRoutines(); }
function showRoutines() {
  $('routines').innerHTML = '<h2>⏰ Routines</h2>' + routineList.map((r) => {
    const run = r.conversationId || r.lastRun?.conversationId;
    const last = r.lastAskedFor ? `last ask ${when(r.lastAskedFor)}: ${DECISION[r.decision] || r.decision}` : r.lastRun ? `last run ${when(r.lastRun.at)} (${r.lastRun.by})` : 'never asked';
    return `<div class="routine ${r.enabled ? '' : 'off'}"><div><b dir="auto">${esc(r.id)}</b><small>${esc(r.seat)} · ${r.enabled ? 'next ' + (r.nextDue ? when(r.nextDue) : '-') : 'disabled'}</small>`
      + `<small>${esc(last)}${run ? ` · <a href="#${esc(run)}">open run</a>` : ''}</small></div>`
      + `<div class="racts"><button data-rrun="${esc(r.id)}" data-seat="${esc(r.seat)}">Run now</button><button data-rtoggle="${esc(r.id)}" data-to="${r.enabled ? 'disable' : 'enable'}">${r.enabled ? 'Disable' : 'Enable'}</button></div></div>`;
  }).join('');
}
$('routines').onclick = async (e) => {
  const run = e.target.closest('[data-rrun]'), tog = e.target.closest('[data-rtoggle]');
  if (run && !confirm(`Start ${run.dataset.rrun} now on ${run.dataset.seat}?`)) return;
  const r = run ? await api('/api/routine', { id: run.dataset.rrun, action: 'run' }) : tog ? await api('/api/routine', { id: tog.dataset.rtoggle, action: tog.dataset.to }) : null;
  if (!r) return;
  if (r.error) alert(r.error);
  await loadRoutines();
  if (r.conversationId) location.hash = r.conversationId;
};
$('seats').onclick = async (e) => {
  const mo = e.target.closest('[data-more]'); if (mo) { menuFor = menuFor === mo.dataset.more ? null : mo.dataset.more; return showSeats(); }
  const ar = e.target.closest('[data-archive]'); if (ar) { menuFor = null; await api('/api/archive', { conversationId: ar.dataset.archive, archived: ar.dataset.to === 'true' }); return; }
  const de = e.target.closest('[data-del]');
  if (de) {
    menuFor = null; showSeats();
    if (!confirm('Delete this conversation, its log and its uploaded images? This cannot be undone.')) return;
    const r = await api('/api/delete', { conversationId: de.dataset.del }); if (r.error) alert(r.error); return;
  }
  const at = e.target.closest('[data-archtoggle]'); if (at) { showArch[at.dataset.archtoggle] = !showArch[at.dataset.archtoggle]; try { localStorage.setItem('showArch', JSON.stringify(showArch)); } catch {} return showSeats(); }
  const rn = e.target.closest('[data-rename]'); if (rn) { menuFor = null; if (rn.dataset.rename !== cur.id) await pick(rn.dataset.seat, rn.dataset.rename); else showSeats(); return startRename(); }
  const n = e.target.closest('[data-new]'); if (n) return pick(n.dataset.new, null);
  const b = e.target.closest('[data-id]'); if (b) pick(b.dataset.seat, b.dataset.id);
};
$('log').onclick = async (e) => {
  const cp = e.target.closest('button[data-copy]'); if (cp) return copyText(cp.nextElementSibling.textContent, cp);
  const pn = e.target.closest('button[data-pin]');
  if (pn) {   // manual 📌: the message text without its buttons
    const m = pn.closest('.msg'), t = m.cloneNode(true); t.querySelectorAll('button').forEach((x) => x.remove());
    const r = await api('/api/pin', { conversationId: cur.id, action: 'add', i: +m.dataset.i, text: t.textContent }); if (r.error) alert(r.error); return;
  }
  if (e.target.closest('button[data-earlier]')) {
    const st = convo[cur.id]; if (!st || !st.from) return;
    const r = await api(`/api/conversation?id=${cur.id}&before=${st.from}`); if (r.error) return;
    st.events = r.events.concat(st.events); st.from = r.from;
    const log = $('log'), h = log.scrollHeight; await showConversation(); log.scrollTop = log.scrollHeight - h; // keep the reader where they were
    return;
  }
  const b = e.target.closest('button[data-a]'); if (!b) return;
  const card = b.closest('.perm');
  b.parentElement.innerHTML = '<em>sending…</em>';
  const r = await api('/api/permission', { conversationId: cur.id, requestId: card.dataset.req, allow: b.dataset.a === '1' });
  if (r.error) card.querySelector('.acts').innerHTML = `<em>${esc(r.error)}</em>`;
};
$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('text').value.trim() || (pending.length ? (pending.some((p) => p.file) ? 'See the attached file.' : 'See the attached image.') : ''); if (!text) return;
  if (!cur.id && $('mode').value === 'bypass' && !confirm('Bypass mode: this conversation runs EVERY tool without asking. Start it?')) return;
  $('text').value = '';
  const r = await api('/api/send', { seat: cur.seat, conversationId: cur.id || undefined, text, cwd: $('cwd').value.trim() || undefined, model: $('model').value || undefined, effort: EFFORTS[$('effort').value] || undefined, mode: cur.id ? undefined : $('mode').value, images: pending.filter((p) => !p.file).map((p) => p.id), files: pending.filter((p) => p.file).map((p) => p.id), draftId });
  if (r.error) { $('log').appendChild(div('msg note err', esc(r.error))); $('text').value = text; return; }
  pending.length = 0; showThumbs(); draftId = newDraftId();
  if (!cur.id) { cur.id = r.conversationId; await pick(cur.seat, r.conversationId); }
};
// On a touch screen Enter only adds a line and Send sends: a phone keyboard's Enter would send half-written messages.
const TOUCH = matchMedia('(pointer: coarse)').matches;
if (TOUCH) { $('text').placeholder = 'Message this seat. Tap Send to send.'; $('text').enterKeyHint = 'enter'; }
$('text').onkeydown = (e) => { if (!TOUCH && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); } };
$('stop').onclick = () => cur.id && api('/api/stop', { conversationId: cur.id });
$('continue').onclick = async () => {
  const r = await api('/api/remote-continue', { id: cur.id }); if (r.error) return alert(r.error);
  seats = await api('/api/seats'); await pick(cur.seat, r.conversationId);
};
$('resume').onclick = async () => { const r = await api('/api/resume', { conversationId: cur.id }); if (r.error) $('log').appendChild(div('msg note err', esc(r.error))); };
// A phone link from Telegram ends in #<conversationId>.
function openHash() {
  const c = allConvs().find((x) => x.id === location.hash.slice(1));
  if (c && c.id !== cur.id) pick(c.seat, c.id);
}

// Hand a finished result to another seat: a NEW conversation there, text prefilled (not sent), folder copied from this one.
async function handoff(seat, result) {
  const c = curConv(); if (!c) return;
  await pick(seat, null);
  $('cwd').value = c.cwd;
  $('text').value = `Continuation from ${c.seat} (${c.title}):\n\n${result}\n\n`;
  $('text').focus();
}

// ---- attachments (button: any file; clipboard paste: images). Uploaded at once, referenced by id when the message is sent. The server decides image or file by magic bytes. ----
const pending = [];          // { id, url } image / { id, file: true, name, size } other file, uploaded but not yet sent
const sizeText = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
// Random per draft, sent with upload and send: the server only lets a send claim staged files that carry its own draft id.
// getRandomValues, not randomUUID: the page is plain http over Tailscale, where randomUUID does not exist.
const newDraftId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
let draftId = newDraftId();
function showThumbs() {
  const t = $('thumbs'); t.hidden = !pending.length;
  t.innerHTML = pending.map((p, i) => `<span class="thumbwrap">${p.file ? `<span class="fchip" dir="ltr">📎 <bdi>${esc(p.name)}</bdi> · ${sizeText(p.size)}</span>` : `<img class="thumb" alt="attached image" src="${p.url}">`}<button type="button" data-rm="${i}" aria-label="Remove ${p.file ? 'file' : 'image'}">×</button></span>`).join('');
}
// The API refuses images over 5 MB, so big phone photos are re-encoded smaller in the browser first.
async function shrink(f) {
  if (f.size < 4 * 1024 * 1024 || f.type === 'image/gif') return f;
  try {
    const bmp = await createImageBitmap(f), k = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    return await new Promise((ok) => cv.toBlob((b) => ok(b || f), 'image/jpeg', 0.85));
  } catch { return f; }
}
async function attach(files) {
  for (let f of files) {
    const name = f.name;
    if (f.type.startsWith('image/')) f = await shrink(f);
    const r = await fetch('/api/upload' + (cur.id ? '?conv=' + cur.id : '?draft=' + draftId) + '&name=' + encodeURIComponent(name || 'file'), { method: 'POST', headers: { 'X-Seat-Token': TOKEN }, body: f })
      .then((x) => x.json(), () => ({ error: 'upload failed' }));
    if (r.error) { $('log').appendChild(div('msg note err', esc(`${name}: ${r.error}`))); continue; }
    pending.push(r.file ? { id: r.id, file: true, name: r.name, size: r.size } : { id: r.id, url: URL.createObjectURL(f) });
  }
  showThumbs();
}
$('attach').onclick = () => $('file').click();
$('file').onchange = () => { attach([...$('file').files]); $('file').value = ''; };
$('thumbs').onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) { pending.splice(+b.dataset.rm, 1); showThumbs(); } };
$('text').addEventListener('paste', (e) => { const fs = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/')); if (fs.length) { e.preventDefault(); attach(fs); } });
init();

// Effort slider: stop 0 keeps the seat's default, stops 1-5 are the CLI's --effort levels, stop 6 is ultracode (see server.mjs).
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
$('effort').addEventListener('input', () => { $('effortOut').textContent = EFFORTS[$('effort').value] || 'default'; });

// Installable app (PWA): the service worker only runs on https or 127.0.0.1; on plain http over Tailscale this is skipped silently.
if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
