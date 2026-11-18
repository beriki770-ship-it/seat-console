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
// ---- language: strings in /locales/<code>.json (en.json is the source; the bot uses the same files). The server writes the chosen language into <html lang dir>.
// t(key, vars): locale -> English -> the key. tn(): plural by the language's rules (key.one / key.few / key.other ...). Dates and numbers: Intl, same locale.
const RTL = ['he', 'ar'];
let LANG = document.documentElement.lang || 'en', L = {}, EN = {};
const intl = () => (LANG === 'en' ? 'en-GB' : LANG);   // English is written day-first on a 24-hour clock, as the console always did
const fill = (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, n) => (Object.hasOwn(v, n) ? v[n] : m)) : s);
const t = (k, v) => fill(L[k] ?? EN[k] ?? k, v);
const tk = (prefix, k) => { const s = t(prefix + k); return s === prefix + k ? k : s; };   // a value from the server (status, window name): its label, or the value itself
const tn = (k, n, v) => { const p = (d, code) => d[`${k}.${new Intl.PluralRules(code).select(n)}`] ?? d[`${k}.other`]; return fill(p(L, LANG) ?? p(EN, 'en') ?? k, { n: num(n), ...v }); };
const num = (n, o) => new Intl.NumberFormat(intl(), o).format(n);
const pct = (u) => num(Math.round(u * 100) / 100, { style: 'percent', maximumFractionDigits: 0 });
const usd = (n) => num(n, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 });
async function loadLang(code) {
  const get = (c) => fetch(`/locales/${c}.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  if (!EN.__loaded) EN = { ...(await get('en')), __loaded: 1 };
  L = code === 'en' ? EN : await get(code);
  LANG = code; document.documentElement.lang = code; document.documentElement.dir = RTL.includes(code) ? 'rtl' : 'ltr';
  applyStatic();
}
// index.html's own text: data-i18n (text), data-i18n-title / -placeholder / -aria-label / -label (attributes).
function applyStatic(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const a of ['title', 'placeholder', 'aria-label', 'label']) for (const el of root.querySelectorAll(`[data-i18n-${a}]`)) el.setAttribute(a, t(el.getAttribute('data-i18n-' + a)));
}
const label = (s) => tk('status.', s);

// Minimal markdown: fenced code, lists, paragraphs, inline code, bold, links. Everything is escaped first.
// A code block gets a Copy button (raw text, see copyText) and ONE direction for the whole block (blockDir): per-line bidi broke the indentation of code with Hebrew comments.
function md(src) {
  const parts = src.split(/```[^\n]*\n?/);
  return parts.map((p, i) => i % 2 ? `<div class="code"><button type="button" class="copy" data-copy aria-label="${t('code.copyLabel')}">${t('code.copy')}</button><pre dir="${blockDir(p)}"><code>${esc(p.replace(/\n$/, ''))}</code></pre></div>` : p.split(/\n{2,}/).map((blk) => {
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
    const gone = () => { card.className = 'pcard gone'; card.innerHTML = `<small dir="auto">${t('file.notAvailable', { name: `<bdi>${esc(name)}</bdi>` })}</small>`; };
    let el;
    if (kind === 'video') { el = document.createElement('video'); el.controls = true; el.preload = 'metadata'; el.playsInline = true; whenVisible(card, () => { el.src = src; }); }
    else if (kind === 'image') { el = document.createElement('a'); el.href = src; el.target = '_blank'; el.rel = 'noopener'; el.innerHTML = `<img loading="lazy" alt="${esc(name)}" src="${src}">`; el.firstChild.onerror = gone; }
    else { el = document.createElement('a'); el.href = src; el.target = '_blank'; el.rel = 'noopener'; el.className = 'open'; el.textContent = t('file.open', { name }); whenVisible(card, () => fetch(src, { method: 'HEAD' }).then((r) => { if (!r.ok) gone(); }, gone)); }
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
  r.firstChild.innerHTML = `🔧 ${tn('run.actions', n)} · <bdi>${top}</bdi>` + (r._err ? ` <span class="runerr">· ⚠ ${tn('run.errors', r._err)}</span>` : '');
}
function newRun() {
  const r = document.createElement('details'); r.className = 'toolrun'; r.open = showTools; r._count = {}; r._err = 0;
  r.innerHTML = '<summary dir="auto"></summary><div class="runbody"></div>'; return r;
}
function render(ev, st, target = $('log')) {
  const out = [];
  if (ev.type === 'console_user') {
    const u = div('msg user', esc(ev.text)); u.dir = 'auto'; u.appendChild(pinBtn());
    if (ev.images?.length) { const th = div('thumbs', ''); for (const n of ev.images) { const src = `/api/file?conv=${encodeURIComponent(cur.id)}&upload=${encodeURIComponent(n)}`; th.insertAdjacentHTML('beforeend', `<a href="${src}" target="_blank" rel="noopener"><img class="thumb" loading="lazy" alt="${t('composer.attachedImage')}" src="${src}"></a>`); } u.appendChild(th); }
    if (ev.files?.length) { const th = div('thumbs', ''); for (const f of ev.files) th.insertAdjacentHTML('beforeend', `<a class="fchip" dir="ltr" href="/api/file?conv=${encodeURIComponent(cur.id)}&upload=${encodeURIComponent(f.name)}" target="_blank" rel="noopener">📎 <bdi>${esc(f.label)}</bdi> · ${sizeText(f.size)}</a>`); u.appendChild(th); }
    out.push(u);
  }
  else if (ev.type === 'console_error') out.push(div('msg note err', esc(ev.text)));
  else if (ev.type === 'console_spawn') out.push(div('msg note', t('log.started', { mode: esc(tk('mode.', ev.mode)), pid: ev.pid })));
  else if (ev.type === 'console_perm') {
    const live = st.pending.has(ev.requestId);
    const card = div('msg perm', `<b>${t('perm.wants', { tool: `<bdi>${esc(ev.tool)}</bdi>` })}</b><pre dir="auto">${esc(ev.input.command || ev.blockedPath || JSON.stringify(ev.input, null, 2))}</pre>`
      + (ev.description ? `<small dir="auto">${esc(ev.description)}</small>` : '')
      + `<div class="acts">${live ? `<button class="primary" data-a="1">${t('perm.allow')}</button><button data-a="0">${t('perm.deny')}</button>` : `<em>${t('perm.expired')}</em>`}</div>`);
    card.dataset.req = ev.requestId; permCards[ev.requestId] = card; out.push(card);
  } else if (ev.type === 'console_perm_done') {
    const card = permCards[ev.requestId];
    if (card) card.querySelector('.acts').innerHTML = `<em>${t(ev.allow ? 'perm.allowed' : 'perm.denied')}</em>`;
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
    out.push(div('msg note err', t('log.blocked', { tool: `<bdi>${esc(ev.tool_name)}</bdi>` }) + ` <bdi>${esc(ev.message || '')}</bdi>`));
  } else if (ev.type === 'system' && ev.subtype === 'compact_boundary') {
    const m = ev.compact_metadata || {};
    out.push(div('msg note', t('log.compacted', { trigger: esc(m.trigger || 'manual'), from: kfmt(m.pre_tokens || 0), to: kfmt(m.post_tokens || 0) })));
  } else if (ev.type === 'result' && ev.local_command) {
    // reply of a /context or /compact the console sent itself: the numbers live in the meter, nothing to show here
  } else if (ev.type === 'result') {
    const res = div('msg result', `${ev.is_error ? t('log.errorPrefix') + ' · ' : ''}${t('log.done', { cost: '<bdi dir="ltr">~' + usd(ev.total_cost_usd || 0) + '</bdi>', secs: num(Math.round((ev.duration_ms || 0) / 1000)) })} `);
    if (!ev.is_error && ev.result) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'hand'; b.textContent = t('result.sendTo');
      b.onclick = () => {
        const sel = document.createElement('select'); sel.setAttribute('aria-label', t('result.targetSeat'));
        sel.innerHTML = `<option value="">${t('result.sendTo')}</option>` + seats.filter((s) => !s.remote).map((s) => `<option>${esc(s.name)}</option>`).join('');
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

// Model menu per seat: Claude seats keep the page's own list; an agent seat's list comes from its CLI (/api/models).
const CLAUDE_MODELS = $('model').innerHTML, agentModelCache = {};
async function setModels(s, c) {
  const sel = $('model'), want = c ? c.model || '' : '';
  if (!s?.agent) { if (sel.dataset.agent) { sel.innerHTML = CLAUDE_MODELS; applyStatic(sel); delete sel.dataset.agent; delete sel.dataset.seat; } if (c) sel.value = want; return; }
  if (sel.dataset.agent !== s.agent) { sel.innerHTML = `<option value="">${t('composer.defaultModel')}</option>`; sel.dataset.agent = s.agent; }
  sel.dataset.seat = s.name;
  const list = agentModelCache[s.name] || await api('/api/models?seat=' + encodeURIComponent(s.name)).then((r) => (r.error ? r.models || [] : (agentModelCache[s.name] = r.models || []))).catch(() => []);   // a failed read is retried next time
  if (sel.dataset.agent !== s.agent || sel.dataset.seat !== s.name) return;   // the user moved on to another seat meanwhile
  const def = list.find((m) => m.default);
  sel.innerHTML = `<option value="">${def ? t('composer.defaultModelNamed', { name: esc(def.name) }) : t('composer.defaultModel')}</option>` + list.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
  sel.value = want;
}
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
  if (!st || !st.events.length) log.appendChild(div('empty', t('conv.empty')));
  else {
    // The server sends the last 500 events; the ones before are fetched on demand (index = position in the server's list).
    if (st.from > 0) log.appendChild(div('note', `<button type="button" data-earlier="1">${t('conv.loadEarlier', { n: num(st.from) })}</button>`));
    const frag = document.createDocumentFragment();   // one DOM insert for the whole window, not one per event
    st.events.forEach((e) => render(e, st, frag));
    log.appendChild(frag);
  }
  log.scrollTop = log.scrollHeight;
  $('head').innerHTML = `<button id="menu" aria-label="${t('side.seats')}">☰</button><span id="htitle" dir="auto" ${c ? `title="${t('conv.renameHint')}"` : ''}>${c ? esc(c.title) : t('conv.newTitle', { seat: `<bdi>${esc(s.name)}</bdi>` })}</span>`
    + (c ? `<button type="button" id="renamebtn" aria-label="${t('conv.rename')}">✎</button>` : '')
    + `<small dir="ltr">${esc(s.name)} · ${esc(s.email)}</small>` + (c ? `<span class="badge ${c.mode}">${esc(tk('mode.', c.mode))}</span>` : '') + ctxBtnHtml(c)
    + `<button type="button" id="toolsbtn" aria-pressed="${showTools}">${t('conv.showActions')}</button>`;
  closeCtx();
  $('cwd').value = c ? c.cwd : s.cwd;
  // An existing conversation's model and effort come from the conversation: left on whatever the last one used, the next message would silently restart it with those.
  setModels(s, c);   // an agent seat (Codex, Antigravity) shows ITS models; a Claude seat the Claude list
  if (c) { $('effort').value = Math.max(0, EFFORTS.indexOf(c.effort || '')); $('effortOut').textContent = c.effort || t('composer.effortDefault'); }
  if (c) $('mode').value = c.mode || 'auto';   // a remote run has no mode; changeable on an existing conversation too: the next message restarts it in the new mode (server send())
  $('banner').hidden = !(c && (c.status === 'interrupted' || c.status === 'stopped'));
  $('banner').firstElementChild.textContent = t(c && c.status === 'interrupted' ? 'conv.interrupted' : 'conv.stopped');
  $('menu').onclick = () => document.body.classList.toggle('drawer');
  // A remote run (server: remote.mjs) of a read-only remote: no composer, no pins; the server refuses every POST for it anyway.
  // A remote with "control": true: its run gets the composer, and the first message continues the run's session in a NEW conversation there (composer submit).
  const ro = !!c?.remote, ctl = ro && !!s.control; $('composer').hidden = ro && !ctl; $('readonly').hidden = !ro || ctl; document.body.classList.toggle('readonly', ro && !ctl);
  menuMark(); showMarks();
}

// ---- context window meter: header chip + panel (breakdown, "until auto-compact", Refresh, Compact session). Numbers come from the server (c.ctx), the CLI's own output. ----
const kfmt = (n) => num(Number(n) || 0, { notation: 'compact', maximumFractionDigits: n >= 1e6 ? 2 : 1 });
const ctxText = (x) => x.window ? `${kfmt(x.used)} / ${kfmt(x.window)} (${pct(x.pct / 100)})` : kfmt(x.used);
const ctxBtnHtml = (c) => {
  const x = c?.ctx; if (!x) return '';
  return `<button type="button" id="ctxbtn" class="cx-${x.level || 'none'}" aria-haspopup="dialog" aria-expanded="${!$('ctxpanel').hidden}" title="${t('ctx.title')}"><span class="cxbar"><i style="width:${Math.min(100, x.pct || 0)}%"></i></span><span>${x.compacting ? t('ctx.compacting') : ctxText(x)}</span></button>`;
};
const ctxBusy = (c) => c.remote || c.status === 'working' || c.status === 'waiting' || c.status === 'interrupted' || c.ctx?.compacting;
function ctxPanelHtml(c) {
  const x = c.ctx, b = x.breakdown;
  const rows = b ? b.categories.map((k) => `<tr class="${/deferred/.test(k.name) || k.derived ? 'def' : ''}"><td>${esc(k.name)}</td><td>${kfmt(k.tokens)}</td><td>${pct(k.pct / 100)}</td></tr>`).join('') : '';
  return `<h3>${t('ctx.title')}</h3><div><b dir="ltr">${esc(ctxText(x))}</b></div>`
    + (x.window ? `<span class="cxbar cx-${x.level}"><i style="width:${Math.min(100, x.pct)}%"></i></span>` : '')
    + (x.left != null ? `<small>${x.left ? t('ctx.left', { n: kfmt(x.left) }) : t('ctx.atThreshold')}</small>` : '')
    + (b ? `<table>${rows}</table><small>${t('ctx.breakdownAt', { time: clock(b.at) })}</small>` : `<small>${t('ctx.noBreakdown', { cmd: '<code>/context</code>' })}</small>`)
    + `<div class="cxacts"><button type="button" id="cxrefresh" ${ctxBusy(c) ? 'disabled' : ''}>${t('common.refresh')}</button><button type="button" id="cxcompact" class="primary" ${ctxBusy(c) ? 'disabled' : ''}>${x.compacting ? t('ctx.compactingBtn') : t('ctx.compact')}</button></div><small id="cxmsg" role="status"></small>`;
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
  if (act === 'compact') { instructions = prompt(t('ctx.compactPrompt'), ''); if (instructions === null) return; }
  $('cxmsg').textContent = t(act === 'compact' ? 'ctx.compactingBtn' : 'ctx.reading');
  const r = await api('/api/' + act, { conversationId: cur.id, instructions: instructions || undefined });
  if (r.error) $('cxmsg').textContent = r.error;
});

// Usage meter: the CLI reports the account's rate-limit windows with each turn (rate_limit_event); a window already past its reset is stale and hidden.
// The 5 h window stays visible after its reset as "reset" at 0 % (until a new event arrives); other windows past their reset are hidden.
const dfmt = (ms, o) => new Intl.DateTimeFormat(intl(), o).format(ms);
const clock = (ms) => dfmt(ms, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const until = (ms) => { const m = Math.ceil((ms - Date.now()) / 60000); return m > 0 && m < 180 ? ' · ' + t('usage.in', { time: `${num(Math.floor(m / 60))}:${num(m % 60, { minimumIntegerDigits: 2 })}` }) : ''; };
// The day too when the reset is not today (the weekly window): "resets tomorrow 12:00", "resets Fri 14/11 12:00".
const daysFromToday = (ms) => { const d0 = new Date(); d0.setHours(0, 0, 0, 0); return Math.round((new Date(ms).setHours(0, 0, 0, 0) - d0) / 864e5); };
const dayOf = (ms) => { const n = daysFromToday(ms); return n === 0 ? '' : n === 1 ? t('time.tomorrow') + ' ' : dfmt(ms, { weekday: 'short', day: 'numeric', month: 'numeric' }) + ' '; };
const resetText = (ms) => ms <= Date.now() ? t('usage.reset') : t('usage.resets', { when: dayOf(ms) + clock(ms) }) + until(ms);
// Free limit resets of the seat's own account: each with its expiry and a "Use" button that spends it after a confirm.
const resetsBox = (s) => {
  const r = s.resets, n = Number(r?.available) || 0; if (!n) return '';
  const day = (s) => s ? esc(dfmt(s * 1000, { dateStyle: 'medium' })) : '';
  const rows = (r.list?.length ? r.list : [{ id: '', title: r.title || t('usage.resetDefault'), expiresAt: r.nextExpiry, usableNow: true }]).map((c) => `<span class="reset1" title="${esc(c.label || c.title)}"><bdi>${esc(c.title)}</bdi>${c.expiresAt ? ' · ' + t('usage.until', { date: day(c.expiresAt) }) : ''}${r.usable && c.usableNow ? ` <button type="button" data-usereset="${esc(s.name)}" data-credit="${esc(c.id)}" data-ctitle="${esc(c.title)}">${t('usage.use')}</button>` : ''}</span>`).join('');
  return `<small class="resets">🔄 ${tn('usage.resetsCount', n)}: ${rows}</small>`;
};
const meter = (u) => !u ? '' : Object.entries(u.windows).filter(([k, v]) => k === 'five_hour' || v.resetsAt * 1000 > Date.now()).map(([k, v]) => {
  const gone = v.resetsAt * 1000 <= Date.now(), p = gone ? 0 : Math.round(v.utilization * 100);
  const old = u.at && Date.now() - u.at > 30 * 60000 ? ' · ' + t('usage.readAt', { time: clock(u.at) }) : '';   // a stale reading says when it was taken
  return `<small class="meter" title="${esc(t('usage.resets', { when: dfmt(v.resetsAt * 1000, { dateStyle: 'medium', timeStyle: 'short' }) }))}">${esc(tk('usage.window.', k).replace(/_/g, ' '))} <span class="bar"><i style="width:${Math.min(100, p)}%"></i></span> ${pct(p / 100)} <span class="reset">${resetText(v.resetsAt * 1000)}${old}</span></small>`;
}).join('');
// Composer warning at 80 % or more of the 5 h window: this seat's own state ("ops at 85% · resets 14:00", plus its own free resets if any).
// It never names another seat: each seat's limit is its own, work is not moved to dodge it.
function showQuota() {
  const util = (s) => { const w = s.usage?.windows?.five_hour; return w ? (w.resetsAt * 1000 <= Date.now() ? 0 : w.utilization) : null; };
  const me = seats.find((s) => s.name === cur.seat), u = me && util(me), box = $('quota');
  if (u == null || u < 0.8) { box.hidden = true; return; }
  const iso = (n) => '\u2068' + n + '\u2069';   // FSI/PDI: a Latin seat name inside a right-to-left sentence keeps its place
  const at = me.usage.windows.five_hour.resetsAt * 1000, rs = me.resets?.available;
  box.textContent = t('quota.at', { seat: iso(me.name), pct: pct(u) }) + ` · ${resetText(at)}` + (rs ? ' · ' + tn('quota.free', rs) : '');
  box.hidden = false;
}
const showArch = (() => { try { return JSON.parse(localStorage.getItem('showArch') || '{}'); } catch { return {}; } })();
// Folded seats: only the open conversation and the ones waiting on the user stay visible, the rest is one "N more" line. Kept per browser.
const fold = (() => { try { return JSON.parse(localStorage.getItem('fold') || '{}'); } catch { return {}; } })();
const saveFold = () => { try { localStorage.setItem('fold', JSON.stringify(fold)); } catch {} };
const showMore = {};   // per seat: list every live conversation, not only the newest 12
let menuFor = null;   // conversation id whose ⋯ menu is open
const convRow = (c, seat) => `<div class="convrow ${c.archived ? 'archived' : ''}"><button class="conv ${c.id === cur.id ? 'on' : ''} ${c.pending ? 'ask' : ''} ${c.needsAnswer ? 'answer' : ''}" data-id="${c.id}" data-seat="${seat}">
      <span class="dot ${c.status === 'stopped' ? '' : c.status}"></span><span class="t" dir="auto">${c.keep ? `<span class="kept" title="${t('conv.keptTitle')}">★</span> ` : ''}${esc(c.title)}</span>${c.ctx?.pct != null ? `<span class="cxpct cx-${c.ctx.level}" title="${t('ctx.title')} ${esc(ctxText(c.ctx))}">${pct(c.ctx.pct / 100)}</span>` : ''}
      <span class="cost" dir="ltr" title="${t('conv.costTitle')}">~${usd(c.cost || 0)}</span>
      <small>${c.mode === 'bypass' ? `<span class="badge bypass">${t('mode.bypass')}</span> ` : ''}${esc(label(c.status))}${c.background ? ' · <bdi>' + esc(c.background) + '</bdi>' : ''}${c.pending ? ' · ' + t('conv.waitingN', { n: num(c.pending) }) : ''}</small>${c.quotaWait ? `<span class="qwait" title="${t('conv.qwaitTitle')}">⏸ ${t('conv.resumesAt', { time: clock(c.quotaWait) })}<span class="dismiss" data-unwait="${c.id}" role="button" title="${t('conv.unwait')}">✕</span></span>` : ''}${c.needsAnswer ? `<span class="needs">❓ ${t('conv.needsAnswer')}<span class="dismiss" data-dismiss="${c.id}" role="button" title="${t('conv.dismissTitle')}">✕</span></span>` : ''}</button>
      ${c.remote ? '' : `<button class="more" data-more="${c.id}" aria-label="${t('conv.menu')}">⋯</button>`}</div>`
  + (menuFor === c.id ? `<div class="cmenu"><button data-rename="${c.id}" data-seat="${seat}">${t('conv.renameShort')}</button>${c.needsAnswer ? `<button data-dismiss="${c.id}">${t('conv.closeQuestion')}</button>` : ''}<button data-keep="${c.id}" data-to="${!c.keep}" title="${t(c.keep ? 'conv.unkeepTitle' : 'conv.keepTitle')}">${t(c.keep ? 'conv.unkeep' : 'conv.keep')}</button><button data-archive="${c.id}" data-to="${!c.archived}">${t(c.archived ? 'conv.unarchive' : 'conv.archive')}</button><button class="danger" data-del="${c.id}">${t('common.delete')}</button></div>` : '');

function showSeats() {
  showQuota(); menuMark();
  const allFolded = seats.every((s) => fold[s.name]);
  $('foldall').textContent = t(allFolded ? 'side.expandAll' : 'side.foldAll'); $('foldall').dataset.to = String(!allFolded);
  $('seats').innerHTML = seats.map((s) => {
    const live = s.conversations.filter((c) => !c.archived), arch = s.conversations.filter((c) => c.archived), f = !!fold[s.name];
    const shown = f ? s.conversations.filter((c) => c.id === cur.id || (!c.archived && (c.keep || c.pending || c.needsAnswer || c.quotaWait))) : (showMore[s.name] ? live : live.slice(0, 12)), hidden = f ? live.filter((c) => !shown.includes(c)).length : 0, more = f ? 0 : live.length - shown.filter((c) => !c.archived).length;   // the open conversation stays even when archived
    return `<section class="seatbox ${f ? 'folded' : ''}"><div class="seathead ${s.name === cur.seat && !cur.id ? 'on' : ''}"><div><b><button class="foldbtn" data-fold="${esc(s.name)}" aria-expanded="${!f}" title="${t(f ? 'side.unfoldSeat' : 'side.foldSeat')}">${f ? (RTL.includes(LANG) ? '◂' : '▸') : '▾'}</button>${esc(s.name)}</b><small dir="ltr">${esc(s.email)}</small><small class="role" dir="auto">${esc(s.role)}</small>${meter(s.usage)}${resetsBox(s)}</div>
    ${s.remote && !s.control ? '' : `<button data-new="${s.name}" title="${t('side.newConversation')}">+ ${t('side.new')}</button>`}</div>`
    + shown.map((c) => convRow(c, s.name)).join('')
    + (hidden ? `<button class="archtoggle" data-fold="${esc(s.name)}">${tn('side.moreConversations', hidden)}</button>` : '')
    + (more > 0 || (!f && showMore[s.name] && live.length > 12) ? `<button class="archtoggle" data-showmore="${esc(s.name)}">${showMore[s.name] ? t('side.showFewer') : t('side.showMore', { n: num(more) })}</button>` : '')
    + (!f && arch.length ? `<button class="archtoggle" data-archtoggle="${s.name}">${t(showArch[s.name] ? 'side.hideArchived' : 'side.showArchived', { n: num(arch.length) })}</button>` : '')
    + (!f && showArch[s.name] ? arch.map((c) => convRow(c, s.name)).join('') : '') + '</section>';
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
  cur = { seat, id }; localStorage.setItem('seat', seat); closeProjects(); closeSettings();
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
  try { await loadLang(LANG); } finally { document.documentElement.dataset.ready = '1'; }   // the page stays hidden until its words are in (app.css), never longer than this
  seats = await api('/api/seats');
  if (!seats.find((s) => s.name === cur.seat && (!s.remote || s.control))) cur.seat = seats[0].name;   // a read-only remote group has no "new conversation" draft
  await pick(cur.seat, null);
  openHash(); window.addEventListener('hashchange', openHash);
  loadSettings().then(() => { if (setData?.firstRun && !onSettings()) openSettings('start'); });   // first start: Settings opens by itself (not awaited: detection may take seconds)
  loadRoutines(); setInterval(() => { if (!document.hidden) loadRoutines(); }, 30000);
  loadMulti(); setInterval(() => { if (!document.hidden) loadMulti(); }, 60000);
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
  if (d.multi) { loadMulti(); return; }
  if (d.resets) { const s = seats.find((x) => x.name === d.resets.seat); if (s) { s.resets = d.resets; scheduleSeats(); } return; }
  if (d.usage) { const hit = seats.filter((x) => x.name === d.usage.seat || x.account === d.usage.seat); for (const s of hit) s.usage = { windows: d.usage.windows, at: d.usage.at }; if (hit.length) scheduleSeats(); return; }   // a remote group with that account mirrors the seat's meter
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
const pinBtn = () => { const b = document.createElement('button'); b.type = 'button'; b.className = 'pinbtn'; b.dataset.pin = '1'; b.setAttribute('aria-label', t('pins.pin')); b.textContent = '📌'; return b; };
const PIN_ICON = { question: '❓', link: '🔗', error: '⚠️', manual: '📌' };
function showMarks() {
  const c = curConv(), pins = c?.pins || [], sug = c && c.status !== 'working' && c.status !== 'waiting' ? c.suggest || [] : [];
  $('pins').hidden = !pins.length;
  $('pins').innerHTML = pins.map((p) => `<span class="pin ${p.kind}"><button type="button" class="pjump" data-jump="${p.i}" dir="auto" title="${t('pins.show')}">${PIN_ICON[p.kind] || '📌'} ${esc(p.text)}</button>`
    + (p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" aria-label="${t('pins.openLink')}">↗</a>` : '') + `<button type="button" class="pdone" data-done="${esc(p.id)}" aria-label="${t('pins.done')}">✓</button></span>`).join('');
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
  if (!el) return alert(t('pins.tooOld'));
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
  btn.textContent = done ? '✓ ' + t('code.copied') : t('code.copyFailed'); setTimeout(() => { btn.textContent = t('code.copy'); }, 1500);
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
  seats = await api('/api/seats'); loadRoutines(); loadMulti();
  for (const k in convo) delete convo[k];
  showSeats(); await showConversation();
}

// ---- routines: recurring prompts. At their due time the console only ASKS on Telegram; a run starts on a tap there, or on "Run now" here (that click is the approval). ----
let routineList = [];
const when = (ms) => (daysFromToday(ms) === 0 ? t('time.today') : dfmt(ms, { weekday: 'short', day: 'numeric', month: 'numeric' })) + ' ' + clock(ms);
async function loadRoutines() { try { routineList = await api('/api/routines'); } catch { return; } showRoutines(); }
function showRoutines() {
  $('routines').innerHTML = `<h2>⏰ ${t('routines.title')}</h2>` + routineList.map((r) => {
    const run = r.conversationId || r.lastRun?.conversationId;
    const last = r.lastAskedFor ? t('routines.lastAsk', { when: when(r.lastAskedFor), what: tk('routines.decision.', r.decision || '') }) : r.lastRun ? t('routines.lastRun', { when: when(r.lastRun.at), by: r.lastRun.by }) : t('routines.neverAsked');
    return `<div class="routine ${r.enabled ? '' : 'off'}"><div><b dir="auto">${esc(r.id)}</b><small><bdi>${esc(r.seat)}</bdi> · ${r.enabled ? t('routines.next', { when: r.nextDue ? when(r.nextDue) : '-' }) : t('routines.disabled')}</small>`
      + `<small>${esc(last)}${run ? ` · <a href="#${esc(run)}">${t('routines.openRun')}</a>` : ''}</small></div>`
      + `<div class="racts"><button data-rrun="${esc(r.id)}" data-seat="${esc(r.seat)}">${t('routines.runNow')}</button><button data-rtoggle="${esc(r.id)}" data-to="${r.enabled ? 'disable' : 'enable'}">${t(r.enabled ? 'common.disable' : 'common.enable')}</button></div></div>`;
  }).join('');
}
$('routines').onclick = async (e) => {
  const run = e.target.closest('[data-rrun]'), tog = e.target.closest('[data-rtoggle]');
  if (run && !confirm(t('routines.confirmRun', { id: run.dataset.rrun, seat: run.dataset.seat }))) return;
  const r = run ? await api('/api/routine', { id: run.dataset.rrun, action: 'run' }) : tog ? await api('/api/routine', { id: tog.dataset.rtoggle, action: tog.dataset.to }) : null;
  if (!r) return;
  if (r.error) alert(r.error);
  await loadRoutines();
  if (r.conversationId) location.hash = r.conversationId;
};
// ---- Projects page (#projects) + multi-sided projects (multi.mjs): a brief -> plan on the owner seat -> one tap approves -> each task on the seat fixed for its discipline ----
let multiData = { projects: [], disciplines: {}, owner: '', folders: [] }, folderQ = '', multiLoaded = false, focusId = null;
const mstatus = (s) => tk('mstatus.', s);
const ACTIVE = (p) => !['done', 'cancelled'].includes(p.status);
const onProjects = () => document.body.classList.contains('projects');
async function loadMulti() {
  try { multiData = await api('/api/multi'); } catch { return; }
  multiLoaded = true; $('multi').hidden = !!multiData.hidden; showMultiSide(); if (onProjects() && !$('projects').contains(document.activeElement)) { showProjects(); flashCard(); }   // a half-typed brief or filter is never wiped by a refresh
}
// Sidebar: one entry to the page + the projects still going, each a link to its card.
function showMultiSide() {
  const act = multiData.projects.filter(ACTIVE), ask = act.filter((p) => p.status === 'plan-ready' || p.status.endsWith('error') || p.tasks.some((t) => ['error', 'stuck', 'needs-answer'].includes(t.status))).length;
  $('multi').innerHTML = `<h2>🧩 ${t('projects.title')}</h2><button type="button" data-mopen class="${onProjects() ? 'primary' : ''}">${t('projects.open')}${ask ? ' · ' + t('projects.needYou', { n: num(ask) }) : ''}</button>`
    + act.map((p) => `<a class="mline" href="#multi-${esc(p.id)}"><span dir="auto">${esc(p.name)}</span><small>${esc(mstatus(p.status))}${p.tasks.length ? ` · ${num(p.tasks.filter((x) => x.status === 'done').length)}/${num(p.tasks.length)}` : ''}</small></a>`).join('');
}
function card(p) {
  const wait = (x, seat) => x.waitUntil ? ' · ' + t('projects.waitsFor', { seat: `<bdi>${esc(seat)}</bdi>`, when: when(x.waitUntil) }) : '';
  const retry = (task, label = t('projects.retry')) => `<button data-mretry="${esc(p.id)}" data-task="${esc(task)}">${label}</button>`;
  const tasks = p.tasks.map((k) => `<div class="mtask st-${esc(k.status)}"><div><span dir="auto">${esc(k.title)}</span><small><bdi>${esc(k.discipline)} → ${esc(k.seat)}</bdi> · ${esc(mstatus(k.status))}${k.status === 'pending' ? wait(k, k.seat) : ''}${k.deps.length ? ' · ' + t('projects.after', { tasks: `<bdi>${esc(k.deps.join(', '))}</bdi>` }) : ''}${k.conv ? ` · <a href="#${esc(k.conv)}">${t('projects.openTask')}</a>` : ''}</small>`
    + `${k.error || k.sendError ? `<small class="err" dir="auto">${esc(k.error || k.sendError)}</small>` : ''}</div>${['error', 'stuck', 'needs-answer', 'running'].includes(k.status) && p.status === 'running' ? `<div class="racts">${retry(k.id, k.status === 'running' ? t('projects.continue') : t('projects.retry'))}</div>` : ''}</div>`).join('');
  const acts = (p.status === 'plan-ready' ? `<button class="primary" data-mapprove="${esc(p.id)}">${t('projects.approve')}</button>` : '')
    + (p.status === 'plan-error' ? retry('plan', t('projects.retryPlan')) : '') + (p.status === 'integrate-error' ? retry('integrate', t('projects.retryIntegration')) : '')
    + (ACTIVE(p) ? `<button data-mcancelp="${esc(p.id)}">${t('projects.cancel')}</button>` : '');
  const done = p.tasks.filter((k) => k.status === 'done').length;
  return `<div class="mproj" id="multi-${esc(p.id)}"><b dir="auto">${esc(p.name)}</b><small>${esc(mstatus(p.status))}${p.tasks.length ? ' · ' + t('projects.tasksDone', { done: num(done), n: num(p.tasks.length) }) : ''} · ${t('projects.owner', { seat: `<bdi>${esc(p.owner)}</bdi>` })} · ${t('projects.started', { when: when(p.createdAt) })}${p.status === 'planning' ? wait(p, p.owner) : ''}</small><small dir="ltr">${esc(p.dir)}</small>`
    + `<small>${p.planConv ? `<a href="#${esc(p.planConv)}">${t('projects.planConv')}</a>` : ''}${p.integrateConv ? ` · <a href="#${esc(p.integrateConv)}">${t('projects.integration')}</a>` : ''}</small>`
    + `${p.error ? `<small class="err">${esc(p.error)}</small>` : ''}${p.sendError ? `<small class="err">${esc(p.sendError)}</small>` : ''}${acts ? `<div class="racts">${acts}</div>` : ''}${tasks}</div>`;
}
function folderList() {
  const q = folderQ.trim().toLowerCase(), all = multiData.folders || [], hits = q ? all.filter((f) => f.name.toLowerCase().includes(q)) : all;
  return hits.slice(0, 40).map((f) => `<div class="mfolder"><div><span dir="ltr">${esc(f.name)}</span><small>${f.mtime ? t('projects.touched', { when: when(f.mtime) }) : ''}</small></div><button data-mstart="${esc(f.dir)}" data-mname="${esc(f.name.split(/[\\/]/).pop())}">${t('projects.start')}</button></div>`).join('')
    + (hits.length > 40 ? `<small>${t('projects.moreFolders', { n: num(hits.length - 40) })}</small>` : '') + (!hits.length ? `<small>${t('projects.noFolder')}</small>` : '');
}
function showProjects() {
  const old = $('mform'), keep = old && { name: old.name.value, dir: old.dir.value, owner: old.owner.value, brief: old.brief.value };   // a re-render never loses a half-typed project
  const seatsOpt = [...new Set([multiData.owner, ...Object.values(multiData.disciplines)])];
  const act = multiData.projects.filter(ACTIVE), done = multiData.projects.filter((p) => !ACTIVE(p));
  $('projects').innerHTML = `<header class="phead"><h2>🧩 ${t('projects.title')}</h2><small>${t('projects.intro')}</small></header>`
    + `<div class="pgrid"><div class="pcol">`
    + (multiData.off ? `<p class="err">${t('projects.off')} <bdi>${esc(multiData.off)}</bdi></p>` : '')
    + `<form id="mform"${multiData.off ? ' hidden' : ''}><h3>${t('projects.startTitle')}</h3><input name="name" placeholder="${t('projects.namePh')}" required dir="auto"><input name="dir" placeholder="${t('projects.dirPh')}" dir="auto" spellcheck="false">`
    + `<label>${t('projects.ownerLabel')} <select name="owner">${seatsOpt.map((s) => `<option${s === multiData.owner ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label>`
    + `<textarea name="brief" rows="7" placeholder="${t('projects.briefPh')}" required dir="auto"></textarea>`
    + `<small dir="ltr">${Object.entries(multiData.disciplines).map(([d, s]) => `${esc(d)}→${esc(s)}`).join(' · ')}</small><div class="racts"><button type="submit" class="primary">${t('projects.plan')}</button></div></form>`
    + `<h3>${t('projects.folders')}</h3><input id="mfq" type="search" placeholder="${t('projects.filterPh')}" value="${esc(folderQ)}" dir="auto" spellcheck="false"><div id="mfolders">${folderList()}</div></div>`
    + `<div class="pcol"><h3>${t('projects.running', { n: num(act.length) })}</h3>${act.map(card).join('') || `<small>${t('projects.nothingRunning')}</small>`}`
    + (done.length ? `<h3>${t('projects.finished')}</h3>${done.map(card).join('')}` : '') + `</div></div>`;
  const f = $('mform'); if (keep) for (const k of ['name', 'dir', 'owner', 'brief']) if (keep[k]) f[k].value = keep[k];
}
function openProjects(id) {
  closeSettings(); document.body.classList.add('projects'); document.body.classList.remove('drawer'); showProjects(); showMultiSide();
  focusId = id || null; if (multiLoaded) flashCard();   // a direct link before the first load: the card is flashed once the data is in (loadMulti)
}
function flashCard() {
  const el = focusId && document.getElementById('multi-' + focusId); if (!el) return; focusId = null;
  el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1800);
}
function closeProjects() {
  if (!onProjects()) return; document.body.classList.remove('projects'); showMultiSide();
  if (location.hash === '#projects' || location.hash.startsWith('#multi-')) history.replaceState(null, '', location.pathname + location.search);   // the same project link works again
}
$('multi').onclick = (e) => { if (e.target.closest('[data-mopen]')) { if (location.hash === '#projects') openProjects(); else location.hash = 'projects'; } };
$('projects').oninput = (e) => { if (e.target.id === 'mfq') { folderQ = e.target.value; $('mfolders').innerHTML = folderList(); } };
$('projects').onclick = async (e) => {
  const st = e.target.closest('[data-mstart]');
  if (st) { const f = $('mform'); f.dir.value = st.dataset.mstart; if (!f.name.value) f.name.value = st.dataset.mname; f.scrollIntoView({ block: 'start' }); f.brief.focus(); return; }
  const ap = e.target.closest('[data-mapprove]'), rt = e.target.closest('[data-mretry]'), cp = e.target.closest('[data-mcancelp]');
  if (ap && !confirm(t('projects.confirmApprove'))) return;
  if (cp && !confirm(t('projects.confirmCancel'))) return;
  const r = cp ? await api('/api/multi', { action: 'cancel', id: cp.dataset.mcancelp }) : ap ? await api('/api/multi', { action: 'approve', id: ap.dataset.mapprove }) : rt ? await api('/api/multi', { action: 'retry', id: rt.dataset.mretry, task: rt.dataset.task }) : null;
  if (r?.error) alert(r.error); if (r) { document.activeElement?.blur(); await loadMulti(); }   // loadMulti re-renders (showProjects keeps the form's values)
};
$('projects').onsubmit = async (e) => {
  e.preventDefault(); const f = e.target, btn = f.querySelector('[type=submit]'); btn.disabled = true;
  const r = await api('/api/multi', { action: 'create', name: f.name.value, dir: f.dir.value, owner: f.owner.value, brief: f.brief.value }).catch((x) => ({ error: String(x) }));
  btn.disabled = false; if (r.error) return alert(r.error);
  $('mform').reset(); document.activeElement?.blur(); await loadMulti(); openProjects(r.id);
};
$('seats').onclick = async (e) => {
  const ur = e.target.closest('[data-usereset]');
  if (ur) {   // spends one free reset of THIS seat's account, only after the confirm
    const s = seats.find((x) => x.name === ur.dataset.usereset), what = ur.dataset.ctitle || t('usage.resetDefault');
    if (!confirm(t('usage.confirmUse', { what, seat: s.name, effect: t(/fable/i.test(what) ? 'usage.effectFable' : 'usage.effectAll') }))) return;
    ur.disabled = true; const r = await api('/api/reset', { seat: s.name, creditId: ur.dataset.credit || undefined }); ur.disabled = false;
    if (r.error) return alert(r.error); s.resets = r.resets; if (r.windows) s.usage = { windows: r.windows, at: Date.now() }; return showSeats();
  }
  const mo = e.target.closest('[data-more]'); if (mo) { menuFor = menuFor === mo.dataset.more ? null : mo.dataset.more; return showSeats(); }
  const dm = e.target.closest('[data-dismiss]'); if (dm) { menuFor = null; const r = await api('/api/dismiss', { conversationId: dm.dataset.dismiss }); if (r.error) alert(r.error); return; }
  const uw = e.target.closest('[data-unwait]'); if (uw) { const r = await api('/api/quotawait', { conversationId: uw.dataset.unwait }); if (r.error) alert(r.error); return; }
  const kp = e.target.closest('[data-keep]'); if (kp) { menuFor = null; const r = await api('/api/keep', { conversationId: kp.dataset.keep, keep: kp.dataset.to === 'true' }); if (r.error) alert(r.error); return; }
  const ar = e.target.closest('[data-archive]'); if (ar) { menuFor = null; await api('/api/archive', { conversationId: ar.dataset.archive, archived: ar.dataset.to === 'true' }); return; }
  const de = e.target.closest('[data-del]');
  if (de) {
    menuFor = null; showSeats();
    if (!confirm(t('conv.confirmDelete'))) return;
    const r = await api('/api/delete', { conversationId: de.dataset.del }); if (r.error) alert(r.error); return;
  }
  const fo = e.target.closest('[data-fold]'); if (fo) { fold[fo.dataset.fold] = !fold[fo.dataset.fold]; saveFold(); return showSeats(); }
  const sm = e.target.closest('[data-showmore]'); if (sm) { showMore[sm.dataset.showmore] = !showMore[sm.dataset.showmore]; return showSeats(); }
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
  b.parentElement.innerHTML = `<em>${t('perm.sending')}</em>`;
  const r = await api('/api/permission', { conversationId: cur.id, requestId: card.dataset.req, allow: b.dataset.a === '1' });
  if (r.error) card.querySelector('.acts').innerHTML = `<em>${esc(r.error)}</em>`;
};
$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('text').value.trim() || (pending.length ? (pending.some((p) => p.file) ? 'See the attached file.' : 'See the attached image.') : ''); if (!text) return;
  const run = curConv()?.remote ? cur.id : null;   // writing into a remote run continues its session in a new conversation
  if ($('mode').value === 'bypass' && (!cur.id || run || curConv()?.mode !== 'bypass') && !confirm(t('composer.confirmBypassStart'))) return;
  $('text').value = '';
  if (run) {
    const k = await api('/api/remote-continue', { id: run, mode: $('mode').value });
    if (k.error) { $('log').appendChild(div('msg note err', esc(k.error))); $('text').value = text; return; }
    cur.id = k.conversationId;
  }
  const r = await api('/api/send', { seat: cur.seat, conversationId: cur.id || undefined, text, cwd: run ? undefined : $('cwd').value.trim() || undefined, model: $('model').value || undefined, effort: EFFORTS[$('effort').value] || undefined, mode: $('mode').value, images: pending.filter((p) => !p.file).map((p) => p.id), files: pending.filter((p) => p.file).map((p) => p.id), draftId });
  if (r.error) { $('log').appendChild(div('msg note err', esc(r.error))); $('text').value = text; return; }
  pending.length = 0; showThumbs(); draftId = newDraftId();
  if (run) { seats = await api('/api/seats'); await pick(cur.seat, cur.id); }
  else if (!cur.id) { cur.id = r.conversationId; await pick(cur.seat, r.conversationId); }
};
// On a touch screen Enter only adds a line and Send sends: a phone keyboard's Enter would send half-written messages.
const TOUCH = matchMedia('(pointer: coarse)').matches;
if (TOUCH) { $('text').dataset.i18nPlaceholder = 'composer.placeholderTouch'; $('text').enterKeyHint = 'enter'; }
// A new line inside a list continues it: "1. x" -> "2. ", "- x" -> "- "; Enter on an empty item ends the list.
function continueList(t) {
  const s = t.selectionStart; if (s !== t.selectionEnd) return false;
  const line = t.value.slice(t.value.lastIndexOf('\n', s - 1) + 1, s);
  const m = line.match(/^(\s*)(?:(\d+)([.)])|([-*•]))\s+(.*)$/); if (!m) return false;
  const [, ind, num, dot, bullet, rest] = m, start = s - line.length;
  if (!rest.trim()) { t.setRangeText('', start, s, 'end'); return true; }   // empty item: drop the marker, stop the list
  t.setRangeText('\n' + ind + (num ? `${+num + 1}${dot} ` : `${bullet} `), s, s, 'end'); return true;
}
$('text').onkeydown = (e) => {
  if (TOUCH || e.key !== 'Enter' || e.isComposing) return;   // phone keyboards: handled in beforeinput below
  if (!e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); return; }
  if (continueList(e.target)) { e.preventDefault(); e.target.dispatchEvent(new Event('input', { bubbles: true })); }
};
// Android keyboards often report Enter as key "Unidentified" in keydown; beforeinput always names the line break.
$('text').addEventListener('beforeinput', (e) => {
  if (!TOUCH || (e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph')) return;
  if (continueList(e.target)) { e.preventDefault(); e.target.dispatchEvent(new Event('input', { bubbles: true })); }
});
$('stop').onclick = () => cur.id && api('/api/stop', { conversationId: cur.id });
// Permission mode applies at once, also mid-turn (server setMode): no message needed. A remote run has no process of its own (the composer continues it).
$('mode').onchange = async () => {
  const c = curConv(); if (!c || c.remote) return;
  const m = $('mode').value;
  if (m === 'bypass' && !confirm(t('composer.confirmBypassSwitch'))) { $('mode').value = c.mode; return; }
  const r = await api('/api/mode', { conversationId: c.id, mode: m });
  if (r.error) { $('log').appendChild(div('msg note err', esc(r.error))); $('mode').value = c.mode; }
};
$('resume').onclick = async () => { const r = await api('/api/resume', { conversationId: cur.id }); if (r.error) $('log').appendChild(div('msg note err', esc(r.error))); };
// A phone link from Telegram ends in #<conversationId>.
function openHash() {
  if (location.hash === '#settings') return openSettings();
  closeSettings();
  if (location.hash === '#projects' || location.hash.startsWith('#multi-')) return openProjects(location.hash.startsWith('#multi-') ? location.hash.slice(7) : null);
  const c = allConvs().find((x) => x.id === location.hash.slice(1));
  if (c && c.id !== cur.id) pick(c.seat, c.id); else if (c) closeProjects();   // the conversation already behind the page: just uncover it
}

// Hand a finished result to another seat: a NEW conversation there, text prefilled (not sent), folder copied from this one.
async function handoff(seat, result) {
  const c = curConv(); if (!c) return;
  await pick(seat, null);
  $('cwd').value = c.cwd;
  $('text').value = t('result.continuation', { seat: c.seat, title: c.title }) + `\n\n${result}\n\n`;
  $('text').focus();
}

// ---- attachments (button: any file; clipboard paste: images). Uploaded at once, referenced by id when the message is sent. The server decides image or file by magic bytes. ----
const pending = [];          // { id, url } image / { id, file: true, name, size } other file, uploaded but not yet sent
const sizeText = (n) => (n < 1024 ? num(n, { style: 'unit', unit: 'byte' }) : n < 1048576 ? num(Math.round(n / 1024), { style: 'unit', unit: 'kilobyte' }) : num(n / 1048576, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1, minimumFractionDigits: 1 }));
// Random per draft, sent with upload and send: the server only lets a send claim staged files that carry its own draft id.
// getRandomValues, not randomUUID: the page is plain http over Tailscale, where randomUUID does not exist.
const newDraftId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
let draftId = newDraftId();
function showThumbs() {
  const box = $('thumbs'); box.hidden = !pending.length;
  box.innerHTML = pending.map((p, i) => `<span class="thumbwrap">${p.file ? `<span class="fchip" dir="ltr">📎 <bdi>${esc(p.name)}</bdi> · ${sizeText(p.size)}</span>` : `<img class="thumb" alt="${t('composer.attachedImage')}" src="${p.url}">`}<button type="button" data-rm="${i}" aria-label="${t(p.file ? 'composer.removeFile' : 'composer.removeImage')}">×</button></span>`).join('');
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
      .then((x) => x.json(), () => ({ error: t('composer.uploadFailed') }));
    if (r.error) { $('log').appendChild(div('msg note err', esc(`${name}: ${r.error}`))); continue; }
    pending.push(r.file ? { id: r.id, file: true, name: r.name, size: r.size } : { id: r.id, url: URL.createObjectURL(f) });
  }
  showThumbs();
}
$('attach').onclick = () => $('file').click();
$('file').onchange = () => { attach([...$('file').files]); $('file').value = ''; };
$('thumbs').onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) { pending.splice(+b.dataset.rm, 1); showThumbs(); } };
$('text').addEventListener('paste', (e) => { const fs = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/')); if (fs.length) { e.preventDefault(); attach(fs); } });
// ---- Settings page (#settings, server: settings.mjs + /api/settings*): what is set up, what is turned on. First run (no settings.json) opens it with a checklist. ----
let setData = null, setTab = 'start', draft = null, setNote = null;   // setNote: { tab, html } the last action's result (a login command, an error)
const onSettings = () => document.body.classList.contains('settings');
const STABS = ['start', 'seats', 'telegram', 'access', 'usage', 'projects', 'routines', 'remotes', 'models'];
const yes = (ok, a, b) => `<span class="${ok ? 'sok' : 'sno'}">${ok ? '✓ ' + a : '✗ ' + b}</span>`;
const cmd = (c) => `<code class="scmd" dir="ltr">${esc(c)}</code>`;
const tog = (k, title, text) => `<label class="stog"><input type="checkbox" data-set="${k}"${draft[k] ? ' checked' : ''}><span><b>${title}</b><small>${text}</small></span></label>`;
const seatOpts = (sel, blank) => (blank ? `<option value="">${blank}</option>` : '') + setData.detected.seats.filter((s) => s.active).map((s) => `<option${s.name === sel ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
const dirty = () => JSON.stringify(draft) !== JSON.stringify(setData.settings);
async function loadSettings() {
  const r = await api('/api/settings').catch(() => null); if (!r?.settings) return;   // a failed read keeps what the page had
  const keep = draft && setData && dirty();   // an action elsewhere on the page never wipes toggles not saved yet
  setData = r; if (!keep) { draft = JSON.parse(JSON.stringify(r.settings)); if (r.firstRun && !draft.language) draft.language = LANG; }   // first run: the language the page opened in, kept by Save (the bot uses it too)
  if (onSettings()) showSettings();
}
function checklist() {
  const d = setData.detected, sts = d.seats, inn = sts.filter((s) => s.signedIn).length, tg = setData.telegram, a = setData.access, mods = Object.keys(setData.settings.models);
  const rows = [
    ['seats', t('set.tab.seats'), sts.length && inn === sts.length, t('set.check.seats', { seats: tn('set.nSeats', sts.length), signed: num(inn) })],
    ['telegram', t('set.tab.telegram'), tg.linked, t(tg.linked ? 'set.check.tgLinked' : tg.configured ? 'set.check.tgNotLinked' : 'set.check.tgNone')],
    ['access', t('set.tab.access'), !!(a.tailscale.ip), t(a.test ? 'set.check.accessTest' : a.tailscale.ip ? 'set.check.accessOn' : 'set.check.accessLocal')],
    ['usage', t('set.tab.usage'), !setData.firstRun, t(setData.firstRun ? 'set.check.usageChoose' : 'set.check.usageChosen')],
    ['projects', t('set.check.projects'), setData.settings.multiProjects, t(setData.settings.multiProjects ? 'common.on' : 'common.off')],
    ['routines', t('set.check.routines'), setData.routines.length > 0, tn('set.nRoutines', setData.routines.length)],
    ['remotes', t('set.check.remotes'), setData.remotes.length > 0, tn('set.nRemotes', setData.remotes.length)],
    ['models', t('set.check.models'), mods.length > 0, mods.length ? t('set.check.modelsFor', { seats: mods.join(', ') }) : t('set.check.modelsNone')]];
  return `<ol class="scheck">${rows.map(([tab, title, ok, text]) => `<li class="${ok ? 'done' : ''}"><span class="smark">${ok ? '✓' : ''}</span><span><b>${title}</b><small>${esc(text)}</small></span><button type="button" data-stab="${tab}">${t('set.open')}</button></li>`).join('')}</ol>`;
}
// Settings > Language: the language's own name; '' = the browser's language (the bot then speaks English).
const langRow = () => `<label class="snum"><span><b>${t('set.lang.title')}</b><small>${t('set.lang.hint')}</small></span><select data-set="language" data-str="1"><option value="">${t('set.lang.auto')}</option>`
  + Object.entries(setData.languages || {}).map(([c, n]) => `<option value="${c}" lang="${c}"${draft.language === c ? ' selected' : ''}>${esc(n)}</option>`).join('') + '</select></label>';
function seatRow(s) {
  const kind = s.agent === 'codex' ? 'Codex' : s.agent === 'agy' ? 'Antigravity' : 'Claude';
  return `<div class="srow"><div><b>${esc(s.name)}</b> <span class="badge">${kind}</span>${s.active ? '' : ` <span class="badge">${t('set.afterRestart')}</span>`}<small><bdi>${esc([s.email, s.role].filter(Boolean).join(' · '))}</bdi>${s.home ? ` · ${t('set.ownLogin')} <span dir="ltr">${esc(s.home)}</span>` : ''}</small>`
    + `<small>${yes(s.signedIn, t('set.signedIn'), t('set.notSignedIn'))} · ${tn('set.nConversations', s.conversations)}</small>${s.signedIn ? '' : `<small>${t('set.signInOnce', { cmd: cmd(s.login) })}</small>`}</div>`
    + `<div class="racts"><button type="button" data-rmseat="${esc(s.name)}"${s.conversations ? ` disabled title="${t('set.removeBlocked')}"` : ''}>${t('common.remove')}</button></div></div>`;
}
const agentRow = (key, name, d, hint) => `<div class="srow"><div><b>${name}</b><small>${d.installed ? yes(true, t('set.installed') + (typeof d.installed === 'string' && d.installed !== 'ok' ? ' (' + esc(d.installed) + ')' : ''), '') + ' · ' + yes(d.signedIn, t('set.signedIn'), t('set.notSignedIn')) : yes(false, '', t('set.notInstalled'))}</small>`
  + `<small>${d.installed ? (d.signedIn ? t('set.agentAdd') : t('set.signIn', { cmd: cmd(d.login) })) : hint}</small></div>`
  + `<form class="sinline" data-form="addagent"><input type="hidden" name="agent" value="${key}"><input name="name" placeholder="${t('set.seatNamePh')}" required pattern="[a-z][a-z0-9\\-]{1,20}" value="${esc(key === 'agy' ? 'antigravity' : 'codex')}${setData.detected.seats.some((s) => s.agent === key) ? '2' : ''}" dir="ltr" spellcheck="false" aria-label="${t('set.agentSeatName', { name })}"><button type="submit"${d.installed ? '' : ' disabled'}>${t('set.addAsSeat')}</button></form></div>`;
const TABS = {
  start: () => checklist() + langRow() + `<p class="smuted">${t('set.start.note')}</p>`,
  seats: () => {
    const d = setData.detected;
    return `<h3>${t('set.tab.seats')}</h3>${d.seats.map(seatRow).join('') || `<small>${t('set.noSeats')}</small>`}`
      + `<h3>${t('set.addClaude')}</h3><form class="sform" data-form="addseat"><input name="name" placeholder="${t('set.namePh')}" required pattern="[a-z][a-z0-9\\-]{1,20}" dir="ltr" spellcheck="false"><input name="email" type="email" placeholder="${t('set.emailPh')}" dir="ltr"><input name="role" placeholder="${t('set.rolePh')}" dir="auto"><small>${t('set.seatNote')}</small><div class="racts"><button type="submit" class="primary">${t('set.addSeat')}</button></div></form>`
      + `<h3>${t('set.otherAgents')}</h3>` + agentRow('codex', 'Codex (OpenAI)', d.codex, t('set.codexHint', { install: cmd('npm install -g @openai/codex'), login: cmd('codex login --device-auth') }))
      + agentRow('agy', 'Antigravity (Google)', d.agy, t('set.agyHint', { dir: '<span dir="ltr">~/.local/bin</span>', env: '<code dir="ltr">AGY_BIN</code>' }));
  },
  telegram: () => {
    const tg = setData.telegram, bot = tg.bot ? ` <span dir="ltr">(@${esc(tg.bot)})</span>` : '';
    return `<h3>${t('set.tg.status')}</h3><div class="srow"><div><small>${yes(tg.configured, t('set.tg.botSet') + bot, t('set.tg.noBot'))} · ${yes(tg.linked, t('set.tg.linked'), t('set.tg.notLinked'))}</small><small>${t('set.tg.about')}</small></div>`
      + `${tg.linked ? `<div class="racts"><button type="button" data-tgtest>${t('set.tg.test')}</button></div>` : ''}</div>`
      + `<h3>${t('set.tg.step1')}</h3><form class="sform" data-form="tgtoken"><small>${t('set.tg.tokenHow', { father: '<span dir="ltr">@BotFather</span>', cmd: '<code dir="ltr">/newbot</code>' })}</small><input name="token" type="password" autocomplete="off" placeholder="${tg.configured ? t('set.tg.tokenReplacePh') : '123456789:AA...'}" required dir="ltr" spellcheck="false"><div class="racts"><button type="submit" class="primary">${t('set.tg.saveToken')}</button></div></form>`
      + `<h3>${t('set.tg.step2')}</h3><div class="srow"><div>${tg.linked ? `<small>${t('set.tg.linkedOnly')}</small>` : !tg.configured ? `<small>${t('set.tg.tokenFirst')}</small>` : !tg.polling ? `<small>${t('set.tg.testInstance')}</small>` : tg.linkCode ? `<small>${t('set.tg.sendThis', { bot })}</small>${cmd('/start ' + tg.linkCode)}<small>${t('set.tg.linkedShows')}</small>` : `<small>${t('set.tg.codeSoon')}</small>`}</div><div class="racts"><button type="button" data-sreload>${t('common.refresh')}</button></div></div>`
      + `<h3>${t('set.tg.messages')}</h3>` + tog('digests', t('set.tg.digests'), t('set.tg.digestsHint', { morning: clock(new Date(2000, 0, 1, 8)), evening: clock(new Date(2000, 0, 1, 21)) }));
  },
  access: () => {
    const a = setData.access, ts = a.tailscale;
    if (a.test) return `<h3>${t('set.tab.access')}</h3><div class="srow"><div><small>${t('set.access.test')}</small></div></div>`;
    return `<h3>${t('set.tab.access')}</h3><div class="srow"><div><small>${yes(!!ts.ip, t('set.access.tsOn') + (ts.name ? ` <span dir="ltr">(${esc(ts.name)})</span>` : ''), t('set.access.tsOff'))}</small>`
      + (ts.ip ? `<small>${t('set.access.openOnPhone')} <a href="${esc(a.phone)}" dir="ltr">${esc(a.phone)}</a></small>` : `<small>${t('set.access.install')}</small>`)
      + `${ts.warn ? `<small class="sno" dir="auto">${esc(ts.warn)}</small>` : ''}</div></div>`
      + `<h3>${t('set.access.login')}</h3><div class="srow"><div><small>${t('set.access.loginNote', { user: `<b dir="ltr">${esc(a.user)}</b>` })}</small></div></div>`
      + `<form class="sform" data-form="password"><input name="current" type="password" autocomplete="current-password" placeholder="${t('set.access.currentPh')}" required><input name="next" type="password" autocomplete="new-password" placeholder="${t('set.access.newPh')}" required minlength="12"><input name="again" type="password" autocomplete="new-password" placeholder="${t('set.access.againPh')}" required><div class="racts"><button type="submit" class="primary">${t('set.access.change')}</button></div></form>`;
  },
  usage: () => `<h3>${t('set.usage.title')}</h3>` + tog('usageMeters', t('set.usage.meters'), t('set.usage.metersHint'))
    + tog('quotaWarning', t('set.usage.warn', { pct: pct(0.9) }), t('set.usage.warnHint', { pct: pct(0.9) }))
    + `<h3>${t('set.usage.resets')}</h3>` + tog('claudeResets', t('set.usage.claudeResets'), t('set.usage.claudeResetsHint'))
    + tog('codexResets', t('set.usage.codexResets'), t('set.usage.codexResetsHint', { cmd: '<code dir="ltr">codex app-server</code>' }))
    + `<h3>${t('set.usage.housekeeping')}</h3><label class="snum"><span><b>${t('set.usage.archive')}</b><small>${t('set.usage.archiveHint')}</small></span><input type="number" min="0" max="365" data-set="autoArchiveDays" value="${draft.autoArchiveDays}"> ${t('set.usage.days')}</label>`
    + `<label class="snum"><span><b>${t('set.usage.reap')}</b><small>${t('set.usage.reapHint')}</small></span><input type="number" min="1" max="1440" data-set="idleReapMinutes" value="${draft.idleReapMinutes}"> ${t('set.usage.min')}</label>`,
  projects: () => {
    const d = setData.disciplines || { owner: setData.detected.seats[0]?.name, disciplines: {} };
    return `<h3>${t('set.proj.title')}</h3>` + tog('multiProjects', t('set.proj.page'), t('set.proj.pageHint'))
      + `<label class="snum"><span><b>${t('set.proj.fresh')}</b><small>${t('set.proj.freshHint')}</small></span><input type="number" min="0" max="95" data-set="projectsFreshAtPct" value="${draft.projectsFreshAtPct ?? 40}"> %</label>`
      + `<h3>${t('set.proj.disciplines')}</h3><form class="sform" data-form="disc"><small><b>${t('set.proj.rule')}</b></small>`
      + `<label>${t('set.proj.owner')} <select name="owner">${seatOpts(d.owner)}</select></label><div id="discrows">${Object.entries(d.disciplines).map(([k, v]) => discRow(k, v)).join('') || discRow()}</div>`
      + `<div class="racts"><button type="button" data-discadd>${t('set.proj.add')}</button><button type="submit" class="primary">${t('set.proj.save')}</button></div>${setData.disciplines?.off ? `<small class="sno">${t('set.proj.nowOff')} <bdi>${esc(setData.disciplines.off)}</bdi></small>` : ''}</form>`;
  },
  routines: () => `<h3>${t('routines.title')}</h3><small class="smuted">${t('set.rt.note')}</small>`
    + (setData.routines.map((r) => `<div class="srow"><div><b>${esc(r.id)}</b> <span class="badge">${t(r.enabled ? 'common.on' : 'common.off')}</span><small><bdi>${esc(r.seat)}</bdi> · <span dir="ltr">${esc(r.cron)}</span>${r.enabled && r.nextDue ? ' · ' + t('routines.next', { when: when(r.nextDue) }) : ''}</small><small dir="ltr">${esc(r.cwd)}</small></div>`
      + `<div class="racts"><button type="button" data-rtog="${esc(r.id)}" data-to="${r.enabled ? 'disable' : 'enable'}">${t(r.enabled ? 'common.disable' : 'common.enable')}</button><button type="button" data-redit="${esc(r.id)}">${t('common.edit')}</button></div></div>`).join('') || `<small>${t('set.rt.none')}</small>`)
    + `<h3>${t('set.rt.addTitle')}</h3><form class="sform" data-form="routine"><input name="id" placeholder="${t('set.rt.idPh')}" required pattern="[a-z0-9][a-z0-9\\-]{0,40}" dir="ltr" spellcheck="false"><label>${t('set.rt.seat')} <select name="seat">${seatOpts()}</select></label>`
    + `<input name="cron" placeholder="${t('set.rt.cronPh')}" required dir="ltr" spellcheck="false"><input name="cwd" placeholder="${t('set.rt.cwdPh')}" required dir="ltr" spellcheck="false">`
    + `<label>${t('set.rt.mode')} <select name="mode">${['auto', 'ask', 'bypass'].map((m) => `<option value="${m}">${t('mode.' + m)}</option>`).join('')}</select></label><textarea name="prompt" rows="4" placeholder="${t('set.rt.promptPh')}" required dir="auto"></textarea><div class="racts"><button type="submit" class="primary">${t('set.rt.save')}</button></div></form>`,
  remotes: () => `<h3>${t('set.rem.title')}</h3><small class="smuted">${t('set.rem.note', { cmd: cmd('node console/rhost.mjs setup <name>') })}</small>`
    + (setData.remotes.map((r) => `<div class="srow"><div><b>${esc(r.name)}</b> <span class="badge">${t(r.control ? 'set.rem.control' : 'set.rem.readOnly')}</span>${r.active ? '' : ` <span class="badge">${t('set.afterRestart')}</span>`}${r.down ? ` <span class="badge sno">${t('set.rem.unreachable')}</span>` : ''}<small dir="ltr">${esc(r.target)}</small>${r.account ? `<small>${t('set.rem.accountOf', { seat: `<bdi>${esc(r.account)}</bdi>` })}</small>` : ''}</div>`
      + `<div class="racts"><button type="button" data-rtest="${esc(r.name)}">${t('set.rem.test')}</button><button type="button" data-rrm="${esc(r.name)}">${t('common.remove')}</button></div></div>`).join('') || `<small>${t('set.rem.none')}</small>`)
    + `<h3>${t('set.rem.addTitle')}</h3><form class="sform" data-form="remote"><input name="name" placeholder="${t('set.rem.namePh')}" required pattern="[a-z0-9\\-]{1,40}" dir="ltr" spellcheck="false"><input name="target" placeholder="${t('set.rem.targetPh')}" required dir="ltr" spellcheck="false"><input name="identity" value="~/.ssh/id_ed25519" required dir="ltr" spellcheck="false" aria-label="${t('set.rem.key')}">`
    + `<label class="stog"><input type="checkbox" name="control"><span><b>${t('set.rem.mayStart')}</b><small>${t('set.rem.mayStartHint')}</small></span></label><input name="paths" placeholder="${t('set.rem.pathsPh')}" dir="ltr" spellcheck="false">`
    + `<label>${t('set.rem.account')} <select name="account">${seatOpts('', t('common.none'))}</select></label><div class="racts"><button type="submit" class="primary">${t('set.rem.add')}</button></div></form>`,
  models: () => `<h3>${t('set.models.title')}</h3><small class="smuted">${t('set.models.note')}</small>`
    + setData.detected.seats.filter((s) => s.active).map((s) => `<label class="snum"><span><b>${esc(s.name)}</b></span><select data-model="${esc(s.name)}"><option value="">${t('set.models.cliDefault')}</option>${(setData.models[s.name] || []).map((m) => `<option value="${esc(m.id)}"${draft.models[s.name] === m.id ? ' selected' : ''}>${esc(m.name || m.id)}</option>`).join('')}</select></label>`).join(''),
};
const discRow = (k = '', v = '') => `<div class="sdisc"><input name="dname" value="${esc(k)}" placeholder="${t('set.proj.discPh')}" dir="ltr" spellcheck="false" aria-label="${t('set.proj.discipline')}"><span>${RTL.includes(LANG) ? '←' : '→'}</span><select name="dseat" aria-label="${t('set.proj.seat')}">${seatOpts(v)}</select><button type="button" data-discrm aria-label="${t('set.proj.remove')}">✕</button></div>`;
function showSettings() {
  if (!setData) return;
  const box = $('settings'), y = box.scrollTop, sup = setData.detected.supervisor;
  box.innerHTML = `<header class="phead shead"><button type="button" class="smenu" data-sdrawer aria-label="${t('side.seats')}">☰</button><div><h2>⚙ ${t('set.title')}</h2><small>${t('set.subtitle')}</small></div><button type="button" data-sclose>${t('common.close')}</button></header>`
    + (setData.firstRun && setTab === 'start' ? `<p class="sfirst"><b>${t('set.first.title')}</b><span>${t('set.first.text')}</span></p>` : '')
    + (setData.error ? `<p class="sbar err" dir="auto">${esc(setData.error)}</p>` : '')
    + (setData.restartNeeded ? `<p class="sbar"><span>${t('set.restartNote')}${sup ? '' : ' ' + t('set.noSupervisor')}</span><button type="button" class="primary" data-restart>${t('set.restartNow')}</button></p>` : '')
    + `<nav class="stabs" role="tablist">${STABS.map((k) => `<button type="button" role="tab" data-stab="${k}" aria-selected="${k === setTab}">${t('set.tab.' + k)}</button>`).join('')}</nav>`
    + `<div class="spanel">${setNote && setNote.tab === setTab ? `<p class="snote ${setNote.err ? 'err' : ''}">${setNote.html}</p>` : ''}${TABS[setTab]()}</div>`
    + `<div class="ssave"${setData.firstRun || dirty() ? '' : ' hidden'}><span>${t(setData.firstRun ? 'set.nothingSaved' : 'set.unsaved')}</span><button type="button" data-ssave class="primary">${t('common.save')}</button></div>`;
  box.scrollTop = y;
  const tab = box.querySelector('.stabs [aria-selected=true]'), nav = tab.parentElement;   // phone: the open tab stays in view in the scrolling tab row (RTL: scrollLeft runs negative)
  const tr = tab.getBoundingClientRect(), nr = nav.getBoundingClientRect();   // screen coordinates: the same arithmetic for both directions
  if (tr.left < nr.left) nav.scrollLeft += tr.left - nr.left - 24; else if (tr.right > nr.right) nav.scrollLeft += tr.right - nr.right + 24;
}
async function openSettings(tab) {
  document.body.classList.add('settings'); document.body.classList.remove('drawer', 'projects');
  if (tab) { setTab = tab; setNote = null; }
  if (!setData) await loadSettings(); showSettings();
}
function closeSettings() {
  if (!onSettings()) return; document.body.classList.remove('settings');
  if (location.hash === '#settings') history.replaceState(null, '', location.pathname + location.search);
}
$('setbtn').onclick = () => { if (location.hash === '#settings') openSettings(); else location.hash = 'settings'; };
const note = (html, err) => { setNote = { tab: setTab, html, err }; };
async function settingsAct(path, body, okHtml) {
  const r = await api(path, body).catch((x) => ({ error: String(x) }));
  if (r.error) note(`<bdi>${esc(r.error)}</bdi>`, true); else note(okHtml ? okHtml(r) : t('set.done'));
  await loadSettings(); if (!r.error) { seats = await api('/api/seats'); showSeats(); }
  return r;
}
const loginNote = (name) => (r) => t('set.added', { name: `<b dir="ltr">${esc(name)}</b>`, cmd: cmd(r.login) }) + (r.home ? ' ' + t('set.addedHome', { dir: `<span dir="ltr">${esc(r.home)}</span>` }) : '') + ' ' + t('set.thenRestart');
$('settings').onchange = (e) => {
  const k = e.target.dataset.set, m = e.target.dataset.model;
  if (k) draft[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.dataset.str ? e.target.value : Math.max(0, Math.round(+e.target.value || 0));
  else if (m != null) { if (e.target.value) draft.models[m] = e.target.value; else delete draft.models[m]; }
  else return;
  $('settings').querySelector('.ssave').hidden = !(setData.firstRun || dirty());
};
// A new language applies at once: the page is drawn again in it (no reload). Back to "browser language": a reload, the server picks it from the browser.
async function relang(code) {
  if (!code) return location.reload();
  if (code === LANG) return;
  await loadLang(code);
  showSeats(); showRoutines(); showMultiSide(); showQuota(); if (onProjects()) showProjects();
  $('effortOut').textContent = EFFORTS[$('effort').value] || t('composer.effortDefault');
  await showConversation(); if (onSettings()) showSettings();
}
$('settings').onclick = async (e) => {
  const b = e.target.closest('button'); if (!b) return; const ds = b.dataset;
  if (ds.sclose != null) return closeSettings();
  if (ds.sdrawer != null) return document.body.classList.add('drawer');
  if (ds.stab) { setTab = ds.stab; setNote = null; showSettings(); $('settings').scrollTop = 0; return; }
  if (ds.sreload != null) { await loadSettings(); return; }
  if (ds.discadd != null) return $('discrows').insertAdjacentHTML('beforeend', discRow());
  if (ds.discrm != null) return b.parentElement.remove();
  if (ds.ssave != null) {
    b.disabled = true; const r = await api('/api/settings', { settings: draft }).catch((x) => ({ error: String(x) })); b.disabled = false;
    if (r.error) { note(`<bdi>${esc(r.error)}</bdi>`, true); return showSettings(); }
    const lang = draft.language, langChanged = lang !== setData.settings.language;
    note(t('set.saved')); draft = null; await loadSettings(); seats = await api('/api/seats'); showSeats(); loadMulti();
    if (langChanged) { await relang(lang); if (onSettings()) { note(t('set.saved')); showSettings(); } }
    return;
  }
  if (ds.restart != null) {
    if (!confirm(t(setData.detected.supervisor ? 'set.confirmRestart' : 'set.confirmStop'))) return;
    b.disabled = true; await api('/api/restart', {}).catch(() => {});
    for (let i = 0, down = false; i < 120; i++) {   // wait until it went away and came back, then load the new page
      await new Promise((r) => setTimeout(r, 1000));
      const up = await fetch('/health').then((r) => r.ok).catch(() => false);
      if (!up) down = true; else if (down) return location.reload();
    }
    return;
  }
  if (ds.rmseat) { if (!confirm(t('set.confirmRemoveSeat', { name: ds.rmseat }))) return; await settingsAct('/api/settings/remove-seat', { name: ds.rmseat }, () => t('set.removed', { name: `<b dir="ltr">${esc(ds.rmseat)}</b>` })); return showSettings(); }
  if (ds.tgtest != null) { await settingsAct('/api/settings/telegram', { action: 'test' }, () => t('set.tg.testSent')); return showSettings(); }
  if (ds.rtog) { const r = await api('/api/routine', { id: ds.rtog, action: ds.to }); if (r.error) note(`<bdi>${esc(r.error)}</bdi>`, true); await loadSettings(); loadRoutines(); return showSettings(); }
  if (ds.redit) {
    const r = setData.routines.find((x) => x.id === ds.redit), f = $('settings').querySelector('[data-form=routine]');
    for (const k of ['id', 'seat', 'cron', 'cwd', 'mode']) f[k].value = r[k] || ''; f.prompt.value = r.prompt ?? ''; if (r.prompt == null) f.prompt.placeholder = t('set.rt.promptFile');
    f.scrollIntoView({ block: 'start' }); return;
  }
  if (ds.rtest) { b.disabled = true; const r = await api('/api/settings/remote', { action: 'test', name: ds.rtest }).catch((x) => ({ error: String(x) })); note(`<bdi>${esc(r.error || r.text)}</bdi>`, !r.ok); return showSettings(); }
  if (ds.rrm) { if (!confirm(t('set.confirmRemoveRemote', { name: ds.rrm }))) return; await settingsAct('/api/settings/remote', { action: 'remove', name: ds.rrm }, () => t('set.removed', { name: `<b dir="ltr">${esc(ds.rrm)}</b>` })); return showSettings(); }
};
$('settings').onsubmit = async (e) => {
  e.preventDefault(); const f = e.target, v = (k) => f[k]?.value ?? '', btn = f.querySelector('[type=submit]'); btn.disabled = true;
  try {
    if (f.dataset.form === 'addseat') await settingsAct('/api/settings/add-seat', { agent: 'claude', name: v('name'), email: v('email'), role: v('role') }, loginNote(v('name')));
    if (f.dataset.form === 'addagent') await settingsAct('/api/settings/add-seat', { agent: v('agent'), name: v('name') }, loginNote(v('name')));
    if (f.dataset.form === 'tgtoken') await settingsAct('/api/settings/telegram', { token: v('token') }, () => t('set.tg.tokenSaved'));
    if (f.dataset.form === 'password') { if (v('next') !== v('again')) { note(t('set.access.differ'), true); return showSettings(); } await settingsAct('/api/settings/password', { current: v('current'), next: v('next') }, () => t('set.access.changed')); }
    if (f.dataset.form === 'routine') await settingsAct('/api/settings/routine', { id: v('id'), seat: v('seat'), cron: v('cron'), cwd: v('cwd'), mode: v('mode'), prompt: v('prompt') }, () => t('set.rt.saved', { id: `<b dir="ltr">${esc(v('id'))}</b>` })).then(() => loadRoutines());
    if (f.dataset.form === 'remote') await settingsAct('/api/settings/remote', { action: 'add', name: v('name'), target: v('target'), identity: v('identity'), control: f.control.checked, paths: v('paths'), account: v('account') }, () => t('set.rem.added', { name: `<b dir="ltr">${esc(v('name'))}</b>` }));
    if (f.dataset.form === 'disc') {
      const disciplines = {}; for (const row of f.querySelectorAll('.sdisc')) { const k = row.querySelector('[name=dname]').value.trim(); if (k) disciplines[k] = row.querySelector('[name=dseat]').value; }
      await settingsAct('/api/settings/disciplines', { owner: v('owner'), disciplines }, () => t('set.proj.saved'));
    }
  } finally { btn.disabled = false; }
  showSettings();
};

init();

// Effort slider: stop 0 keeps the seat's default, stops 1-5 are the CLI's --effort levels, stop 6 is ultracode (see server.mjs).
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
$('effort').addEventListener('input', () => { $('effortOut').textContent = EFFORTS[$('effort').value] || t('composer.effortDefault'); });

// Installable app (PWA): the service worker only runs on https or 127.0.0.1; on plain http over Tailscale this is skipped silently.
if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
$('foldall').onclick = () => { const to = $('foldall').dataset.to === 'true'; for (const s of seats) fold[s.name] = to; saveFold(); showSeats(); };

// Search: titles + chat text of every conversation, archived ones included (server: /api/search, searchidx.mjs).
let qTimer = 0, qSeq = 0;
const runSearch = async () => {
  const q = $('q').value.trim(), on = !!q, seq = ++qSeq;
  $('results').hidden = !on; $('seats').hidden = on; $('routines').hidden = on;
  if (!on) return;
  let r; try { r = await (await fetch('/api/search?q=' + encodeURIComponent(q))).json(); } catch { r = { hits: [], error: true }; }
  if (seq !== qSeq) return;   // a newer query was typed meanwhile
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const re = new RegExp('(' + words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
  const mark = (s) => String(s).split(re).map((p, k) => k % 2 ? `<mark>${esc(p)}</mark>` : esc(p)).join('');
  $('results').innerHTML = (r.partial ? `<p class="qnote">${t('search.partial')}</p>` : '')
    + (r.hits?.length ? r.hits.map((h) => `<button class="conv qhit ${h.id === cur.id ? 'on' : ''}" data-id="${h.id}" data-seat="${esc(h.seat)}"><span class="dot ${h.status === 'stopped' ? '' : h.status}"></span><span class="t" dir="auto">${h.keep ? '★ ' : ''}${mark(h.title)}</span><span class="qseat">${esc(h.seat)}${h.archived ? ' · ' + t('search.archived') : ''}</span>${h.snippet ? `<small dir="auto">${mark(h.snippet)}</small>` : ''}</button>`).join('')
      : `<p class="qnote">${t(r.error ? 'search.failed' : 'search.none')}</p>`);
};
$('q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(runSearch, 250); });
$('q').addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('q').value = ''; runSearch(); } });
$('results').onclick = (e) => { const b = e.target.closest('[data-id]'); if (b) pick(b.dataset.seat, b.dataset.id); };
