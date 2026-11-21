// Seat Console front end: seats with their conversations in the sidebar, one conversation pane, live via SSE.
const TOKEN = document.querySelector('meta[name=seat-token]').content;
const $ = (id) => document.getElementById(id);
const BUILD = document.querySelector('meta[name=seat-build]')?.content || '', HTTPS_URL = document.querySelector('meta[name=seat-https]')?.content || '';
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
    card.dataset.req = ev.requestId; card.dataset.guide = 'perm'; permCards[ev.requestId] = card; out.push(card);
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
  $('cwd').value = c ? c.cwd : projCtx || draftDir || '';   // a new chat: the project it was started in or picked on the chip; empty = the server decides (send())
  if (!c) detectSoon(); showChip();
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
const kfmt = (n) => num(Number(n) || 0, { notation: 'compact', maximumFractionDigits: n >= 1e6 ? 2 : 1 }).replace(/[\u200e\u200f\u061c]/g, '');   // Hebrew / Arabic number formats carry direction marks that would reorder "118K / 200K" inside the LTR meter
const ctxText = (x) => x.window ? `${kfmt(x.used)} / ${kfmt(x.window)} (${pct(x.pct / 100)})` : kfmt(x.used);
const ctxBtnHtml = (c) => {
  const x = c?.ctx; if (!x) return '';
  return `<button type="button" id="ctxbtn" class="cx-${x.level || 'none'}" aria-haspopup="dialog" aria-expanded="${!$('ctxpanel').hidden}" title="${t('ctx.title')}"><span class="cxbar"><i style="width:${Math.min(100, x.pct || 0)}%"></i></span><span dir="${x.compacting ? 'auto' : 'ltr'}">${x.compacting ? t('ctx.compacting') : ctxText(x)}</span></button>`;
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
  return `<small class="meter" data-guide="usage" title="${esc(t('usage.resets', { when: dfmt(v.resetsAt * 1000, { dateStyle: 'medium', timeStyle: 'short' }) }))}">${esc(tk('usage.window.', k).replace(/_/g, ' '))} <span class="bar"><i style="width:${Math.min(100, p)}%"></i></span> ${pct(p / 100)} <span class="reset">${resetText(v.resetsAt * 1000)}${old}</span></small>`;
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
// Folded seats (sidebar E): the seat's one-line row, plus the open conversation and the ones waiting on the user (approval, answer,
// an action with an unknown outcome). Starred chats no longer stay out: "All" is meant to be the seat rows only. Kept per browser.
// Folded is the default ("All"): a seat is open only once the user unfolds it or opens one of its conversations. New key, so the new default applies once.
// fold[name]: undefined = never touched (folded, auto-unfolds when one of its chats is opened), true = folded by the user (stays folded), false = open.
const showMore = {};   // per seat: list every live conversation, not only the newest 12
const fold = (() => { try { return JSON.parse(localStorage.getItem('seatFold') || '{}'); } catch { return {}; } })();
const saveFold = () => { try { localStorage.setItem('seatFold', JSON.stringify(fold)); } catch {} };
const folded = (name) => fold[name] !== false;
const det = new Set();   // seats whose details (email, role, resets with Use) are open under the row: the chevron, or a jump from the rail
let hlSeat = null, hlTimer = 0;   // the seat a rail jump just landed on, tinted for a moment
let menuFor = null;   // conversation id whose ⋯ menu is open
const convRow = (c, seat) => `<div class="convrow ${c.archived ? 'archived' : ''}"><button class="conv ${c.id === cur.id ? 'on' : ''} ${c.pending ? 'ask' : ''} ${c.needsAnswer ? 'answer' : ''}"${c.pending || c.needsAnswer ? ' data-guide="needs"' : ''} data-id="${c.id}" data-seat="${seat}">
      <span class="dot ${DOT[c.status] ?? c.status}"></span><span class="t" dir="auto">${c.keep ? `<span class="kept" title="${t('conv.keptTitle')}">★</span> ` : ''}${esc(c.title)}</span>${c.ctx?.pct != null ? `<span class="cxpct cx-${c.ctx.level}" title="${t('ctx.title')} ${esc(ctxText(c.ctx))}">${pct(c.ctx.pct / 100)}</span>` : ''}
      <small><span class="cost" dir="ltr" title="${t('conv.costTitle')}">~${usd(c.cost || 0)}</span> ${c.mode === 'bypass' ? `<span class="badge bypass">${t('mode.bypass')}</span> ` : ''}${esc(label(c.status))}${c.background ? ' · <bdi>' + esc(c.background) + '</bdi>' : ''}${c.pending ? ' · ' + t('conv.waitingN', { n: num(c.pending) }) : ''}</small>${c.quotaWait ? `<span class="qwait" title="${t('conv.qwaitTitle')}">⏸ ${t('conv.resumesAt', { time: clock(c.quotaWait) })}<span class="dismiss" data-unwait="${c.id}" role="button" title="${t('conv.unwait')}">✕</span></span>` : ''}${c.needsAnswer ? `<span class="needs">❓ ${t('conv.needsAnswer')}<span class="dismiss" data-dismiss="${c.id}" role="button" title="${t('conv.dismissTitle')}">✕</span></span>` : ''}${c.unknownActions ? `<span class="unk" title="${t('conv.unknownTitle')}">⚠️ ${t('conv.unknownActions', { n: num(c.unknownActions) })}</span>` : ''}</button>
      ${c.remote ? '' : `<button class="more" data-more="${c.id}" aria-expanded="${menuFor === c.id}" aria-label="${t('conv.menu')}">⋯</button>`}</div>`
  + (menuFor === c.id ? `<div class="cmenu" data-guide="convmenu"><button data-rename="${c.id}" data-seat="${seat}">${t('conv.renameShort')}</button>${c.needsAnswer ? `<button data-dismiss="${c.id}">${t('conv.closeQuestion')}</button>` : ''}<button data-guide="keep" data-keep="${c.id}" data-to="${!c.keep}" title="${t(c.keep ? 'conv.unkeepTitle' : 'conv.keepTitle')}">${t(c.keep ? 'conv.unkeep' : 'conv.keep')}</button><button data-mvproj="${c.id}">${t('conv.moveProject')}</button><button data-guide="archive" data-archive="${c.id}" data-to="${!c.archived}">${t(c.archived ? 'conv.unarchive' : 'conv.archive')}</button><button class="danger" data-del="${c.id}">${t('common.delete')}</button></div>` : '');

// A non-Claude seat gets a neutral letter mark and its provider's name on the row (no logos); a remote group a dashed avatar.
const PROV = { codex: { mark: 'G', name: 'GPT · Codex' }, agy: { mark: 'A', name: 'Antigravity' } };
const needN = (s) => s.conversations.filter((c) => !c.archived && (c.pending || c.needsAnswer)).length;
const fiveH = (s) => { const w = s.usage?.windows?.five_hour; return !w ? null : w.resetsAt * 1000 <= Date.now() ? 0 : w.utilization; };
const initials = (name) => name.replace(/^remote: /, '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2);
// The two micro meters on a seat row: only the windows the account really reports (Antigravity reports none, so it shows none).
const micro = (u) => !u ? '' : [['five_hour', 'side.m5h'], ['seven_day', 'side.mWeek']].filter(([k]) => u.windows?.[k]).map(([k, lk]) => {
  const v = u.windows[k], p = v.resetsAt * 1000 <= Date.now() ? 0 : Math.round(v.utilization * 100);
  return `<span class="mm ${p >= 85 ? 'hot' : ''}" title="${esc(tk('usage.window.', k))} ${pct(p / 100)}"><span>${t(lk)}</span><em>${num(p)}</em><i style="--v:${Math.min(100, p)}%"></i></span>`;
}).join('');
// Rail avatar: the 5 h usage as a ring (a rounded square for a non-Claude seat), the initials, and how many chats wait on the user.
function avatar(s) {
  const p = PROV[s.agent], u = fiveH(s), n = needN(s), v = u == null ? 0 : Math.min(100, Math.round(u * 100)), col = v >= 85 ? '#f2766d' : '#e8b04a';
  const shape = (extra) => p ? `<rect x="2" y="2" width="32" height="32" rx="9" pathLength="100" ${extra}/>` : `<circle cx="18" cy="18" r="16" pathLength="100" ${extra}/>`;
  const ring = `<svg class="ring" viewBox="0 0 36 36" aria-hidden="true">${shape('class="trk"')}${v ? shape(`fill="none" stroke="${col}" stroke-dasharray="${v} 100"`) : ''}</svg>`;
  const tip = s.name + (u != null ? ` · ${tk('usage.window.', 'five_hour')} ${pct(u)}` : '') + (n ? ' · ' + t('projects.needYou', { n: num(n) }) : '');
  return `<button type="button" class="av ${p ? 'prov' : ''} ${s.remote ? 'remote' : ''}" data-rail="${esc(s.name)}" aria-current="${s.name === cur.seat}" aria-expanded="${!folded(s.name)}" title="${esc(tip)}" aria-label="${esc(t('side.goSeat', { seat: s.name }) + (n ? ', ' + t('projects.needYou', { n: num(n) }) : ''))}">${ring}<span class="ini">${esc(initials(s.name))}</span>${p ? `<span class="pmark" aria-hidden="true">${p.mark}</span>` : ''}${n ? `<span class="badge">${num(n)}</span>` : ''}</button>`;
}
function showRail() {
  const allFolded = seats.every((s) => folded(s.name));
  $('foldall').setAttribute('aria-pressed', String(allFolded)); $('foldall').dataset.to = String(!allFolded);
  const nl = needList(); $('needsum').hidden = !nl.length; $('needsum').textContent = nl.length ? t('projects.needYou', { n: num(nl.length) }) : ''; $('needsum').title = t('side.needList');
  if (!$('needpop').hidden) { if (nl.length) showNeedPop(); else closeNeedPop(); }   // an open list follows the live updates
  $('avs').innerHTML = seats.map(avatar).join('');
}
// "N need you" in the panel header opens this list: every conversation, on any seat, that waits on the user, newest first. A row opens it (normal view).
const needList = () => allConvs().filter((c) => !c.archived && (c.pending || c.needsAnswer || c.quotaWait || c.unknownActions)).sort((a, b) => b.updatedAt - a.updatedAt);
function showNeedPop() {
  const html = `<h2>${t('side.needList')}</h2>` + needList().map((c) => {
    const s = seats.find((x) => x.name === c.seat), why = [c.pending && t('project.needPerms'), c.needsAnswer && t('project.needAnswer'), c.quotaWait && t('project.needQuota'), c.unknownActions && t('conv.unknownActions', { n: num(c.unknownActions) })].filter(Boolean).join(' · ');
    const dir = c.project || c.cwd, proj = dir ? dir.split(/[\\/]/).filter(Boolean).pop() : '';
    return `<button type="button" class="nrow" data-nid="${esc(c.id)}" data-nseat="${esc(c.seat)}"><span class="nini ${PROV[s?.agent] ? 'prov' : ''}" title="${esc(c.seat)}">${esc(initials(c.seat))}</span><span class="nt" dir="auto">${esc(c.title)}</span><small class="nage">${tm(c.updatedAt)}</small><small><b>${esc(why)}</b>${proj ? ` · <bdi>${esc(proj)}</bdi>` : ''}</small></button>`;
  }).join('');
  if ($('needpop').innerHTML !== html) { const f = document.activeElement?.dataset?.nid, top = $('needpop').scrollTop; $('needpop').innerHTML = html; $('needpop').scrollTop = top; if (f) $('needpop').querySelector(`[data-nid="${CSS.escape(f)}"]`)?.focus(); }   // a live update keeps scroll and focus
}
const closeNeedPop = () => { $('needpop').hidden = true; $('needsum').setAttribute('aria-expanded', 'false'); };
$('needsum').onclick = () => { if (!$('needpop').hidden) return closeNeedPop(); showNeedPop(); $('needpop').hidden = false; $('needsum').setAttribute('aria-expanded', 'true'); $('needpop').querySelector('.nrow')?.focus(); };
$('needpop').onclick = (e) => { const b = e.target.closest('[data-nid]'); if (b) { closeNeedPop(); pick(b.dataset.nseat, b.dataset.nid); } };
document.addEventListener('click', (e) => { if (!$('needpop').hidden && !e.target.closest('#needpop, #needsum')) closeNeedPop(); }, true);   // a click anywhere else closes it
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('needpop').hidden && !e.defaultPrevented && !e.target.closest?.('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')) { closeNeedPop(); $('needsum').focus(); } });   // not while Esc belongs to a field (search, rename, composer)
const CHEV = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="m3.5 2 3 3-3 3"/></svg>', PLUS = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2.5v9M2.5 7h9"/></svg>';
function showSeats() {
  showQuota(); menuMark(); showRail();
  $('seats').innerHTML = seats.map((s) => {
    const live = s.conversations.filter((c) => !c.archived), arch = s.conversations.filter((c) => c.archived), f = folded(s.name), d = det.has(s.name), p = PROV[s.agent];
    const shown = f ? s.conversations.filter((c) => c.id === cur.id || (!c.archived && (c.pending || c.needsAnswer || c.unknownActions))) : (showMore[s.name] ? live : live.slice(0, 12)), more = f ? 0 : live.length - shown.filter((c) => !c.archived).length;   // the open conversation stays even when archived
    const w = live.filter((c) => c.status === 'working' || c.status === 'waiting').length, n = needN(s);
    return `<section class="seatbox ${f ? 'folded' : ''} ${d && !f ? 'det' : ''} ${hlSeat === s.name ? 'hl' : ''}" data-seat="${esc(s.name)}"><div class="seathead ${s.name === cur.seat && !cur.id ? 'on' : ''}" data-guide="seat">`
      + `<button type="button" class="chev" data-det="${esc(s.name)}" aria-expanded="${!f}" aria-label="${esc(t('side.details', { seat: s.name }))}">${CHEV}</button>`
      + `<button type="button" class="sname" data-fold="${esc(s.name)}" aria-expanded="${!f}" title="${t(f ? 'side.unfoldSeat' : 'side.foldSeat')}"><b>${esc(s.name)}</b>${p ? `<small class="prov">${p.name}</small>` : ''}</button>`
      + `<span class="mms">${micro(s.usage)}</span>`
      + `<span class="counts" title="${esc(t('side.countsTitle', { w: num(w), n: num(n) }))}">${w ? `<span><i class="dot working"></i>${num(w)}</span>` : ''}${n ? `<span class="cn"><i class="dot waiting"></i>${num(n)}</span>` : ''}</span>`
      + (s.remote && !s.control ? '<span></span>' : `<button type="button" class="newb" data-guide="new" data-new="${esc(s.name)}" title="${t('side.newConversation')}" aria-label="${t('side.newConversation')}">${PLUS}</button>`) + '</div>'
      + (d && !f ? `<div class="sdet"><small dir="ltr">${esc(s.email)}</small><small class="role" dir="auto">${esc(s.role)}</small>${meter(s.usage)}${resetsBox(s)}</div>` : '')
      + shown.map((c) => convRow(c, s.name)).join('')
      + (more > 0 || (!f && showMore[s.name] && live.length > 12) ? `<button class="archtoggle" data-showmore="${esc(s.name)}">${showMore[s.name] ? t('side.showFewer') : t('side.showMore', { n: num(more) })}</button>` : '')
      + (!f && arch.length ? `<button class="archtoggle" data-archtoggle="${s.name}">${t(showArch[s.name] ? 'side.hideArchived' : 'side.showArchived', { n: num(arch.length) })}</button>` : '')
      + (!f && showArch[s.name] ? arch.map((c) => convRow(c, s.name)).join('') : '') + '</section>';
  }).join('');
}
// Rail avatar: unfold that seat with its details open, scroll it to the top of the panel and tint it for a moment. "All" folds every seat (again: opens all).
function railGo(name) {
  if ($('sidetop').classList.contains('searching')) clearSearch();
  fold[name] = false; saveFold(); det.add(name); hlSeat = name; showSeats();
  const box = [...$('seats').querySelectorAll('.seatbox')].find((x) => x.dataset.seat === name);
  if (box) $('sidescroll').scrollTo({ top: box.offsetTop - 6, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  clearTimeout(hlTimer); hlTimer = setTimeout(() => { hlSeat = null; $('seats').querySelector('.seatbox.hl')?.classList.remove('hl'); }, 1600);
}

// The sidebar is rebuilt at most once per frame and not more than 4 times a second, however many updates arrive.
let seatsAt = 0, seatsTimer = 0;
function scheduleSeats() {
  if (projCtx && !$('pbar').contains(document.activeElement)) renderPbar();   // live dots in the project bar
  if (seatsTimer) return;
  seatsTimer = setTimeout(() => { seatsTimer = 0; seatsAt = performance.now(); requestAnimationFrame(showSeats); }, Math.max(0, 250 - (performance.now() - seatsAt)));
}
async function pick(seat, id, ctx = null) {   // ctx: a project dir = open it inside that project (project bar on top); null = the normal view
  if (!id && seats.find((s) => s.name === seat && s.remote && !s.control)) seat = seats.find((s) => !s.remote).name;   // a read-only remote group has no new-conversation draft (no composer)
  cur = { seat, id }; localStorage.setItem('seat', seat); if (id && fold[seat] === undefined) { fold[seat] = false; saveFold(); } closeProjects(); closeSettings(); closeGuide(); draftDir = null; if (ctx !== false) setCtx(ctx, id);   // false (first paint): leave the address alone, openHash reads it next; an opened conversation unfolds its seat unless the user folded that seat himself (fold true)
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

// Shared from Android's share sheet (sw.js takeShare parked the files): they become attachments of a NEW chat on the last-used seat, which init has
// just opened. A new chat, not the last open one: something shared from outside usually starts a new task, and nothing is sent until the user presses Send.
async function takeShare() {
  history.replaceState(null, '', location.pathname);
  let c, files = [], text = ''; try { c = await caches.open('seat-console-share'); } catch { return; }
  for (const k of await c.keys()) {
    const r = await c.match(k);
    if (k.url.endsWith('/share/text')) text = await r.text();
    else files.push(new File([await r.blob()], decodeURIComponent(r.headers.get('X-Name') || 'file'), { type: r.headers.get('Content-Type') || '' }));
    await c.delete(k);
  }
  diag({ k: 'share', files: files.map((f) => f.type || '?'), text: !!text });
  if (text) $('text').value = text;
  if (files.length) await attach(files);
  caretEnd();
}
async function init() {
  try { await loadLang(LANG); } finally { document.documentElement.dataset.ready = '1'; }   // the page stays hidden until its words are in (app.css), never longer than this
  seats = await api('/api/seats');
  if (!seats.find((s) => s.name === cur.seat && (!s.remote || s.control))) cur.seat = seats[0].name;   // a read-only remote group has no "new conversation" draft
  await pick(cur.seat, null, false);
  if (new URLSearchParams(location.search).has('share')) await takeShare(); else openHash(); window.addEventListener('hashchange', openHash);
  loadSettings().then(() => { if (setData?.firstRun && !onSettings()) openSettings('start'); offerTour(); });   // offerTour (tour.js): the one-time "quick tour?" question   // first start: Settings opens by itself (not awaited: detection may take seconds)
  loadRoutines(); setInterval(() => { if (!document.hidden) loadRoutines(); }, 30000);
  loadMulti(); setInterval(() => { if (!document.hidden) loadMulti(); }, 60000);
  setInterval(() => { if (!document.hidden) showSeats(); }, 60000);   // keeps the "in 1:12" countdowns and expired windows current
  setInterval(() => { if (Date.now() - beat > 50000) watch(false); }, 10000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resync(); });
}

function onEvent(m) {
  beat = Date.now();
  const d = JSON.parse(m.data);
  if (d.build) { $('newver').hidden = d.build === BUILD || BUILD === '__BUILD__'; return; }   // a restart with new code: offer a reload instead of running old JS
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
    scheduleSeats(); if (onProjects()) { clearTimeout(convRefresh); convRefresh = setTimeout(loadMulti, 2000); }
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
  const unk = c?.unknown || [];   // the action journal's open intents (server: journal.mjs): the user says whether each one happened
  $('pins').hidden = !pins.length && !unk.length;
  $('pins').innerHTML = unk.map((u) => `<span class="pin unk" title="${t('conv.unknownTitle')}"><span class="pjump" dir="auto">⚠️ ${esc(u.what)}${u.check ? `<small>${t('pins.unknownCheck', { check: esc(u.check) })}</small>` : ''}</span>`
    + `<button type="button" class="pdone" data-jid="${esc(u.id)}" data-outcome="done">${t('pins.journalDone')}</button><button type="button" class="pdone jfail" data-jid="${esc(u.id)}" data-outcome="failed">${t('pins.journalFailed')}</button></span>`).join('') + pins.map((p) => `<span class="pin ${p.kind}"><button type="button" class="pjump" data-jump="${p.i}" dir="auto" title="${t('pins.show')}">${PIN_ICON[p.kind] || '📌'} ${esc(p.text)}</button>`
    + (p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" aria-label="${t('pins.openLink')}">↗</a>` : '') + `<button type="button" class="pdone" data-done="${esc(p.id)}" aria-label="${t('pins.done')}">✓</button></span>`).join('');
  $('suggest').hidden = !sug.length;
  $('suggest').innerHTML = sug.map((t) => `<button type="button" class="chip" dir="auto" data-sug="${esc(t)}">↩ ${esc(t)}</button>`).join('');
}
// Phone: the sidebar is a closed drawer, so the ☰ button carries the mark when ANOTHER conversation waits for an answer.
const menuMark = () => $('menu')?.classList.toggle('ans', allConvs().some((c) => c.needsAnswer && c.id !== cur.id && !c.archived));
$('pins').onclick = async (e) => {
  const jb = e.target.closest('[data-jid]'); if (jb) { jb.disabled = true; const r = await api('/api/journal', { conversationId: cur.id, id: jb.dataset.jid, outcome: jb.dataset.outcome }); if (r.error) { jb.disabled = false; alert(r.error); } return; }
  const d = e.target.closest('[data-done]'); if (d) { const r = await api('/api/pin', { conversationId: cur.id, action: 'done', id: d.dataset.done }); if (r.error) alert(r.error); return; }
  const j = e.target.closest('[data-jump]'); if (!j) return;
  // the message the pin points at = the last message at or before its event index (a question pin points at the turn's result, the reply text sits just before it)
  const at = +j.dataset.jump, el = [...$('log').querySelectorAll('.msg.assistant[data-i], .msg.user[data-i], .msg.note.err[data-i]')].filter((x) => +x.dataset.i <= at).pop();
  if (!el) return alert(t('pins.tooOld'));
  el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600);
};
$('suggest').onclick = (e) => { const b = e.target.closest('[data-sug]'); if (!b) return; $('text').value = b.dataset.sug; caretEnd(); };   // into the input, never sent by itself

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
let convRefresh, projDir = null, projData = null, projFirst = false, projArchOpen = false, projMoreOpen = false, projOpenRuns = new Set(), projFinOpen = new Set(), startOpen = false, allOpen = false, projPrefill = null, multiData = { projects: [], disciplines: {}, owner: '', folders: [] }, folderQ = '', multiLoaded = false, focusId = null;
const mstatus = (s) => tk('mstatus.', s);
const ACTIVE = (p) => !['done', 'cancelled'].includes(p.status);
const onProjects = () => document.body.classList.contains('projects');
async function loadMulti() {
  try { multiData = await api('/api/multi'); } catch { return; }
  multiLoaded = true; $('multi').hidden = $('projbtn').hidden = !!multiData.hidden; showMultiSide(); if (projCtx) loadPctx(); if (onProjects() && !($('projects').contains(document.activeElement) && document.activeElement.matches('input, textarea, select'))) { if (projDir) loadProject(); else { showProjects(); flashCard(); } }   // a half-typed brief or filter is never wiped by a refresh
}
// Sidebar: one entry to the page + the projects still going, each a link to its card.
function showMultiSide() {
  const act = multiData.projects.filter(ACTIVE), ask = act.filter((p) => p.status === 'plan-ready' || p.status.endsWith('error') || p.tasks.some((t) => ['error', 'stuck', 'needs-answer'].includes(t.status))).length;
  const pb = $('projbtn'), bd = pb.querySelector('.rbadge');
  bd.hidden = !ask; bd.textContent = ask ? num(ask) : ''; pb.title = t('projects.open') + (ask ? ' · ' + t('projects.needYou', { n: num(ask) }) : ''); pb.setAttribute('aria-label', pb.title);
  $('multi').innerHTML = act.length ? `<div class="mruns">${act.map((p) => `<a class="mline" href="#project/${encodeURIComponent(p.dir)}"><span class="dot working"></span><span dir="auto">${esc(p.name)}</span><small>${esc(mstatus(p.status))}${p.tasks.length ? ` · ${num(p.tasks.filter((x) => x.status === 'done').length)}/${num(p.tasks.length)}` : ''}</small></a>`).join('')}</div>` : '';   // a running run opens its project's page
}
// The Projects page shows only the minimum: one compact row per folder with something going on (live conversations opened there or
// related to it, or a run), its runs as one line each, finished runs behind a toggle. Tasks, conversations and run controls live on the project page.
const sameDir = (a, b) => a.replace(/[\\/]+$/, '') === b.replace(/[\\/]+$/, '');
const runLine = (p) => {
  const done = p.tasks.filter((k) => k.status === 'done').length, hot = p.status === 'plan-ready' || p.status.endsWith('error') || p.tasks.some((k) => ['error', 'stuck', 'needs-answer'].includes(k.status));
  return `<a class="po-run${ACTIVE(p) ? '' : ' is-done'}" id="multi-${esc(p.id)}" href="#project/${encodeURIComponent(p.dir)}"><span class="po-rn" dir="auto">${esc(p.name)}</span>`
    + (p.tasks.length ? `<span class="pj-rail po-rail" aria-hidden="true">${p.tasks.map((k) => `<i class="s-${SEG[k.status] || 'queued'}"></i>`).join('')}</span><span class="pj-of">${t('projects.of', { done: num(done), n: num(p.tasks.length) })}</span>` : '')
    + `<span class="po-st${hot ? ' pj-hot' : ''}">${esc(mstatus(p.status))}</span></a>`;
};
function projRow(x, runs) {
  const parts = x.name.split(/[\\/]/), leaf = parts.pop(), act = runs.filter(ACTIVE), fin = runs.filter((p) => !ACTIVE(p)), r = act.find((p) => p.status === 'running' && p.tasks.length);
  const last = Math.max(x.last || 0, ...runs.map((p) => p.updatedAt || p.createdAt || 0));
  const counts = [x.working && `<b>${t('project.pulseWorking', { n: num(x.working) })}</b>`, x.need && `<b class="pj-hot">${t('project.pulseNeed', { n: num(x.need) })}</b>`, last && tm(last)].filter(Boolean).join('<span class="pj-sep" aria-hidden="true"></span>');
  const prog = r ? r.tasks.filter((k) => k.status === 'done').length / r.tasks.length : 0;
  return `<li class="po-row${x.need ? ' is-hot' : ''}"><div class="po-head"><a class="po-id" href="#project/${encodeURIComponent(x.dir)}">${parts.length ? `<span class="po-crumb" dir="ltr">${esc(parts.join(' / '))} /</span>` : ''}<b dir="auto">${esc(leaf)}</b></a>`
    + `<span class="po-counts">${counts}</span><a class="mopen" data-guide="open-project" href="#project/${encodeURIComponent(x.dir)}">${t('projects.openProject')}</a></div>`
    + (r ? `<span class="po-prog" aria-hidden="true"><i style="width:${Math.round(prog * 100)}%"></i></span>` : '')
    + act.map(runLine).join('')
    + (fin.length ? `<details class="po-fin" data-fin="${esc(x.dir)}"${projFinOpen.has(x.dir) ? ' open' : ''}><summary>${t('projects.finishedN', { n: num(fin.length) })}</summary>${fin.map(runLine).join('')}</details>` : '') + `</li>`;
}
function folderList() {
  const q = folderQ.trim().toLowerCase(), all = quietFolders(), hits = q ? all.filter((f) => f.name.toLowerCase().includes(q)) : all;
  return hits.slice(0, 40).map((f) => `<div class="mfolder"><a href="#project/${encodeURIComponent(f.dir)}" dir="ltr">${esc(f.name)}</a><span class="racts"><a class="mopen" href="#project/${encodeURIComponent(f.dir)}">${t('projects.openProject')}</a><button data-mchat="${esc(f.dir)}">${t('projects.newChat')}</button></span></div>`).join('')
    + (hits.length > 40 ? `<small>${t('projects.moreFolders', { n: num(hits.length - 40) })}</small>` : '') + (!hits.length ? `<small>${t('projects.noFolder')}</small>` : '');
}
// A folder is active with a live conversation opened in it or related to it, or a run that is still going.
const isActive = (x, runs) => x.live || x.related || runs.some(ACTIVE);
const runsOf = (dir) => multiData.projects.filter((p) => sameDir(p.dir, dir));
const quietFolders = () => (multiData.folders || []).filter((f) => !isActive(f, runsOf(f.dir)));
function showProjects() {
  const old = $('mform'), keep = old && { name: old.name.value, dir: old.dir.value, owner: old.owner.value, brief: old.brief.value };   // a re-render never loses a half-typed project
  const seatsOpt = [...new Set([multiData.owner, ...Object.values(multiData.disciplines)])], folders = multiData.folders || [];
  // rows: active folders, plus a run whose folder is not listed (its own row, named by its dir); needs-you first, then the latest activity
  const lone = multiData.projects.filter((p) => !folders.some((f) => sameDir(f.dir, p.dir))).map((p) => p.dir).filter((d, i, a) => a.findIndex((x) => sameDir(x, d)) === i);
  const rows = [...folders.filter((f) => isActive(f, runsOf(f.dir))), ...lone.map((d) => ({ ...runsOf(d)[0], name: d.split(/[\\/]/).slice(-2).join('/'), dir: d }))]
    .map((x) => ({ x, runs: runsOf(x.dir), last: Math.max(x.last || 0, ...runsOf(x.dir).map((p) => p.updatedAt || p.createdAt || 0)) })).sort((a, b) => (b.x.need || 0) - (a.x.need || 0) || b.last - a.last);
  const quiet = quietFolders().length;
  // ☰ (phone: opens the seat list) and Close (back to the conversation), like the Settings page: without them a phone had no way back
  $('projects').innerHTML = `<header class="phead shead"><button type="button" class="smenu" data-pdrawer aria-label="${t('side.seats')}">☰</button><div><h2>🧩 ${t('projects.title')}</h2><small>${t('projects.intro')}</small></div><button type="button" data-pclose>${t('common.close')}</button></header>`
    + `<div class="po">`
    + (multiData.off ? `<p class="err">${t('projects.off')} <bdi>${esc(multiData.off)}</bdi></p>` : '')
    + `<details class="po-start" data-guide="run-form"${startOpen ? ' open' : ''}${multiData.off ? ' hidden' : ''}><summary>${t('projects.startRun')}</summary><form id="mform"><input name="name" placeholder="${t('projects.namePh')}" aria-label="${t('projects.namePh')}" required dir="auto"><input name="dir" placeholder="${t('projects.dirPh')}" aria-label="${t('projects.dirPh')}" dir="auto" spellcheck="false">`
    + `<label>${t('projects.ownerLabel')} <select name="owner">${seatsOpt.map((s) => `<option${s === multiData.owner ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label>`
    + `<textarea name="brief" rows="7" placeholder="${t('projects.briefPh')}" aria-label="${t('projects.briefPh')}" required dir="auto"></textarea>`
    + `<small dir="ltr">${Object.entries(multiData.disciplines).map(([d, s]) => `${esc(d)}→${esc(s)}`).join(' · ')}</small><div class="racts"><button type="submit" class="primary">${t('projects.plan')}</button></div></form></details>`
    + (rows.length ? `<ol class="po-list" data-guide="folders">${rows.map(({ x, runs }) => projRow(x, runs)).join('')}</ol>` : `<p class="pj-quiet">${t('projects.nothingRunning')}</p>`)
    + `<details class="po-all"${allOpen ? ' open' : ''}><summary>${t('projects.allFolders', { n: num(quiet) })}</summary><input id="mfq" type="search" placeholder="${t('projects.filterPh')}" aria-label="${t('projects.filterPh')}" value="${esc(folderQ)}" dir="auto" spellcheck="false"><div id="mfolders">${folderList()}</div></details></div>`;
  const f = $('mform'); if (keep) for (const k of ['name', 'dir', 'owner', 'brief']) if (keep[k]) f[k].value = keep[k];
  if (projPrefill) { startOpen = f.parentElement.open = true; f.dir.value = projPrefill.dir; if (!f.name.value) f.name.value = projPrefill.name; projPrefill = null; f.scrollIntoView({ block: 'start' }); f.brief.focus(); }   // "Start a run here" on a project page
}
// One project's page (#project/<dir>): what is going on in that folder. Data: GET /api/project.
const NEED = { perms: 'project.needPerms', answer: 'project.needAnswer', quota: 'project.needQuota', error: 'project.needError' };
const ago = (ms) => { const s = (ms - Date.now()) / 1e3, a = Math.abs(s), [v, u] = a < 45 ? [0, 'second'] : a < 3600 ? [s / 60, 'minute'] : a < 864e2 ? [s / 3600, 'hour'] : [s / 864e2, 'day']; return new Intl.RelativeTimeFormat(intl(), { numeric: 'auto' }).format(Math.round(v), u); };   // "3 min ago", in the page's language
const tm = (ms) => !Number.isFinite(ms) || !ms ? '' : `<time datetime="${new Date(ms).toISOString()}" title="${esc(when(ms))}">${esc(ago(ms))}</time>`;
const ico = (d, cls = '') => `<svg class="pj-ico ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const ICO = { check: 'M5 12.5l4.5 4.5L19 7.5', arrow: 'M5 12h13M13 6l6 6-6 6', back: 'M19 12H6M11 6l-6 6 6 6', branch: 'M7 4v11M7 15a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM17 4a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM17 9c0 4.5-5 4-10 7', menu: 'M4 7h16M4 12h16M4 17h16' };
const SEG = { done: 'done', running: 'run', error: 'bad', stuck: 'bad', 'needs-answer': 'bad' };   // run rail: task status -> segment look (anything else is queued)
const DOT = { stopped: '' };   // status -> dot class where they differ (a stopped conversation shows a plain dot)
function renderProject() {
  const d = projData, name = d?.name || projDir, parts = name.split(/[\\/]/), leaf = parts.pop(), crumb = parts.join(' / ');
  const tag = projTag(leaf), cv = (id) => `#project/${encodeURIComponent(projDir)}/c/${esc(id)}`;
  const ttl = (c) => esc(c.title.replace(tag, '') || c.title), dot = (c) => `<span class="dot ${DOT[c.status] ?? c.status}"></span>`;
  const meter = (c) => c.status === 'working' ? '<span class="pj-meter" aria-hidden="true"><i></i><i></i><i></i></span>' : dot(c);
  const back = `<button type="button" class="pj-back" data-mback>${ico(ICO.back, 'fl')}${t('project.back')}</button>`;
  const menu = `<button type="button" class="smenu" data-pdrawer aria-label="${t('side.seats')}">${ico(ICO.menu)}</button>`;
  if (d?.error) projFirst = false;   // an error page is the first paint too
  if (!d || d.error) return $('projects').innerHTML = `<div class="pj"><header class="pj-hero"><div class="pj-top">${menu}${back}</div><h1 class="pj-name"><bdi dir="auto">${esc(leaf)}</bdi></h1><p class="pj-pulse">${d ? t('project.notFound') : ''}</p></header></div>`;
  const rel = d.related || [], all = [...d.convs, ...d.archived], need = [...all, ...rel].filter((c) => c.need.length), live = d.convs.filter((c) => !c.need.length);   // a conversation that needs the user shows only there
  const arch = d.archived.filter((c) => !c.need.length), work = live.filter((c) => ['working', 'waiting'].includes(c.status)), idle = live.filter((c) => !work.includes(c)), g = d.git, md = d.handoff;
  const last = Math.max(d.mtime || 0, ...all.map((c) => c.updatedAt || 0), ...rel.map((c) => c.updatedAt || 0), ...(g?.commits || []).map((k) => (k.at || 0)));
  const pulse = [`<b>${t('project.pulseWorking', { n: num(work.length) })}</b>`, need.length && `<b class="pj-hot">${t('project.pulseNeed', { n: num(need.length) })}</b>`, last && t('project.pulseLast', { when: tm(last) })].filter(Boolean).join('<span class="pj-sep" aria-hidden="true"></span>');
  const head = (k, n) => `<h2 class="pj-h">${t(k)}${n ? ` <span class="pj-count">${num(n)}</span>` : ''}</h2>`;
  const meta = (c, ...pre) => `<span class="pj-meta">${[...pre, `<bdi dir="ltr" class="pj-num">${usd(c.cost || 0)}</bdi>`, tm(c.updatedAt)].join('<span class="pj-sep" aria-hidden="true"></span>')}</span>`;
  const row = (c) => `<a class="pj-row" href="${cv(c.id)}">${meter(c)}<span class="pj-rt" dir="auto">${ttl(c)}</span>${meta(c, `<bdi>${esc(c.seat)}</bdi>`, esc(label(c.status)))}</a>`;
  const spot = work[0];
  const hero = `<header class="pj-hero"><div class="pj-top">${menu}${back}</div><div class="pj-herorow"><div class="pj-id">`
    + `${crumb ? `<span class="pj-crumb" dir="ltr">${esc(crumb)} /</span>` : ''}<h1 class="pj-name" title="${esc(projDir)}"><bdi dir="auto">${esc(leaf)}</bdi></h1>`
    + `<p class="pj-pulse">${pulse}</p>${g ? `<div class="pj-chips"><span class="pj-chip" dir="ltr">${ico(ICO.branch)}${esc(g.branch)}</span><span class="pj-chip ${g.dirty ? 'is-dirty' : 'is-clean'}">${t(g.dirty ? 'project.dirty' : 'project.clean')}</span></div>` : ''}</div>`
    + `<div class="pj-cta"><button class="primary" data-mchat="${esc(projDir)}">${t('projects.newChat')}</button><button data-mrun="${esc(projDir)}" data-mname="${esc(leaf)}">${t('project.startRun')}</button></div></div></header>`;
  const attn = need.length
    ? `<section class="pj-attn" data-guide="pj-needs" aria-labelledby="pj-attn-h"><div class="pj-attnhead"><span class="pj-count">${num(need.length)}</span><h2 class="pj-h" id="pj-attn-h">${t('project.needs')}</h2></div><ul>${need.map((c) => `<li><a class="pj-need" href="${cv(c.id)}"><span class="pj-why">${c.need.map((k) => t(NEED[k])).join(' · ')}${rel.includes(c) ? `<span class="pj-tag">${t('project.relatedTag')}</span>` : ''}</span><span class="pj-rt" dir="auto">${ttl(c)}</span>${meta(c, `<bdi>${esc(c.seat)}</bdi>`)}<span class="pj-go">${t('project.open')}${ico(ICO.arrow, 'fl')}</span></a></li>`).join('')}</ul></section>`
    : `<section class="pj-clear" data-guide="pj-needs">${ico(ICO.check)}<div><b>${t('project.allClear')}</b><span>${t('project.allClearSub')}</span></div></section>`;
  const working = `<section class="pj-sec pj-work" data-guide="pj-working">${head('project.working', work.length)}`
    + (spot ? `<a class="pj-spot" href="${cv(spot.id)}"><span class="pj-spotseat">${meter(spot)}<bdi>${esc(spot.seat)}</bdi><span>${esc(label(spot.status))}</span></span><span class="pj-spott" dir="auto">${ttl(spot)}</span>${meta(spot)}</a>` : `<p class="pj-quiet">${t('project.noWorking')}</p>`)
    + (work.length > 1 ? `<div class="pj-list">${work.slice(1).map(row).join('')}</div>` : '') + `</section>`;
  const runs = d.runs.length ? `<section class="pj-sec pj-runs" data-guide="pj-runs">${head('project.runs')}${d.runs.map(pjRun).join('')}</section>` : '';
  // Related (touched.mjs on the server): conversations opened elsewhere that edited or read files here. Most edits first.
  const why = (c) => [c.w && tn('project.edited', c.w), c.r && tn('project.read', c.r)].filter(Boolean).join(' · ');
  const relRow = (c) => `<div class="pj-row pj-relrow${c.archived ? ' is-arch' : ''}">${dot(c)}<div class="pj-relmain"><a class="pj-rt" href="${cv(c.id)}" dir="auto">${ttl(c)}</a>${meta(c, `<bdi>${esc(c.seat)}</bdi>`, esc(label(c.status)), `<span class="pj-why">${why(c)}</span>`)}</div>`
    + `<div class="pj-relacts"><button type="button" data-pin="${esc(c.id)}">${t('project.pin')}</button><button type="button" data-notrel="${esc(c.id)}">${t('project.notRelated')}</button></div></div>`;
  const opened = d.convs.length + d.archivedCount;   // a related one that needs the user stays in Related too: Not related must be reachable
  const branch = (cls, k, n, body) => `<section class="pj-branch ${cls}"><h2 class="pj-bh">${t(k)} <span class="pj-num">${num(n)}</span></h2><div class="pj-twig">${body}</div></section>`;
  const rest = `<section class="pj-sec">${head('project.idle', idle.length)}<div class="pj-list">${idle.map(row).join('') || `<p class="pj-quiet">${t('project.noConvs')}</p>`}</div>`
    + (arch.length ? `<details class="pj-arch"${projArchOpen ? ' open' : ''}><summary>${t('project.archived')} <span class="pj-num">${num(arch.length + d.archivedCount - d.archived.length)}</span></summary><div class="pj-list">${arch.map(row).join('')}</div></details>` : '') + `</section>`;
  const side = (md ? `<section class="pj-sec pj-read" data-guide="pj-happening">${head('project.happening')}<div class="pj-md" dir="auto">${pjMd(md.text)}</div><small class="pj-src" dir="ltr">${t('project.handoffNote', { file: esc(md.file) })}</small></section>` : '')
    + (g?.commits.length ? `<section class="pj-sec pj-git"><h2 class="pj-h">${t('project.commits')}</h2>`
      + `<ol class="pj-log">${g.commits.map((k) => `<li><code dir="ltr">${esc(k.hash)}</code><span dir="auto">${esc(k.subject)}</span>${k.at ? tm(k.at) : ''}</li>`).join('')}</ol></section>` : '');
  const tree = branch('pj-opened', 'project.opened', opened, `${working}<div class="pj-rest">${rest}</div>`), related = rel.length ? branch('pj-relb', 'project.related', d.relatedCount, `<div class="pj-list">${rel.map(relRow).join('')}</div>`) : '';
  $('projects').innerHTML = `<div class="pj${projFirst ? ' enter' : ''}${side ? '' : ' no-side'}">${hero}${attn}<div class="pj-grid"><div class="pj-main">${tree}${runs}${related}</div>${side ? `<div class="pj-side">${side}</div>` : ''}</div></div>`;
  projFirst = false;
}
// A run of this folder: a segmented rail (one segment per task), the task being worked on, every task behind "Show all tasks"; same buttons as its card on the Projects page.
function pjRun(p) {
  const done = p.tasks.filter((k) => k.status === 'done').length, cur = p.tasks.find((k) => k.status === 'running');
  const retry = (task, label = t('projects.retry')) => `<button data-mretry="${esc(p.id)}" data-task="${esc(task)}">${label}</button>`;
  const acts = (p.status === 'plan-ready' ? `<button class="primary" data-mapprove="${esc(p.id)}">${t('projects.approve')}</button>` : '')
    + (p.status === 'plan-error' ? retry('plan', t('projects.retryPlan')) : '') + (p.status === 'integrate-error' ? retry('integrate', t('projects.retryIntegration')) : '')
    + (ACTIVE(p) ? `<button data-mcancelp="${esc(p.id)}">${t('projects.cancel')}</button>` : '');
  const cv = (id) => `#project/${encodeURIComponent(projDir)}/c/${esc(id)}`, tt = (k) => k.conv ? `<a href="${cv(k.conv)}" dir="auto">${esc(k.title)}</a>` : `<span dir="auto">${esc(k.title)}</span>`;
  const task = (k) => `<li class="pj-task s-${SEG[k.status] || 'queued'}"><i class="pj-sq" aria-hidden="true"></i><div>${tt(k)}<small><bdi>${esc(k.discipline)} → ${esc(k.seat)}</bdi> · ${esc(mstatus(k.status))}${k.status === 'pending' && k.waitUntil ? ' · ' + t('projects.waitsFor', { seat: `<bdi>${esc(k.seat)}</bdi>`, when: when(k.waitUntil) }) : ''}${k.deps.length && k.status !== 'done' ? ' · ' + t('projects.after', { tasks: `<bdi>${esc(k.deps.join(', '))}</bdi>` }) : ''}</small>`
    + `${k.unknownActions ? `<small class="pj-err" title="${t('conv.unknownTitle')}">${t('conv.unknownActions', { n: num(k.unknownActions) })}</small>` : ''}${k.error || k.sendError ? `<small class="pj-err" dir="auto">${esc(k.error || k.sendError)}</small>` : ''}</div>`
    + `${['error', 'stuck', 'needs-answer', 'running'].includes(k.status) && p.status === 'running' ? retry(k.id, k.status === 'running' ? t('projects.continue') : t('projects.retry')) : ''}</li>`;
  const links = [p.planConv && `<a href="${cv(p.planConv)}">${t('projects.planConv')}</a>`, p.integrateConv && `<a href="${cv(p.integrateConv)}">${t('projects.integration')}</a>`].filter(Boolean).join(' · ');
  return `<article class="pj-run${ACTIVE(p) ? '' : ' is-done'}"><div class="pj-runhead"><h3 dir="auto">${esc(p.name)}</h3><span class="pj-of">${p.tasks.length ? t('project.complete', { done: num(done), n: num(p.tasks.length) }) : esc(mstatus(p.status))}</span></div>`
    + (p.tasks.length ? `<div class="pj-rail" aria-hidden="true">${p.tasks.map((k) => `<i class="s-${SEG[k.status] || 'queued'}" title="${esc(k.title)}"></i>`).join('')}</div>` : '')
    + `<small class="pj-runmeta">${esc(mstatus(p.status))} · ${t('projects.owner', { seat: `<bdi>${esc(p.owner)}</bdi>` })} · ${t('projects.started', { when: when(p.createdAt) })}${p.status === 'planning' && p.waitUntil ? ' · ' + t('projects.waitsFor', { seat: `<bdi>${esc(p.owner)}</bdi>`, when: when(p.waitUntil) }) : ''}${links ? ' · ' + links : ''}</small>`
    + (cur && ACTIVE(p) ? `<p class="pj-now">${t('project.now', { task: tt(cur) })}</p>` : '')
    + `${p.error ? `<small class="pj-err">${esc(p.error)}</small>` : ''}${p.sendError ? `<small class="pj-err">${esc(p.sendError)}</small>` : ''}${acts ? `<div class="pj-acts">${acts}</div>` : ''}`
    + (p.tasks.length ? `<details class="pj-tasks" data-run="${esc(p.id)}"${projOpenRuns.has(p.id) ? ' open' : ''}><summary>${t('project.allTasks')}</summary><ol>${p.tasks.map(task).join('')}</ol></details>` : '') + `</article>`;
}
// ---- project context (#project/<dir>/c/<id>): a conversation opened from its project keeps a project bar on top (back, name, the project's live chats) ----
let projCtx = null, pctxData = null;
const projTag = (leaf) => new RegExp('^\\s*\\[' + [...leaf.replace(/[^\p{L}\p{N}]/gu, '')].join('[^\\p{L}\\p{N}]*') + '\\]\\s*', 'iu');   // "[MyApp] x" inside my-app shows as "x"
const ctxHash = () => { const m = location.hash.match(/^#project\/([^/]+)\/(?:c\/([^/]+)|new)$/); if (!m) return null; try { return { dir: decodeURIComponent(m[1]), id: m[2] || null }; } catch { return null; } };
function setCtx(dir, id) {
  projCtx = dir || null; document.body.classList.toggle('pctx', !!projCtx);
  const want = projCtx && `#project/${encodeURIComponent(projCtx)}/${id ? 'c/' + id : 'new'}`;
  if (want && location.hash !== want) history.replaceState(null, '', want);   // a new chat that just got its id: /new -> /c/<id>, no extra history step
  else if (!want && ctxHash()) history.replaceState(null, '', location.pathname + location.search);   // opened from the sidebar: the normal view
  if (projCtx && (pctxData?.dir !== projCtx || (id && !pctxData.d?.convs.some((c) => c.id === id)))) loadPctx();
  renderPbar(true);
}
const dropCtx = () => { projCtx = null; document.body.classList.remove('pctx'); renderPbar(); };
async function loadPctx() {
  const dir = projCtx; let r; try { r = await api('/api/project?dir=' + encodeURIComponent(dir)); } catch { r = null; }
  if (dir === projCtx) { pctxData = { dir, d: r && !r.error ? r : null }; renderPbar(); }
}
function newInProject(dir) {   // "New chat here": a fresh draft inside the project (cwd = its folder)
  const h = `#project/${encodeURIComponent(dir)}/new`;
  if (location.hash === h) openHash(); else location.hash = h;
}
function renderPbar(focusCur) {
  const bar = $('pbar'); if (!projCtx) { bar.hidden = true; bar.innerHTML = ''; return; }
  const d = pctxData?.dir === projCtx ? pctxData.d : null, base = `#project/${encodeURIComponent(projCtx)}`;
  const parts = (d?.name || projCtx.split(/[\\/]/).pop()).split(/[\\/]/), leaf = parts.pop(), tag = projTag(leaf), live = new Map(allConvs().map((c) => [c.id, c]));
  const ids = (d?.convs || []).map((c) => c.id); if (cur.id && !ids.includes(cur.id)) ids.unshift(cur.id);   // the open one is always there, even when archived
  const items = ids.map((id) => {
    const c = live.get(id) || d?.convs.find((k) => k.id === id); if (!c) return '';
    const need = c.pending || c.needsAnswer || c.need?.length, on = id === cur.id;
    return `<a class="pb-c${on ? ' on' : ''}${need ? ' need' : ''}" href="${base}/c/${esc(id)}"${on ? ' aria-current="page"' : ''}><span class="dot ${DOT[c.status] ?? c.status}"></span><span class="pb-t" dir="auto">${esc(c.title.replace(tag, '') || c.title)}</span>${need ? `<span class="pb-flag"><span class="pb-sr">${t('project.needs')}</span></span>` : ''}</a>`;
  }).join('');
  bar.hidden = false;
  bar.innerHTML = `<div class="pb-top"><a class="pb-back" href="${base}">${ico(ICO.back, 'fl')}<span>${t('project.backTo')}</span></a>`
    + `<a class="pb-name" href="${base}">${parts.length ? `<span dir="ltr">${esc(parts.join(' / '))} /</span>` : ''}<b dir="auto">${esc(leaf)}</b></a>`
    + `<button type="button" class="pb-new" data-pbnew>${t('projects.newChat')}</button>${cur.id ? `<button type="button" class="pb-mv" data-guide="pb-move" data-pbmove>${t('conv.moveProject')}</button>` : ''}</div>`
    + (items ? `<nav class="pb-sw" aria-label="${t('project.switcher')}">${items}</nav>` : '');
  if (focusCur) bar.querySelector('.pb-c.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}
$('pbar').onclick = (e) => { if (e.target.closest('[data-pbnew]')) newInProject(projCtx); if (e.target.closest('[data-pbmove]') && cur.id) openMove(cur.id); };
// ---- Project chip (a new chat only): the folder it opens in. Picked here, set by New chat here, or typed in the folder field; otherwise the
// server reads it from the first message (GET /api/detect-project = the rule send() uses) and falls back to the projects root. ----
let draftDir = null, detected = null, detTimer = null;
const relName = (dir) => (multiData.folders || []).find((f) => f.dir === dir)?.name || dir.split(/[\\/]/).pop();
function showChip() {
  const ch = $('projchip'), dir = $('cwd').value.trim(); ch.hidden = !!cur.id || !!seats.find((x) => x.name === cur.seat)?.remote;
  ch.textContent = dir ? t('composer.project', { name: relName(dir) }) : detected ? t('composer.projectDetected', { name: detected.name }) : t('composer.projectAuto');
}
function detectSoon() {
  clearTimeout(detTimer); if (cur.id) return;
  detTimer = setTimeout(async () => {
    const text = $('text').value.trim(), r = text ? await api('/api/detect-project?text=' + encodeURIComponent(text.slice(0, 2000))).catch(() => null) : null;
    detected = r?.dir ? r : null; showChip();
  }, 300);
}
$('text').addEventListener('input', detectSoon);
$('cwd').addEventListener('input', () => { draftDir = $('cwd').value.trim() || null; showChip(); });   // a typed folder survives a re-render like a picked one
$('projchip').onclick = () => openMove(null);
// ---- Move to project (⋯ menu, project bar): file a conversation under another project folder. Its working folder stays (the CLI keeps
// a session's history under its cwd); only where the Projects page and the project pages list it changes. Automatic = by its folder again. ----
let mvId = null;
function openMove(id) {
  mvId = id; const d = $('mvproj');   // id null: the project chip of a new chat
  d.innerHTML = `<form method="dialog"><h3>${t(id ? 'conv.moveTitle' : 'composer.pickTitle')}</h3><small>${t(id ? 'conv.moveHint' : 'composer.pickHint')}</small><input id="mvq" type="search" dir="auto" placeholder="${t('projects.filterPh')}" aria-label="${t('projects.filterPh')}" autocomplete="off" spellcheck="false"><div id="mvlist"></div><div class="racts"><button value="">${t('common.close')}</button></div></form>`;
  mvList(); d.showModal(); $('mvq').focus();
}
function mvList() {
  const c = mvId ? allConvs().find((x) => x.id === mvId) : { project: $('cwd').value.trim() || null }, q = $('mvq').value.trim().toLowerCase();
  const all = new Map([...(multiData.projects || []).map((p) => [p.dir, p.dir.split(/[\\/]/).pop()]), ...(multiData.folders || []).map((f) => [f.dir, f.name])]);   // run dirs and folders, one entry per dir (a folder's own name wins)
  const hits = [...all].filter(([dir, name]) => !q || (name + ' ' + dir).toLowerCase().includes(q)).slice(0, 40);
  const opt = (dir, label, on) => `<button type="button" class="mvopt" data-mvdir="${esc(dir)}"${on ? ' aria-current="true"' : ''}>${label}</button>`;
  $('mvlist').innerHTML = opt('', t(mvId ? 'conv.moveAuto' : 'composer.pickAuto'), !c?.project) + hits.map(([dir, name]) => opt(dir, `<bdi dir="ltr">${esc(name)}</bdi>`, c?.project === dir)).join('') + (hits.length ? '' : `<p class="smuted">${t('projects.noFolder')}</p>`);
}
$('mvproj').oninput = (e) => { if (e.target.id === 'mvq') mvList(); };
$('mvproj').onkeydown = (e) => { if (e.target.id === 'mvq' && e.key === 'Enter') e.preventDefault(); };   // Enter in the filter would submit the form = Close
$('mvproj').onclick = async (e) => {
  const o = e.target.closest('[data-mvdir]'); if (!o) return;
  const dir = o.dataset.mvdir || null;
  if (!mvId) { draftDir = dir; $('cwd').value = dir || ''; $('mvproj').close(); showChip(); return $('text').focus(); }
  const r = await api('/api/conv-project', { conversationId: mvId, dir });
  if (r.error) return alert(r.error);
  $('mvproj').close(); await loadMulti();
  if (projCtx && mvId === cur.id) { if (dir) location.hash = `#project/${encodeURIComponent(dir)}/c/${mvId}`; else loadPctx(); }   // moved from the project bar: follow it to its new project
};
// The head of HANDOFF.md as real text: headings, paragraphs, list items, **bold**, _em_, `code` (code spans are cut out first, so nothing inside them is formatted).
function pjMd(text) {
  const inl = (s) => s.split(/(`[^`\n]+`)/).map((x, i) => i % 2 ? `<code>${esc(x.slice(1, -1))}</code>` : esc(x).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|\s)_(.+?)_(?=[\s.,;:]|$)/g, '$1<em>$2</em>')).join('');
  const units = []; let para = null;   // units: { li } or { html }; consecutive list items share one <ul>
  for (const line of text.replace(/^#\s+handoff\s*\n/i, '').split('\n')) {   // the file's own "# HANDOFF" title repeats the section name
    const h = line.match(/^#{1,6}\s+(.*)$/), li = line.match(/^\s{0,3}[-*]\s+(.*)$/);
    if (!line.trim()) para = null;
    else if (h) { units.push({ html: `<h3>${inl(h[1])}</h3>` }); para = null; }
    else if (li) { para = { li: li[1] }; units.push(para); }
    else if (para) para[para.li !== undefined ? 'li' : 'p'] += ' ' + line.trim();   // a wrapped line continues its item or paragraph
    else { para = { p: line.trim() }; units.push(para); }
  }
  const html = (us) => us.map((u, i) => u.li !== undefined ? `${us[i - 1]?.li === undefined ? '<ul>' : ''}<li>${inl(u.li)}</li>${us[i + 1]?.li === undefined ? '</ul>' : ''}` : u.p !== undefined ? `<p>${inl(u.p)}</p>` : u.html).join('');
  let cut = 0, len = 0; while (cut < units.length && (cut < 2 || len < 900)) len += (units[cut++].li ?? units[cut - 1].p ?? '').length + 60;   // about 900 characters stay open
  return cut < units.length ? html(units.slice(0, cut)) + `<details class="pj-more"${projMoreOpen ? ' open' : ''}><summary>${t('project.more')}</summary>${html(units.slice(cut))}</details>` : html(units);   // a long head does not bury the commits under it
}
async function loadProject() {
  const dir = projDir; let r; try { r = await api('/api/project?dir=' + encodeURIComponent(dir)); } catch { r = { error: 'x' }; }
  if (dir === projDir) { projData = r; renderProject(); }
}
function openProject(dir) {
  dropCtx(); closeSettings(); closeGuide(); document.body.classList.add('projects'); document.body.classList.remove('drawer'); projDir = dir; projData = null; projFirst = true; projArchOpen = false; projMoreOpen = false; projOpenRuns = new Set(); renderProject(); showMultiSide(); loadProject();
}
function openProjects(id) {
  dropCtx(); projDir = null; closeSettings(); closeGuide(); document.body.classList.add('projects'); document.body.classList.remove('drawer'); showProjects(); showMultiSide();
  focusId = id || null; if (multiLoaded) flashCard();   // a direct link before the first load: the card is flashed once the data is in (loadMulti)
}
function flashCard() {
  const el = focusId && document.getElementById('multi-' + focusId); if (!el) return; focusId = null;
  el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1800);
}
function closeProjects() {
  if (!onProjects()) return; document.body.classList.remove('projects'); showMultiSide();
  projDir = null; if (location.hash === '#projects' || location.hash.startsWith('#multi-') || (location.hash.startsWith('#project/') && !ctxHash())) history.replaceState(null, '', location.pathname + location.search);   // the same project link works again
}
$('projbtn').onclick = () => { if (onProjects()) return closeProjects(); if (location.hash === '#projects') openProjects(); else location.hash = 'projects'; };   // second click: back to the conversation behind it
$('projects').addEventListener('toggle', (e) => {   // a refresh keeps Archived and "Show all tasks" as the user left them
  if (e.target.classList?.contains('pj-arch')) projArchOpen = e.target.open;
  else if (e.target.classList?.contains('pj-more')) projMoreOpen = e.target.open;
  else if (e.target.dataset?.run) projOpenRuns[e.target.open ? 'add' : 'delete'](e.target.dataset.run);
  else if (e.target.dataset?.fin) projFinOpen[e.target.open ? 'add' : 'delete'](e.target.dataset.fin);
  else if (e.target.classList?.contains('po-start')) startOpen = e.target.open;
  else if (e.target.classList?.contains('po-all')) allOpen = e.target.open;
}, true);
$('projects').oninput = (e) => { if (e.target.id === 'mfq') { folderQ = e.target.value; $('mfolders').innerHTML = folderList(); } };
$('projects').onclick = async (e) => {
  if (e.target.closest('[data-pclose]')) return closeProjects();
  if (e.target.closest('[data-mback]')) { if (location.hash === '#projects') openProjects(); else location.hash = 'projects'; return; }
  const mr = e.target.closest('[data-mrun]'); if (mr) { projPrefill = { dir: mr.dataset.mrun, name: mr.dataset.mname }; if (location.hash === '#projects') openProjects(); else location.hash = 'projects'; return; }
  if (e.target.closest('[data-pdrawer]')) return document.body.classList.add('drawer');
  const nc = e.target.closest('[data-mchat]'); if (nc) return newInProject(nc.dataset.mchat);
  const pin = e.target.closest('[data-pin]'), nr = e.target.closest('[data-notrel]');   // a related conversation: Pin = Move to project (this one); Not related = hidden here
  if (pin || nr) { const r = await api(pin ? '/api/conv-project' : '/api/not-related', { conversationId: (pin || nr).dataset[pin ? 'pin' : 'notrel'], dir: projDir }); if (r.error) return alert(r.error); return loadMulti(); }
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
  const mv = e.target.closest('[data-mvproj]'); if (mv) { menuFor = null; showSeats(); return openMove(mv.dataset.mvproj); }
  const ar = e.target.closest('[data-archive]'); if (ar) { menuFor = null; await api('/api/archive', { conversationId: ar.dataset.archive, archived: ar.dataset.to === 'true' }); return; }
  const de = e.target.closest('[data-del]');
  if (de) {
    menuFor = null; showSeats();
    if (!confirm(t('conv.confirmDelete'))) return;
    const r = await api('/api/delete', { conversationId: de.dataset.del }); if (r.error) alert(r.error); return;
  }
  // chevron: open the seat with its details / fold it; name: open the seat / fold it. Folding always closes the details, and the user's fold sticks (fold true).
  const dt = e.target.closest('[data-det]'), fo = !dt && e.target.closest('[data-fold]');
  if (dt || fo) { const n = (dt || fo).dataset[dt ? 'det' : 'fold']; if (folded(n)) { fold[n] = false; if (dt) det.add(n); } else { fold[n] = true; det.delete(n); } saveFold(); return showSeats(); }
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
    if (k.error) { $('log').appendChild(div('msg note err', esc(k.error))); $('text').value = text; caretEnd(); return; }
    cur.id = k.conversationId;
  }
  const r = await api('/api/send', { seat: cur.seat, conversationId: cur.id || undefined, text, cwd: run ? undefined : $('cwd').value.trim() || undefined, model: $('model').value || undefined, effort: EFFORTS[$('effort').value] || undefined, mode: $('mode').value, images: pending.filter((p) => !p.file).map((p) => p.id), files: pending.filter((p) => p.file).map((p) => p.id), draftId });
  if (r.error) { $('log').appendChild(div('msg note err', esc(r.error))); $('text').value = text; caretEnd(); return; }
  pending.length = 0; showThumbs(); draftId = newDraftId();
  if (run) { seats = await api('/api/seats'); await pick(cur.seat, cur.id, projCtx); }
  else if (!cur.id) { cur.id = r.conversationId; await pick(cur.seat, r.conversationId, projCtx); }   // a chat started inside a project stays there
};
// On a touch screen Enter only adds a line and Send sends: a phone keyboard's Enter would send half-written messages.
const TOUCH = matchMedia('(pointer: coarse)').matches;
if (TOUCH) { $('text').dataset.i18nPlaceholder = $('text').dataset.i18nAriaLabel = 'composer.placeholderTouch'; $('text').enterKeyHint = 'enter'; }
// The composer is a contenteditable <div> (Gboard can commit an image only into one) that behaves like the old textarea:
// plain text only (text nodes + <br> for line breaks; Chrome would make a <div> per line from a "\n"), and .value reads / writes that text, so every caller stays as it was.
const ED = $('text');
const edText = (n) => n.nodeType === 3 ? n.data : n.nodeName === 'BR' ? ((n === n.parentNode.lastChild && n.parentNode === ED) || (n.parentNode !== ED && n.parentNode.childNodes.length === 1) ? '' : '\n')   // the browser's placeholder <br> (at the very end, or alone in a stray empty-line block) is no extra line
  : (/^(DIV|P)$/.test(n.nodeName) && n !== ED && n.previousSibling ? '\n' : '') + [...n.childNodes].map(edText).join('');   // a stray block (should not happen) still reads as its own line
Object.defineProperty(ED, 'value', { get: () => edText(ED), set: (v) => { ED.textContent = v; } });
const caretEnd = () => { ED.focus(); const r = document.createRange(); r.selectNodeContents(ED); r.collapse(false); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); };
const insertPlain = (txt) => { (txt || '').replace(/\r\n?/g, '\n').split('\n').forEach((p, i) => { if (i) document.execCommand('insertLineBreak'); if (p) document.execCommand('insertText', false, p); }); };   // execCommand keeps Ctrl+Z working
ED.addEventListener('input', () => { if (!ED.textContent && ED.children.length) ED.textContent = ''; });   // emptied: drop the stray <br> so the placeholder shows again
// A new line inside a list continues it: "1. x" -> "2. ", "- x" -> "- "; Enter on an empty item ends the list. Otherwise a plain "\n".
function newLine() {
  const sel = getSelection(); if (!sel.rangeCount) return;
  const r = sel.getRangeAt(0), pre = document.createRange(); pre.selectNodeContents(ED); pre.setEnd(r.startContainer, r.startOffset);
  const before = edText(pre.cloneContents()), line = r.collapsed ? before.slice(before.lastIndexOf('\n') + 1) : '';
  const m = line.match(/^(\s*)(?:(\d+)([.)])|([-*•]))\s+(.*)$/);
  if (!m) return insertPlain('\n');
  const [, ind, num, dot, bullet, rest] = m;
  if (!rest.trim()) { for (let k = 0; k < line.length; k++) sel.modify('extend', 'backward', 'character'); document.execCommand('delete'); return; }   // empty item: drop the marker, stop the list
  insertPlain('\n' + ind + (num ? `${+num + 1}${dot} ` : `${bullet} `));
}
ED.onkeydown = (e) => {
  if (TOUCH || e.key !== 'Enter' || e.isComposing) return;   // phone keyboards: handled in beforeinput below
  e.preventDefault();
  if (!e.shiftKey) $('composer').requestSubmit(); else newLine();
};
// Android keyboards often report Enter as key "Unidentified" in keydown; beforeinput always names the line break.
// beforeinput also keeps the box plain: pasted / dropped rich text goes in as text, images (a keyboard's image commit too) go to the attachments.
ED.addEventListener('beforeinput', (e) => {
  const it = e.inputType;
  if ((it === 'insertLineBreak' || it === 'insertParagraph') && !e.isComposing) { e.preventDefault(); return newLine(); }
  if (it.startsWith('format')) return e.preventDefault();   // Ctrl+B / Ctrl+I: no formatting in a plain-text box
  if ((it === 'insertFromPaste' || it === 'insertFromDrop' || it === 'insertFromPasteAsQuotation') && e.dataTransfer) {
    e.preventDefault(); const fs = pastedImages(e.dataTransfer);
    if (fs.length && !$('attach').hidden) attach(fs); insertPlain(e.dataTransfer.getData('text/plain'));
  }
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
  if (location.hash === '#guide') return openGuide();
  closeGuide();
  if (location.hash === '#settings') return openSettings();
  closeSettings();
  const x = ctxHash();
  if (x) {   // #project/<dir>/c/<id> or #project/<dir>/new: a conversation inside its project
    if (!x.id) { pick(cur.seat, null, x.dir).then(() => { $('cwd').value = x.dir; $('text').focus(); }); return; }
    const c = allConvs().find((k) => k.id === x.id);
    if (!c) return openProject(x.dir);
    if (c.id !== cur.id) return pick(c.seat, c.id, x.dir);
    closeProjects(); return setCtx(x.dir, c.id);
  }
  if (location.hash.startsWith('#project/')) { let d = ''; try { d = decodeURIComponent(location.hash.slice(9)); } catch {} return openProject(d); }
  if (location.hash === '#projects' || location.hash.startsWith('#multi-')) return openProjects(location.hash.startsWith('#multi-') ? location.hash.slice(7) : null);
  const c = allConvs().find((x) => x.id === location.hash.slice(1));
  if (c && c.id !== cur.id) pick(c.seat, c.id); else if (c) closeProjects();   // the conversation already behind the page: just uncover it
}

// Hand a finished result to another seat: a NEW conversation there, text prefilled (not sent), folder copied from this one.
async function handoff(seat, result) {
  const c = curConv(); if (!c) return;
  await pick(seat, null);
  $('cwd').value = c.cwd; showChip();
  $('text').value = t('result.continuation', { seat: c.seat, title: c.title }) + `\n\n${result}\n\n`;
  caretEnd();
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
  box.innerHTML = pending.map((p, i) => `<span class="thumbwrap">${p.file ? `<span class="fchip" dir="ltr">📎 <bdi>${esc(p.name)}</bdi> · ${sizeText(p.size)}</span>` : `<img class="thumb" role="button" tabindex="0" data-edit="${i}" alt="${t('composer.attachedImage')}" aria-label="${t('imgedit.edit')}" title="${t('imgedit.edit')}" src="${p.url}">`}<button type="button" data-rm="${i}" aria-label="${t(p.file ? 'composer.removeFile' : 'composer.removeImage')}">×</button></span>`).join('');
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
    pending.push(r.file ? { id: r.id, file: true, name: r.name, size: r.size } : { id: r.id, url: URL.createObjectURL(f), name });
  }
  showThumbs();
}
$('attach').onclick = () => $('file').click();
// Phones: "Photo" opens the photo picker (recent screenshots first) through accept="image/*"; Attach keeps every file type.
$('photobtn').hidden = !TOUCH; $('photobtn').onclick = () => $('photo').click();
$('photo').onchange = () => { attach([...$('photo').files]); $('photo').value = ''; };
$('file').onchange = () => { attach([...$('file').files]); $('file').value = ''; };
$('thumbs').onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) { pending.splice(+b.dataset.rm, 1); showThumbs(); } else if (e.target.dataset.edit) editPending(+e.target.dataset.edit); };
$('thumbs').onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset.edit) { e.preventDefault(); editPending(+e.target.dataset.edit); } };
// The edited PNG goes through attach() like any file, then takes the old attachment's place.
let editing = false;   // a double tap on the thumbnail must not stack two editors
async function editPending(i) {
  if (editing) return; editing = true;
  try { await editOne(i); } finally { editing = false; }
}
async function editOne(i) {
  const p = pending[i], f = await editImage(p.url, p.name).catch((e) => { diag({ k: 'imgedit', ev: 'fail', m: String(e?.message || e).slice(0, 200) }); return null; }); if (!f) return;
  const n = pending.length; await attach([f]);
  const ok = pending.length > n; if (ok) { pending.splice(i, 1, pending.splice(n, 1)[0]); showThumbs(); }
  diag({ k: 'imgedit', ev: 'replaced', ok, size: f.size });
}
// Clipboard images (desktop screenshots; iOS/Android long-press Paste put the image in clipboardData.items, sometimes not in .files) get a
// paste-YYYYMMDD-HHMMSS.ext name instead of the browser's "image.png". Text goes in as plain text (insertPlain).
const imagesOf = (dt) => [...(dt?.files || [])].filter((f) => f.type.startsWith('image/'));
function pastedImages(dt) {
  let fs = imagesOf(dt);
  if (!fs.length) fs = [...(dt?.items || [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
  const d = new Date(), z = (n) => String(n).padStart(2, '0'), stamp = `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
  return fs.map((f, i) => new File([f], `paste-${stamp}${fs.length > 1 ? '-' + (i + 1) : ''}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/\+.*/, '')}`, { type: f.type }));
}
$('text').addEventListener('paste', (e) => { e.preventDefault(); const fs = pastedImages(e.clipboardData); if (fs.length) attach(fs); insertPlain(e.clipboardData?.getData('text/plain')); });   // images to the attachments, text as plain text (never the copied formatting)
// "Paste image": reads the clipboard directly, for keyboards that cannot paste an image into a web page. navigator.clipboard.read exists only in a
// secure context (https via tailscale serve, or 127.0.0.1); on the plain http Tailscale address a tap names the https address instead.
$('pasteimg').hidden = false;   // never hidden silently: on the plain http address a tap says where it works
$('pasteimg').onclick = async () => {
  if (!(isSecureContext && navigator.clipboard?.read)) { diag({ k: 'pasteimg', ok: false, why: 'insecure' }); return alert(t('composer.pasteImageHttps', { url: HTTPS_URL || 'https://' })); }
  let perm = 'n/a'; try { perm = (await navigator.permissions.query({ name: 'clipboard-read' })).state; } catch {}
  diag({ k: 'pasteimg', step: 'start', perm });   // logged before read(): a read that never settles still leaves a trace
  let items;
  try { items = await Promise.race([navigator.clipboard.read(), new Promise((_, no) => setTimeout(() => no(Object.assign(new Error('no answer in 20 s'), { name: 'Timeout' })), 20000))]); }
  catch (x) { diag({ k: 'pasteimg', ok: false, perm, err: x.name, msg: String(x.message).slice(0, 200) }); return alert(t(x.name === 'NotAllowedError' ? 'composer.pasteImageDenied' : x.name === 'Timeout' ? 'composer.pasteImageTimeout' : 'composer.pasteImageFailed')); }
  diag({ k: 'pasteimg', ok: true, perm, types: items.map((it) => it.types.join(',')) });
  const files = []; for (const it of items) { const ty = it.types.find((x) => x.startsWith('image/')); if (ty) files.push(new File([await it.getType(ty)], 'image', { type: ty })); }
  if (!files.length) return alert(t('composer.pasteImageNone'));
  attach(pastedImages({ files }));
};
// Drag and drop onto the composer: any file, same path as the Attach button. dragover must be cancelled or the browser opens the file instead.
const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
$('composer').addEventListener('dragover', (e) => { if (isFileDrag(e)) { e.preventDefault(); $('composer').classList.add('dropping'); } });
$('composer').addEventListener('dragleave', (e) => { if (!$('composer').contains(e.relatedTarget)) $('composer').classList.remove('dropping'); });
$('composer').addEventListener('drop', (e) => { if (!isFileDrag(e)) return; e.preventDefault(); $('composer').classList.remove('dropping'); if (!$('attach').hidden) attach([...e.dataTransfer.files]); });
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
const langRow = () => `<label class="snum" data-guide="set-lang"><span><b>${t('set.lang.title')}</b><small>${t('set.lang.hint')}</small></span><select data-set="language" data-str="1"><option value="">${t('set.lang.auto')}</option>`
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
    + `<h3>${t('set.usage.housekeeping')}</h3><label class="snum" data-guide="archive-days"><span><b>${t('set.usage.archive')}</b><small>${t('set.usage.archiveHint')}</small></span><input type="number" min="0" max="365" data-set="autoArchiveDays" value="${draft.autoArchiveDays}"> ${t('set.usage.days')}</label>`
    + `<label class="snum"><span><b>${t('set.usage.reap')}</b><small>${t('set.usage.reapHint')}</small></span><input type="number" min="1" max="1440" data-set="idleReapMinutes" value="${draft.idleReapMinutes}"> ${t('set.usage.min')}</label>`
    + `<label class="snum" data-guide="archive-done"><span><b>${t('set.usage.archiveDone')}</b><small>${t('set.usage.archiveDoneHint')}</small></span><input type="number" min="0" max="10080" data-set="autoArchiveDoneMin" value="${draft.autoArchiveDoneMin}"> ${t('set.usage.min')}</label>`,
  projects: () => {
    const d = setData.disciplines || { owner: setData.detected.seats[0]?.name, disciplines: {} };
    return `<h3>${t('set.proj.title')}</h3>` + tog('multiProjects', t('set.proj.page'), t('set.proj.pageHint'))
      + `<label class="snum" data-guide="set-fresh"><span><b>${t('set.proj.fresh')}</b><small>${t('set.proj.freshHint')}</small></span><input type="number" min="0" max="95" data-set="projectsFreshAtPct" value="${draft.projectsFreshAtPct ?? 40}"> %</label>`
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
    + `<nav class="stabs" role="tablist">${STABS.map((k) => `<button type="button" role="tab" data-guide="tab-${k}" data-stab="${k}" aria-selected="${k === setTab}">${t('set.tab.' + k)}</button>`).join('')}</nav>`
    + `<div class="spanel">${setNote && setNote.tab === setTab ? `<p class="snote ${setNote.err ? 'err' : ''}">${setNote.html}</p>` : ''}${TABS[setTab]()}</div>`
    + `<div class="ssave"${setData.firstRun || dirty() ? '' : ' hidden'}><span>${t(setData.firstRun ? 'set.nothingSaved' : 'set.unsaved')}</span><button type="button" data-ssave class="primary">${t('common.save')}</button></div>`;
  box.scrollTop = y;
  const tab = box.querySelector('.stabs [aria-selected=true]'), nav = tab.parentElement;   // phone: the open tab stays in view in the scrolling tab row (RTL: scrollLeft runs negative)
  const tr = tab.getBoundingClientRect(), nr = nav.getBoundingClientRect();   // screen coordinates: the same arithmetic for both directions
  if (tr.left < nr.left) nav.scrollLeft += tr.left - nr.left - 24; else if (tr.right > nr.right) nav.scrollLeft += tr.right - nr.right + 24;
}
async function openSettings(tab) {
  closeGuide(); document.body.classList.add('settings'); document.body.classList.remove('drawer', 'projects');
  if (tab) { setTab = tab; setNote = null; }
  if (!setData) await loadSettings(); showSettings();
}
function closeSettings() {
  if (!onSettings()) return; document.body.classList.remove('settings');
  if (location.hash === '#settings') history.replaceState(null, '', location.pathname + location.search);
}
$('setbtn').onclick = () => { if (onSettings()) return closeSettings(); if (location.hash === '#settings') openSettings(); else location.hash = 'settings'; };
// ---- Guide (#guide): how to use the console, one short answer per task. Button names are filled in from the page's own keys,
// so the guide always names a button exactly as the page shows it, in every language. ----
const GUIDE = ['seats', 'start', 'folder', 'attach', 'approve', 'keep', 'auto', 'search', 'projects', 'runs', 'project', 'ctx', 'settings'];
const onGuide = () => document.body.classList.contains('guide');
function showGuide() {
  const b = (k, v) => `<b>${t(k, v)}</b>`;
  const names = { settings: b('set.title'), foldAll: b('side.all'), use: b('usage.use'), new: b('side.new'), auto: b('mode.auto'), ask: b('mode.ask'), bypass: b('mode.bypass'), effort: b('composer.effort'), chip: b('composer.projectAuto'),
    attach: b('composer.attach'), stop: b('composer.stop'), allow: b('perm.allow'), deny: b('perm.deny'), needsApproval: b('status.waiting'), needsAnswer: b('conv.needsAnswer'), closeQuestion: b('conv.closeQuestion'),
    keep: b('conv.keep'), archive: b('conv.archive'), showArchived: b('side.showArchived', { n: '…' }), move: b('conv.moveProject'), tabUsage: b('set.tab.usage'), archiveDone: b('set.usage.archiveDone'), archiveDays: b('set.usage.archive'),
    openProjects: b('projects.open'), openProject: b('projects.openProject'), newChat: b('projects.newChat'), allFolders: b('projects.allFolders', { n: '…' }), startRun: b('projects.startRun'), plan: b('projects.plan'), approve: b('projects.approve'),
    needs: b('project.needs'), allClear: b('project.allClear'), working: b('project.working'), runs: b('project.runs'), allTasks: b('project.allTasks'), happening: b('project.happening'), backTo: b('project.backTo'), opened: b('project.opened'), related: b('project.related'), pin: b('project.pin'), notRelated: b('project.notRelated'),
    tabStart: b('set.tab.start'), lang: b('set.lang.title'), tabProjects: b('set.tab.projects'), freshAt: b('set.proj.fresh'), save: b('common.save') };
  $('guide').innerHTML = `<header class="phead shead"><button type="button" class="smenu" data-gdrawer aria-label="${t('side.seats')}">☰</button><div><h2>${t('guide.title')}</h2><small>${t('guide.subtitle')}</small></div><button type="button" data-gclose>${t('common.close')}</button></header>`
    + `<div class="gd"><p class="gd-full"><button type="button" class="primary" data-gtour="full">${t('tour.full')}</button></p>${GUIDE.map((k) => `<section class="gd-s"><h3>${t(`guide.${k}.h`)}</h3><p>${t(`guide.${k}.p`, names)}</p><button type="button" class="gd-show" data-gtour="${k}">${t('tour.show')}</button></section>`).join('')}<p class="gd-build">${t('guide.build', { id: `<code dir="ltr">${esc(BUILD)}</code>` })}</p></div>`;   // which code this page runs (the phone app too)
}
function openGuide() {
  closeSettings(); closeProjects(); document.body.classList.add('guide'); document.body.classList.remove('drawer');
  showGuide(); $('guide').scrollTop = 0;
}
function closeGuide() {
  if (!onGuide()) return; document.body.classList.remove('guide');
  if (location.hash === '#guide') history.replaceState(null, '', location.pathname + location.search);
}
$('guidebtn').onclick = () => { if (onGuide()) return closeGuide(); if (location.hash === '#guide') openGuide(); else location.hash = 'guide'; };
// Rail buttons show what is open: every page switch toggles a body class, so one observer covers all the ways in and out (button, hash, Close, tour).
const railState = () => { $('projbtn').setAttribute('aria-pressed', String(onProjects())); $('setbtn').setAttribute('aria-pressed', String(onSettings())); $('guidebtn').setAttribute('aria-pressed', String(onGuide())); };
new MutationObserver(railState).observe(document.body, { attributes: true, attributeFilter: ['class'] }); railState();
$('guide').onclick = (e) => { const g = e.target.closest('[data-gtour]'); if (g) return startTour(g.dataset.gtour); if (e.target.closest('[data-gclose]')) return closeGuide(); if (e.target.closest('[data-gdrawer]')) document.body.classList.add('drawer'); };
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
$('foldall').onclick = () => { const to = $('foldall').dataset.to === 'true'; for (const s of seats) fold[s.name] = to; saveFold(); if (to) det.clear(); showSeats(); if (to) $('sidescroll').scrollTo({ top: 0 }); };
$('avs').onclick = (e) => {   // a toggle: an open seat folds back, a folded one opens (railGo)
  const b = e.target.closest('[data-rail]'); if (!b) return; const n = b.dataset.rail;
  if (folded(n)) return railGo(n);
  fold[n] = true; det.delete(n); saveFold(); showSeats();
};

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
// The search field opens over the panel's title row (rail button). One click on its x, or Esc: query gone, field closed, the normal list back.
const clearSearch = () => { clearTimeout(qTimer); $('q').value = ''; runSearch(); $('sidetop').classList.remove('searching'); $('qbtn').setAttribute('aria-pressed', 'false'); };
const openSearch = () => { $('sidetop').classList.add('searching'); $('qbtn').setAttribute('aria-pressed', 'true'); $('q').focus(); };
$('qbtn').onclick = () => { if ($('sidetop').classList.contains('searching')) { clearSearch(); $('qbtn').focus(); } else openSearch(); };
$('q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(runSearch, 250); });
$('q').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); clearSearch(); $('qbtn').focus(); } });
$('qclear').onclick = () => { clearSearch(); $('qbtn').focus(); };
// The sidebar's top block stays put; a hairline under it only once the list has scrolled beneath it.
$('sidescroll').addEventListener('scroll', (e) => $('sidetop').classList.toggle('stuck', e.currentTarget.scrollTop > 0), { passive: true });
$('results').onclick = (e) => { const b = e.target.closest('[data-id]'); if (b) pick(b.dataset.seat, b.dataset.id); };

// ---- Optional diagnostics, OFF by default (DIAG_UNTIL = 0; no phone telemetry unless you opt in): what the composer really receives, sent to /api/client-log (server: clientLog).
// Types and counts only, never message text. Active only while Date.now() < DIAG_UNTIL: set DIAG_UNTIL = Date.parse('<end date>') to debug an image-paste problem on a phone. Delete this block when done. ----
const DIAG_UNTIL = 0, diagQ = []; let diagT = 0;
function diag(e) {
  if (Date.now() > DIAG_UNTIL) return;
  diagQ.push({ t: Date.now(), build: BUILD, ...e }); clearTimeout(diagT);
  diagT = setTimeout(() => { const events = diagQ.splice(0); fetch('/api/client-log', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Seat-Token': TOKEN }, body: JSON.stringify({ events }) }).catch(() => {}); }, 800);
}
$('reloadbtn').onclick = () => location.reload();
const dtInfo = (dt) => !dt ? null : { types: [...(dt.types || [])], files: [...(dt.files || [])].map((f) => f.type || '?'), items: [...(dt.items || [])].map((i) => i.kind + ':' + i.type) };
diag({ k: 'load', origin: location.origin, secure: isSecureContext, standalone: matchMedia('(display-mode: standalone)').matches, ua: navigator.userAgent, clipboardRead: !!navigator.clipboard?.read, composer: ED.tagName + '/' + ED.contentEditable, touch: TOUCH });
// capture phase on the form: logged before the composer's own handlers cancel or change anything
$('composer').addEventListener('paste', (e) => e.target === ED && diag({ k: 'paste', dt: dtInfo(e.clipboardData) }), true);
$('composer').addEventListener('beforeinput', (e) => e.target === ED && (!TYPING.test(e.inputType) || e.dataTransfer) && diag({ k: 'beforeinput', it: e.inputType, composing: e.isComposing, cancelable: e.cancelable, dlen: e.data?.length ?? null, dt: dtInfo(e.dataTransfer) }), true);
const TYPING = /^(insertText|insertCompositionText|deleteContentBackward|deleteContentForward|deleteCompositionText|insertLineBreak|insertParagraph)$/;   // ordinary typing is not logged, only what could carry an image
$('composer').addEventListener('input', (e) => e.target === ED && !TYPING.test(e.inputType) && diag({ k: 'input', it: e.inputType, dlen: e.data?.length ?? null }), true);
$('composer').addEventListener('drop', (e) => diag({ k: 'drop', dt: dtInfo(e.dataTransfer) }), true);
