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
// Mixed right-to-left + left-to-right text: dir="auto" takes the FIRST strong letter, so "Acme: <a Hebrew sentence>" laid out
// left-to-right and the sentence came out scrambled. The direction goes by which script has more words; a tie stays "auto".
const dirOf = (s) => { let r = 0, l = 0; for (const w of String(s).split(/\s+/)) { const a = (w.match(/[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/g) || []).length, b = (w.match(/[A-Za-z\u00c0-\u024f\u0400-\u04ff]/g) || []).length; if (a > b) r++; else if (b > a) l++; } return r > l ? 'rtl' : l > r ? 'ltr' : 'auto'; };   // counted in words: an e-mail address or URL is one word, not 20 letters
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
const headBadge = (c) => `<span class="badge ${c.mode}">${esc(tk('mode.', c.mode))}</span>`;
// Stop shows only while a turn runs (working / waiting on an approval): idle it only took room on the phone.
const stopUi = (c) => { $('stop').hidden = !['working', 'waiting'].includes(c?.status); };
// Second header line on a phone (hidden on a wide screen, where the seat · e-mail line already says it): seat chip, project, status.
const headMeta = (c, s) => {
  const dir = c?.project || c?.cwd, proj = dir ? dir.split(/[\\/]/).filter(Boolean).pop() : '', need = c && (c.pending || c.needsAnswer);
  return `<span class="hseat" title="${esc(s.name)}"><span class="nini ${PROV[s.agent] ? 'prov' : ''}" aria-hidden="true">${esc(initials(s.name))}</span><bdi>${esc(s.name)}</bdi></span>`
    + (proj ? `<a class="hproj" href="#project/${encodeURIComponent(dir)}"><bdi>${esc(proj)}</bdi></a>` : '')
    + (c ? `<span class="hst${need ? ' need' : ''}"><span class="dot ${need ? 'waiting' : DOT[c.status] ?? c.status}"></span>${need ? t('project.needs') : esc(label(c.status))}</span>` : '');
};

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
  else if (ev.type === 'console_note') out.push(div('msg note ahnote', `🧭 ${t(ev.key, { pct: ev.pct ?? '', file: `<bdi dir="ltr">${esc(ev.file || '')}</bdi>` })}${ev.link ? ` <a href="#" data-ahgo="${esc(ev.link.id)}" data-seat="${esc(ev.link.seat)}"><bdi>${esc(ev.link.title || ev.link.id.slice(0, 8))}</bdi></a>` : ''}`));   // auto handoff (server ahContinue): link to the successor / predecessor
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
  $('head').innerHTML = `<button id="menu" aria-label="${t('side.seats')}">☰</button><span id="htitle" dir="${c ? dirOf(c.title) : 'auto'}" ${c ? `title="${t('conv.renameHint')}"` : ''}>${c ? esc(c.title) : t('conv.newTitle', { seat: `<bdi>${esc(s.name)}</bdi>` })}</span>`
    + (c ? `<button type="button" id="renamebtn" aria-label="${t('conv.rename')}">✎</button>` : '')
    + `<small dir="ltr">${esc(s.name)} · ${esc(s.email)}</small>` + `<span id="hrow2"><span id="hmeta">${headMeta(c, s)}</span>` + (c ? `<span id="hbadge">${headBadge(c)}</span>` : '') + ctxBtnHtml(c) + '</span>'
    + `<button type="button" id="toolsbtn" aria-pressed="${showTools}" aria-label="${t('conv.showActions')}" title="${t('conv.showActions')}"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>`;
  closeCtx();
  $('cwd').value = c ? c.cwd : projCtx || draftDir || '';   // a new chat: the project it was started in or picked on the chip; empty = the server decides (send())
  if (!c) detectSoon(); showChip();
  // An existing conversation's model and effort come from the conversation: left on whatever the last one used, the next message would silently restart it with those.
  setModels(s, c).then(optSum);   // an agent seat (Codex, Antigravity) shows ITS models; a Claude seat the Claude list
  if (c) { $('effort').value = Math.max(0, EFFORTS.indexOf(c.effort || '')); $('effortOut').textContent = c.effort || t('composer.effortDefault'); }
  if (c) $('mode').value = c.mode || 'auto';   // a remote run has no mode; changeable on an existing conversation too: the next message restarts it in the new mode (server send())
  $('banner').hidden = !(c && (c.status === 'interrupted' || c.status === 'stopped'));
  stopUi(c);
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
  return `<button type="button" id="ctxbtn" class="cx-${x.level || 'none'}" aria-haspopup="dialog" aria-expanded="${!$('ctxpanel').hidden}" title="${esc(t('ctx.title') + ': ' + ctxText(x))}"><span class="cxbar"><i style="width:${Math.min(100, x.pct || 0)}%"></i></span><span class="cxfull">${x.compacting ? t('ctx.compacting') : ctxText(x)}</span>${x.window && !x.compacting ? `<span class="cxshort">${pct(x.pct / 100)}</span>` : ''}</button>`;
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
  if (old) old.outerHTML = ctxBtnHtml(c); else ($('hrow2') || $('head')).insertAdjacentHTML('beforeend', ctxBtnHtml(c));
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
      <span class="dot ${DOT[c.status] ?? c.status}"></span><span class="t" dir="${dirOf(c.title)}">${c.keep ? `<span class="kept" title="${t('conv.keptTitle')}">★</span> ` : ''}${esc(c.title)}</span>${c.ctx?.pct != null ? `<span class="cxpct cx-${c.ctx.level}" title="${t('ctx.title')} ${esc(ctxText(c.ctx))}">${pct(c.ctx.pct / 100)}</span>` : ''}
      <small><span class="cost" dir="ltr" title="${t('conv.costTitle')}">~${usd(c.cost || 0)}</span> ${c.mode === 'bypass' ? `<span class="badge bypass">${t('mode.bypass')}</span> ` : ''}${esc(label(c.status))}${c.background ? ' · <bdi>' + esc(c.background) + '</bdi>' : ''}${c.pending ? ' · ' + t('conv.waitingN', { n: num(c.pending) }) : ''}</small>${c.quotaWait ? `<span class="qwait" title="${t('conv.qwaitTitle')}">⏸ ${t('conv.resumesAt', { time: clock(c.quotaWait) })}<span class="dismiss" data-unwait="${c.id}" role="button" title="${t('conv.unwait')}">✕</span></span>` : ''}${c.needsAnswer ? `<span class="needs">❓ ${t('conv.needsAnswer')}<span class="dismiss" data-dismiss="${c.id}" role="button" title="${t('conv.dismissTitle')}">✕</span></span>` : ''}${c.unknownActions ? `<span class="unk" title="${t('conv.unknownTitle')}">⚠️ ${t('conv.unknownActions', { n: num(c.unknownActions) })}</span>` : ''}</button>
      ${c.remote ? '' : `<button class="more" data-more="${c.id}" aria-expanded="${menuFor === c.id}" aria-label="${t('conv.menu')}">⋯</button>`}</div>`
  + (menuFor === c.id ? `<div class="cmenu" data-guide="convmenu"><button data-rename="${c.id}" data-seat="${seat}">${t('conv.renameShort')}</button>${c.needsAnswer ? `<button data-dismiss="${c.id}">${t('conv.closeQuestion')}</button>` : ''}<button data-guide="keep" data-keep="${c.id}" data-to="${!c.keep}" title="${t(c.keep ? 'conv.unkeepTitle' : 'conv.keepTitle')}">${t(c.keep ? 'conv.unkeep' : 'conv.keep')}</button><button data-noah="${c.id}" data-to="${!c.noAutoHandoff}" title="${t('conv.noAutoHandoffTitle')}">${t(c.noAutoHandoff ? 'conv.autoHandoffOn' : 'conv.noAutoHandoff')}</button><button data-mvproj="${c.id}">${t('conv.moveProject')}</button><button data-guide="archive" data-archive="${c.id}" data-to="${!c.archived}">${t(c.archived ? 'conv.unarchive' : 'conv.archive')}</button><button class="danger" data-del="${c.id}">${t('common.delete')}</button></div>` : '');

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
  // A second, inner ring for the weekly window, and a small countdown chip to the weekly reset ("2d", "9h"); only when the account reports it.
  const wk = s.usage?.windows?.seven_day, wkOn = wk && wk.resetsAt * 1000 > Date.now(), wv = wkOn ? Math.min(100, Math.round(wk.utilization * 100)) : 0, wcol = wv >= 85 ? '#f2766d' : '#7fb3e0';
  const inner = !wkOn ? '' : `<circle class="wtrk" cx="18" cy="18" r="11.5" pathLength="100"/>${wv ? `<circle cx="18" cy="18" r="11.5" pathLength="100" fill="none" stroke="${wcol}" stroke-dasharray="${wv} 100"/>` : ''}`;
  const ring = `<svg class="ring" viewBox="0 0 36 36" aria-hidden="true">${shape('class="trk"')}${v ? shape(`fill="none" stroke="${col}" stroke-dasharray="${v} 100"`) : ''}${inner}</svg>`;
  const left = wkOn ? wk.resetsAt * 1000 - Date.now() : 0, wdays = Math.floor(left / 864e5);
  const wchip = !wkOn ? '' : `<span class="wreset ${wv >= 85 ? 'hot' : ''}" aria-hidden="true">${wdays >= 1 ? num(wdays, { style: 'unit', unit: 'day', unitDisplay: 'narrow' }) : num(Math.max(1, Math.ceil(left / 36e5)), { style: 'unit', unit: 'hour', unitDisplay: 'narrow' })}</span>`;
  // and the same for the 5 h window: chip top-start, "3h" / "40m" to its reset
  const fw = s.usage?.windows?.five_hour, fleft = fw ? fw.resetsAt * 1000 - Date.now() : 0;
  const fchip = fleft <= 0 ? '' : `<span class="hreset ${v >= 85 ? 'hot' : ''}" aria-hidden="true">${fleft >= 36e5 ? num(Math.floor(fleft / 36e5), { style: 'unit', unit: 'hour', unitDisplay: 'narrow' }) : num(Math.max(1, Math.ceil(fleft / 6e4)), { style: 'unit', unit: 'minute', unitDisplay: 'narrow' })}</span>`;
  const tip = s.name + (u != null ? ` · ${tk('usage.window.', 'five_hour')} ${pct(u)}${fleft > 0 ? ', ' + resetText(fw.resetsAt * 1000) : ''}` : '') + (wkOn ? ` · ${tk('usage.window.', 'seven_day')} ${pct(wk.utilization)}, ${resetText(wk.resetsAt * 1000)}` : '') + (n ? ' · ' + t('projects.needYou', { n: num(n) }) : '');
  return `<button type="button" class="av ${p ? 'prov' : ''} ${s.remote ? 'remote' : ''}" data-rail="${esc(s.name)}" aria-current="${s.name === cur.seat}" aria-expanded="${!folded(s.name)}" title="${esc(tip)}" aria-label="${esc(t('side.goSeat', { seat: s.name }) + (n ? ', ' + t('projects.needYou', { n: num(n) }) : ''))}">${ring}<span class="ini">${esc(initials(s.name))}</span>${fchip}${wchip}${p ? `<span class="pmark" aria-hidden="true">${p.mark}</span>` : ''}${n ? `<span class="badge">${num(n)}</span>` : ''}</button>`;
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
    return `<button type="button" class="nrow" data-nid="${esc(c.id)}" data-nseat="${esc(c.seat)}"><span class="nini ${PROV[s?.agent] ? 'prov' : ''}" title="${esc(c.seat)}">${esc(initials(c.seat))}</span><span class="nt" dir="${dirOf(c.title)}">${esc(c.title)}</span><small class="nage">${tm(c.updatedAt)}</small><small><b>${esc(why)}</b>${proj ? ` · <bdi>${esc(proj)}</bdi>` : ''}</small></button>`;
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
  ideaDraft = null;   // any switch (another chat, another new draft): only the draft ideaStartChat set up right after this pick is linked to its idea
  cur = { seat, id }; localStorage.setItem('seat', seat); if (id && fold[seat] === undefined) { fold[seat] = false; saveFold(); } closeProjects(); closeSettings(); closeGuide(); closeTodos(); closeIdeas(); draftDir = null; if (ctx !== false) setCtx(ctx, id);   // false (first paint): leave the address alone, openHash reads it next; an opened conversation unfolds its seat unless the user folded that seat himself (fold true)
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
  if ((text || files.some((f) => /^(image|audio)\//.test(f.type))) && confirm(t('ideas.shareAsk'))) return ideaFromShare(text, files);   // Ideas inbox: OK = save as an idea, Cancel = the new chat below
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
  loadSnippets();
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
  if (d.update) { showUpdate(d.update); return; }   // updatecheck.mjs: the server found (or lost) a newer version on GitHub
  if ('saveError' in d) { $('saveBanner').hidden = !d.saveError; return; }   // the server cannot write state.json: shown until a save works again
  if (d.removed) {
    for (const s of seats) s.conversations = s.conversations.filter((c) => c.id !== d.removed);
    delete convo[d.removed]; scheduleSeats();
    if (cur.id === d.removed) pick(cur.seat, null);
    return;
  }
  if (d.multi) { loadMulti(); return; }
  if (d.todos) { loadTodos(); return; }
  if (d.ideas) { loadIdeas(); return; }
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
    if (d.conv.id === cur.id) { refreshCtx(); $('banner').hidden = !(d.conv.status === 'interrupted' || d.conv.status === 'stopped'); stopUi(d.conv); const hb = $('hbadge'); if (hb) hb.innerHTML = headBadge(d.conv); const hm = $('hmeta'); if (hm) hm.innerHTML = headMeta(d.conv, s); showMarks(); const h = $('htitle'); if (h && !h.isContentEditable) h.textContent = d.conv.title; }
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
    + `<span class="po-counts">${counts}</span><span class="po-acts"><button type="button" data-mchat="${esc(x.dir)}">${t('projects.newChat')}</button><a class="mopen" data-guide="open-project" href="#project/${encodeURIComponent(x.dir)}">${t('projects.openProject')}</a></span></div>`
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
  dropCtx(); closeSettings(); closeGuide(); closeTodos(); closeIdeas(); closeDesktop(); document.body.classList.add('projects'); document.body.classList.remove('drawer'); projDir = dir; projData = null; projFirst = true; projArchOpen = false; projMoreOpen = false; projOpenRuns = new Set(); renderProject(); showMultiSide(); loadProject();
}
function openProjects(id) {
  dropCtx(); projDir = null; closeSettings(); closeGuide(); closeTodos(); closeIdeas(); closeDesktop(); document.body.classList.add('projects'); document.body.classList.remove('drawer'); showProjects(); showMultiSide();
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
  const nh = e.target.closest('[data-noah]'); if (nh) { menuFor = null; const r = await api('/api/noautohandoff', { conversationId: nh.dataset.noah, off: nh.dataset.to === 'true' }); if (r.error) alert(r.error); return; }
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
  const ag = e.target.closest('a[data-ahgo]'); if (ag) { e.preventDefault(); return pick(ag.dataset.seat, ag.dataset.ahgo); }
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
  else if (!cur.id) { if (ideaDraft?.seat === cur.seat) { api('/api/idea', { id: ideaDraft.id, action: 'start', chat: r.conversationId }).then(loadIdeas); ideaDraft = null; } cur.id = r.conversationId; await pick(cur.seat, r.conversationId, projCtx); }   // a chat started inside a project stays there; one started from an idea is linked to it
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
// ---- "/" skills and "@" snippets (server: slash.mjs) ----
// "/" or "@" typed at a line start or after a space opens one list at the caret; the letters after it filter (name first, then description).
// A skill goes in as "/name " (a token on screen, plain text underneath): claude runs "/name args" itself (measured), so nothing is rewritten.
// A snippet is replaced by its full text, editable before sending. A query nothing matches closes the list, so paths and e-mail addresses type as usual.
const POP = $('slashpop'), SRC_KEY = { seat: 'slash.src.seat', shared: 'slash.src.shared', plugin: 'slash.src.plugin', project: 'slash.src.project', builtin: 'slash.src.builtin' };
let pop = null, popMute = false, snippets = [], snipDraft = null;   // pop: { kind, q, all, list, sel, none }; snipDraft: Settings rows a failed save keeps
const skillCache = {};   // seat|chat|folder -> { at, r }: one fetch a minute at most
const loadSnippets = () => api('/api/snippets').then((r) => { snippets = r.snippets || []; }).catch(() => {});
async function popSource(kind) {
  if (kind === '@') return { all: snippets.filter((s) => !s.seats?.length || s.seats.includes(cur.seat)) };
  const key = `${cur.seat}|${cur.id || ''}|${$('cwd').value}`, hit = skillCache[key];
  if (hit && Date.now() - hit.at < 60000) return hit.r;   // a promise: letters typed while the first fetch runs wait for that one
  const r = api(`/api/skills?seat=${encodeURIComponent(cur.seat)}&conv=${encodeURIComponent(cur.id || '')}&cwd=${encodeURIComponent($('cwd').value)}`).catch(() => { delete skillCache[key]; return { skills: [] }; }).then((j) => ({ all: j.skills || [], none: j.none }));   // a failed fetch is tried again on the next letter
  skillCache[key] = { at: Date.now(), r }; return r;
}
function popToken() {   // the "/xx" or "@xx" right before the caret, or null
  const sel = getSelection(); if (!sel.rangeCount || !sel.isCollapsed || !ED.contains(sel.anchorNode)) return null;
  const pre = document.createRange(); pre.selectNodeContents(ED); pre.setEnd(sel.anchorNode, sel.anchorOffset);
  const m = /(^|\s)([/@])([^\s/@]{0,40})$/.exec(edText(pre.cloneContents()));
  return m && { kind: m[2], q: m[3].toLowerCase() };
}
const subseq = (q, s) => { let i = 0; for (const ch of s) if (ch === q[i]) i++; return i === q.length; };
function popRank(all, q, kind) {   // 0 name starts with it, 1 name holds it, 2 its letters in order, 3 the description / label / text holds it
  const score = (x) => { const n = x.name.toLowerCase(), d = (kind === '@' ? `${x.label || ''} ${x.text}` : x.description || '').toLowerCase();
    return !q || n.startsWith(q) ? 0 : n.includes(q) ? 1 : subseq(q, n) ? 2 : d.includes(q) ? 3 : 9; };
  return all.map((x) => [score(x), x]).filter(([s]) => s < 9).sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).slice(0, 60).map(([, x]) => x);
}
async function popUpdate() {
  if (popMute) return;   // popChoose's own edits
  if (mic) return popClose();   // live dictation types into the box: never a list under it
  const tk = popToken(); if (!tk) return popClose();
  const src = await popSource(tk.kind), now = popToken();
  if (!now || now.kind !== tk.kind || now.q !== tk.q) return;   // typed on while the list loaded: that input's own update draws it
  const list = popRank(src.all, tk.q, tk.kind);
  const msg = !tk.q && (src.none || (tk.kind === '@' && !src.all.length));   // a bare "/" on Codex / a remote, a bare "@" with no snippets yet: one line saying so
  if (!list.length && !msg) return popClose();
  pop = { kind: tk.kind, q: tk.q, list, sel: 0, none: src.none };
  popDraw();
}
const PROV_NAME = { codex: 'Codex', agy: 'Antigravity' };
function popDraw() {
  const { kind, list, none } = pop;
  POP.setAttribute('aria-label', t(kind === '@' ? 'slash.listSnippets' : 'slash.listSkills'));
  POP.innerHTML = list.length ? list.map((x, i) => `<div role="option" class="sp-row" id="sp-${i}" data-i="${i}" aria-selected="${i === pop.sel}">`
      + (kind === '@' ? `<b dir="ltr">@${esc(x.name)}</b>${x.label ? `<span class="sp-lab" dir="auto">${esc(x.label)}</span>` : ''}<small dir="auto">${esc(x.text.split('\n').find((l) => l.trim()) || '')}</small>`
        : `<b dir="ltr">/${esc(x.name)}</b><span class="sp-src">${t(SRC_KEY[x.source] || 'slash.src.shared')}</span><small dir="auto">${esc(x.key ? t(x.key) : x.description || '')}</small>`) + '</div>').join('')
    : `<p class="sp-none">${kind === '@' ? t('slash.noSnippets') : none === 'remote' ? t('slash.noneRemote') : t('slash.noneAgent', { agent: PROV_NAME[none] || none })}</p>`;
  POP.hidden = false; ED.setAttribute('aria-expanded', 'true'); ED.setAttribute('aria-activedescendant', list.length ? 'sp-' + pop.sel : '');
  popPlace(); POP.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' });
}
function popPlace() {   // above the caret (on a phone that is above the keyboard too), never past the screen's edges; RTL opens toward the left
  const sel = getSelection(); let r = sel.rangeCount ? sel.getRangeAt(0).getClientRects()[0] : null;
  if (!r || (!r.top && !r.height)) r = ED.getBoundingClientRect();   // a collapsed caret at a line start can report an empty rect
  const w = Math.min(440, innerWidth - 16), rtl = getComputedStyle(ED).direction === 'rtl';
  POP.style.width = w + 'px';
  POP.style.left = Math.max(8, Math.min((rtl ? r.right - w : r.left), innerWidth - w - 8)) + 'px';
  POP.style.bottom = (innerHeight - r.top + 6) + 'px';
  POP.style.maxHeight = Math.max(132, Math.min(340, r.top - 12 - (visualViewport?.offsetTop || 0))) + 'px';
}
function popClose() { if (!pop && POP.hidden) return; pop = null; POP.hidden = true; ED.setAttribute('aria-expanded', 'false'); ED.removeAttribute('aria-activedescendant'); }
function popChoose(i) {
  const x = pop?.list[i], now = popToken(); if (!x || now?.kind !== pop.kind || now.q !== pop.q) return popClose();   // the caret moved away from the "/xx" since the list was drawn
  const { kind, q } = pop, sel = getSelection(); popMute = true;
  try {
    for (let k = 0; k <= [...q].length; k++) sel.modify('extend', 'backward', 'character');   // the "/" or "@" and the letters typed after it (per character, as modify counts)
    document.execCommand('delete');
    if (kind === '@') insertPlain(x.text);
    else document.execCommand('insertHTML', false, `<span class="stok" contenteditable="false" dir="ltr">/${esc(x.name)}</span> `);   // the space in the same step: a caret right after a non-editable span at the end has no text node to sit in
  } finally { popMute = false; }
  popClose(); ED.focus();
}
ED.setAttribute('aria-controls', 'slashpop'); ED.setAttribute('aria-autocomplete', 'list');
ED.addEventListener('input', popUpdate);
ED.addEventListener('click', popUpdate);
ED.addEventListener('keyup', (e) => { if (/^(Arrow(Left|Right)|Home|End)$/.test(e.key)) popUpdate(); });   // the caret moved: list for the token under it, or none
ED.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ED) popClose(); }, 150));
// Capture: runs before the composer's own Enter / Esc handling, so Enter picks a row instead of sending while the list is open.
ED.addEventListener('keydown', (e) => {
  if (!pop || e.isComposing) return;
  if (e.key === 'Enter' && e.shiftKey) return popClose();   // Shift+Enter stays a new line (its beforeinput must not pick a row)
  const n = pop.list.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { if (!n) return; pop.sel = (pop.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; popDraw(); }
  else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { if (!n) { popClose(); if (e.key === 'Tab') return; } else popChoose(pop.sel); }
  else if (e.key === 'Escape') popClose();
  else return;
  e.preventDefault(); e.stopImmediatePropagation();
}, true);
ED.addEventListener('beforeinput', (e) => {   // a phone keyboard's Enter while the list is open picks the highlighted row
  if (pop?.list.length && (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') && !e.isComposing) { e.preventDefault(); e.stopImmediatePropagation(); popChoose(pop.sel); }
}, true);
POP.addEventListener('pointerdown', (e) => e.preventDefault());   // the composer keeps focus and caret
POP.addEventListener('click', (e) => { const r = e.target.closest('[data-i]'); if (r) popChoose(+r.dataset.i); });
addEventListener('resize', () => pop && popPlace());
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
  if (location.hash === '#todos') return openTodos();
  if (/^#ideas(\/|$)/.test(location.hash)) return openIdeas(location.hash.slice(7) || null);   // #ideas/<id>: the Telegram digest's Open button
  if (location.hash === '#desktop') return openDesktop();   // public/desktop.js
  closeGuide(); closeTodos(); closeIdeas(); closeDesktop();
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
// ---- composer options (phone): folder, mode, model and effort behind one toggle; folded by default, the choice is remembered; folded it shows a summary ----
function optSum() {
  const o = (id) => $(id).selectedOptions[0]?.text || '';
  $('optsum').textContent = [o('mode'), o('model'), `${t('composer.effort')} ${$('effortOut').textContent}`].filter(Boolean).join(' · ');
}
function setOpts(open) { $('composer').classList.toggle('opts', open); $('optsbtn').setAttribute('aria-expanded', String(open)); try { localStorage.setItem('composerOpts', open ? '1' : '0'); } catch {} }
setOpts(localStorage.getItem('composerOpts') === '1');
$('optsbtn').onclick = () => setOpts(!$('composer').classList.contains('opts'));
$('composer').addEventListener('change', optSum); $('composer').addEventListener('input', (e) => { if (e.target.id === 'effort') optSum(); });
// "+" opens Attach / Photo; an item or a tap outside closes it.
const closeAdd = () => { $('addmenu').hidden = true; $('addbtn').setAttribute('aria-expanded', 'false'); };
$('addbtn').onclick = () => { const open = $('addmenu').hidden; $('addmenu').hidden = !open; $('addbtn').setAttribute('aria-expanded', String(open)); if (open) $('addmenu').querySelector('button:not([hidden])')?.focus(); };
document.addEventListener('click', (e) => { if (!$('addmenu').hidden && !e.target.closest('#addbtn') && (!e.target.closest('#addmenu') || e.target.closest('button'))) closeAdd(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('addmenu').hidden) { closeAdd(); $('addbtn').focus(); } });
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
// Drag and drop onto the composer: any file, same path as the Attach button. dragover must be cancelled or the browser opens the file instead.
const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
$('composer').addEventListener('dragover', (e) => { if (isFileDrag(e)) { e.preventDefault(); $('composer').classList.add('dropping'); } });
$('composer').addEventListener('dragleave', (e) => { if (!$('composer').contains(e.relatedTarget)) $('composer').classList.remove('dropping'); });
$('composer').addEventListener('drop', (e) => { if (!isFileDrag(e)) return; e.preventDefault(); $('composer').classList.remove('dropping'); if (!$('attach').hidden) attach([...e.dataTransfer.files]); });
// ---- Voice input: the mic next to Send (server: POST /api/transcribe, voice.mjs; Settings > Voice). Tap = record, tap again = stop and transcribe,
// the text goes in at the caret and is never sent by itself. ✕ / Esc cancels. Desktop: hold Ctrl+Space to talk, let go to stop (no other shortcut uses it).
// The recording format is whatever this browser records (webm/opus: Chrome, Edge, Firefox; mp4/AAC: Safari); the server decodes them all with ffmpeg.
// The DIAG beacon gets the steps, sizes and times, never the text. Live dictation (the default where the browser has it) is the next block. ----
const MIC = $('mic'), REC = $('rec'), MIC_MAX_MS = 300000;   // the server's 5-minute cap: the recording stops by itself there
const MIC_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
let mic = null;   // { rec, stream, chunks, t0, timer, raf, ctx, range, cancelled, hold }
let micBusy = false;   // a clip is uploading / transcribing: a second one waits for it
const micTime = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function micShow(state, html = '') {   // state: rec | live (dictating) | busy | err | '' (hidden)
  const on = state === 'rec' || state === 'live'; MIC.dataset.state = on ? 'rec' : state === 'err' ? '' : state; MIC.setAttribute('aria-pressed', String(on));
  MIC.title = t(on ? 'composer.micStop' : 'composer.micTitle'); MIC.setAttribute('aria-label', MIC.title); MIC.disabled = state === 'busy';
  REC.hidden = !state; REC.className = state; $('recmsg').innerHTML = html;
  if (state !== 'rec') $('reclvl').firstChild.style.width = '0';
}
const micErr = (key, v) => { micShow('err', t(key, v)); diag({ k: 'mic', step: 'error', why: key }); };
function micSaveRange() {   // where the text goes: the caret if it is in the composer, else the end (restored when the text arrives)
  const sel = getSelection(); return sel.rangeCount && ED.contains(sel.getRangeAt(0).startContainer) ? sel.getRangeAt(0).cloneRange() : null;
}
async function micStart({ hold = false } = {}) {
  if (mic || micBusy) return;
  if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) {   // plain http (http://<ip>:4850): browsers give no microphone there
    const url = HTTPS_URL ? HTTPS_URL + location.pathname + location.hash : '';
    return micErr(isSecureContext ? 'voice.unsupported' : 'voice.https', { url: url ? `<a href="${esc(url)}" dir="ltr">${esc(HTTPS_URL)}</a>` : 'https://' });
  }
  if (liveOn()) return liveStart(hold);
  if (!window.MediaRecorder) return micErr('voice.unsupported');
  const range = micSaveRange(); let stream;
  const m = mic = { starting: true, hold, range, cancelled: false };   // set before the permission prompt: a second tap / key while it is open does nothing
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }); }
  catch (x) {
    if (mic === m) mic = null; diag({ k: 'mic', step: 'perm', ok: false, err: x.name });
    return micErr(x.name === 'NotAllowedError' || x.name === 'SecurityError' ? (TOUCH ? 'voice.deniedPhone' : 'voice.denied') : x.name === 'NotFoundError' || x.name === 'OverconstrainedError' ? 'voice.noMic' : x.name === 'NotReadableError' ? 'voice.micInUse' : 'voice.unsupported');
  }
  diag({ k: 'mic', step: 'perm', ok: true, hold });
  if (m.cancelled || mic !== m) { stream.getTracks().forEach((tr) => tr.stop()); return; }   // let go / cancelled while the prompt was open
  const type = MIC_TYPES.find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  Object.assign(m, { starting: false, rec, stream, chunks: [], t0: Date.now() });
  rec.ondataavailable = (e) => { if (e.data.size) m.chunks.push(e.data); };
  rec.start(1000);
  stream.getTracks().forEach((tr) => { tr.onended = () => { if (mic === m) micStop(); }; });   // mic unplugged / taken away: keep what was said
  micShow('rec'); $('rectime').value = '0:00';
  m.timer = setInterval(() => { const ms = Date.now() - m.t0; $('rectime').value = micTime(ms); if (ms >= MIC_MAX_MS) micStop(); }, 250);
  try {   // the live level: RMS of the microphone signal drives the bar's width
    const AC = window.AudioContext || window.webkitAudioContext; m.ctx = new AC(); const an = m.ctx.createAnalyser(); an.fftSize = 512;
    m.ctx.createMediaStreamSource(stream).connect(an); const buf = new Uint8Array(an.fftSize), bar = $('reclvl').firstChild;
    const tick = () => { an.getByteTimeDomainData(buf); let s = 0; for (const v of buf) s += (v - 128) ** 2; bar.style.width = Math.min(100, Math.sqrt(s / buf.length) * 4) + '%'; m.raf = requestAnimationFrame(tick); };
    tick();
  } catch {}   // no meter is fine, the recording still works
}
function micEnd(m) { clearInterval(m.timer); cancelAnimationFrame(m.raf); m.ctx?.close().catch(() => {}); m.stream?.getTracks().forEach((tr) => tr.stop()); }
function micCancel() {
  if (!mic) { if (!REC.hidden && !micBusy) micShow(''); return; }   // the ✕ of an error line just closes it
  if (mic.live) { const m = mic; m.stopping = true; m.drop = true; return liveEnd(m); }   // live: what was already typed stays, the interim words go (and no Smart finish)
  const m = mic; mic = null; m.cancelled = true; if (m.starting) return;
  m.rec.onstop = null; try { m.rec.stop(); } catch {} micEnd(m); micShow(''); diag({ k: 'mic', step: 'cancel', ms: Date.now() - m.t0 });
}
function micStop() {
  const m = mic; if (!m) return;
  if (m.live) return liveStop(m);
  if (m.starting) { m.cancelled = true; mic = null; return; }   // let go before the permission prompt was answered
  mic = null; micBusy = true; micShow('busy', t('composer.transcribing'));
  m.rec.onstop = () => { micEnd(m); micSend(m, new Blob(m.chunks, { type: m.rec.mimeType || 'audio/webm' })); };
  try { m.rec.stop(); } catch { micEnd(m); micBusy = false; micErr('voice.unsupported'); }   // the recorder already stopped itself: never leave the button disabled
}
async function micSend(m, blob) {
  const ms = Date.now() - m.t0, t0 = Date.now();
  diag({ k: 'mic', step: 'stop', ms, bytes: blob.size, mime: blob.type });
  if (ms < 500 || blob.size < 1000) { micBusy = false; return micErr('voice.empty'); }
  let r, status = 0;
  try { const res = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-Seat-Token': TOKEN }, body: blob }); status = res.status; r = await res.json().catch(() => ({})); }
  catch (x) { r = { error: String(x.message || x), code: 'net' }; }
  micBusy = false;
  diag({ k: 'mic', step: 'result', status, code: r.code || null, serverMs: r.ms ?? null, roundMs: Date.now() - t0, lang: r.lang || null });
  if (status !== 200) return micErr(r.code === 'busy' ? 'voice.busy' : r.code === 'empty' ? 'voice.empty' : r.code === 'big' ? 'voice.tooBig' : r.code === 'off' ? 'voice.off' : 'voice.failed', { error: esc(r.error || String(status)) });
  const text = (r.text || '').trim(); if (!text) return micErr('voice.empty');
  micShow('');
  ED.focus(); const sel = getSelection();
  if (m.range && m.range.startContainer.isConnected && ED.contains(m.range.startContainer)) { sel.removeAllRanges(); sel.addRange(m.range); } else caretEnd();
  const pre = document.createRange(); pre.selectNodeContents(ED); pre.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  const before = edText(pre.cloneContents());
  insertPlain((before && !/\s$/.test(before) ? ' ' : '') + text);   // a space after what was there, never glued to the previous word
}
// ---- Live dictation (Settings > Voice > engine "live", the default): the browser's own speech recognition writes while you speak.
// Interim words show greyed in a span at the caret, final ones are typed in front of it (undo works). Chrome ends a session after silence or ~60 s:
// it is started again until you stop. Firefox (no SpeechRecognition) and engine "local" use the Whisper recording above instead.
// The audio goes to the browser vendor's speech service (Google for Chrome, Microsoft for Edge); Settings says so. ----
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const ANDROID = /Android/i.test(navigator.userAgent);
const LIVE_LANG = { '': 'he-IL', he: 'he-IL', en: 'en-US', de: 'de-AT' };
const LIVE_FATAL = { 'not-allowed': TOUCH ? 'voice.deniedPhone' : 'voice.denied', 'service-not-allowed': 'voice.service', network: 'voice.service', 'audio-capture': 'voice.noMic', 'language-not-supported': 'voice.langUnsupported' };
const liveOn = () => !!SR && (setData?.settings?.voiceEngine ?? 'live') === 'live';
const smartOn = () => setData?.settings?.voiceSmart !== false && !!window.MediaRecorder;   // Settings > Voice > Smart finish (default on)
const rollOn = () => setData?.settings?.voiceRolling !== false && !!window.AudioWorkletNode && !!window.WebSocket;   // Settings > Voice > Rolling correction (default on)
const BROWSER = (() => {   // for the DIAG beacon: Edge and Chrome send the audio to different speech services (UA-CH brands, else the UA string)
  const b = (navigator.userAgentData?.brands || []).map((x) => x.brand), ua = navigator.userAgent;
  return b.includes('Microsoft Edge') || /Edg\//.test(ua) ? 'edge' : b.includes('Google Chrome') || /Chrome\//.test(ua) ? 'chrome' : /Firefox\//.test(ua) ? 'firefox' : /Safari\//.test(ua) ? 'safari' : 'other';
})();
// ---- The dictation language chip (HE / EN / DE left of the mic). Live dictation hears one language per session (the Web Speech API cannot
// detect it), so the owner picks it here: tap = the next one, hold or right-click = the list. Remembered on this device; until then
// Settings > Voice > Spoken language (Detect = Hebrew). Switching while dictating keeps what is typed and listens on in the new language. ----
const MICLANG = $('miclang'), LIVE_LANGS = ['he', 'en', 'de'];
const liveLang = () => { let v = null; try { v = localStorage.getItem('voiceLiveLang'); } catch {} return LIVE_LANGS.includes(v) ? v : LIVE_LANGS.includes(setData?.settings?.voiceLang) ? setData.settings.voiceLang : 'he'; };
function langChip() { const c = liveLang(); MICLANG.textContent = c.toUpperCase(); MICLANG.title = t('voice.langChip', { lang: esc(setData?.languages?.[c] || c) }); MICLANG.setAttribute('aria-label', MICLANG.title); }
function setLiveLang(c) {
  try { localStorage.setItem('voiceLiveLang', c); } catch {}
  langChip(); diag({ k: 'mic', engine: 'live', step: 'lang', lang: c, during: !!mic?.live });
  if (mic?.live && !mic.stopping && !mic.ended && c !== mic.lang) liveSwitch(mic);   // the same language again: nothing to restart
}
function langMenu() {
  let mn = $('miclangmenu');
  if (!mn) {
    mn = document.createElement('div'); mn.id = 'miclangmenu'; mn.setAttribute('role', 'menu'); mn.hidden = true; document.body.append(mn);
    mn.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; langMenuClose(); setLiveLang(b.dataset.lang); };
    mn.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); langMenuClose(); MICLANG.focus(); } };   // before the document's Esc (which would stop the dictation)
  }
  if (!mn.hidden) return;   // a touch long-press fires both the timer and 'contextmenu'
  const c = liveLang();
  mn.innerHTML = LIVE_LANGS.map((l) => `<button type="button" role="menuitemradio" aria-checked="${l === c}" data-lang="${l}"><b dir="ltr">${l.toUpperCase()}</b> <span lang="${l}">${esc(setData?.languages?.[l] || l)}</span></button>`).join('');
  mn.hidden = false; MICLANG.setAttribute('aria-expanded', 'true');
  const r = MICLANG.getBoundingClientRect();
  mn.style.top = Math.max(4, r.top - mn.offsetHeight - 6) + 'px'; mn.style.left = Math.min(innerWidth - mn.offsetWidth - 4, Math.max(4, r.left)) + 'px';
  if (!mic?.live) mn.querySelector('[aria-checked=true]').focus();   // while dictating the focus stays in the box
}
function langMenuClose() { const mn = $('miclangmenu'); if (mn) mn.hidden = true; MICLANG.setAttribute('aria-expanded', 'false'); }
let langHoldT = 0, langHeld = false;
MICLANG.addEventListener('pointerdown', (e) => { if (e.button) return; langHeld = false; clearTimeout(langHoldT); langHoldT = setTimeout(() => { langHeld = true; langMenu(); }, 500); });
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) MICLANG.addEventListener(ev, () => clearTimeout(langHoldT));
MICLANG.addEventListener('contextmenu', (e) => { e.preventDefault(); clearTimeout(langHoldT); langHeld = true; langMenu(); });
MICLANG.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') langHeld = false; });   // a keyboard press is never the tail of a long-press
MICLANG.onclick = () => { if (langHeld) { langHeld = false; return; } setLiveLang(LIVE_LANGS[(LIVE_LANGS.indexOf(liveLang()) + 1) % LIVE_LANGS.length]); };
document.addEventListener('pointerdown', (e) => { const mn = $('miclangmenu'); if (mn && !mn.hidden && !mn.contains(e.target) && e.target !== MICLANG) langMenuClose(); }, true);
function liveStart(hold) {
  const range = micSaveRange(); ED.focus(); const sel = getSelection();
  if (range) { sel.removeAllRanges(); sel.addRange(range); } else caretEnd();
  const span = document.createElement('span'); span.className = 'vi'; span.contentEditable = 'false';
  const r = sel.getRangeAt(0); r.collapse(false); r.insertNode(span);
  // Smart finish / rolling correction mark where this dictation starts (an empty, non-editable span; the interim span marks the end): only the text between the two is ever replaced
  // Android Chrome: while the page holds the microphone (the parallel capture below) its recognizer hears silence, with no error to catch:
  // 0 live words in every Android session since Smart finish (DIAG 2026-11-25). There dictation stays plain live, as before Smart finish.
  const smart = smartOn() && !ANDROID, roll = rollOn() && !ANDROID;
  const m0 = smart || roll ? Object.assign(document.createElement('span'), { className: 'vm', contentEditable: 'false' }) : null; if (m0) span.before(m0);
  r.setStartBefore(span); r.collapse(true); sel.removeAllRanges(); sel.addRange(r);   // caret before the span (after the start mark), nothing selected
  const m = mic = { live: true, hold, span, m0, conv: cur.id, t0: Date.now(), stopping: false, quick: 0, langs: new Set(), smart, fin: roll ? [] : null };   // fin: the typed finals (rolling correction)
  m.timer = setInterval(() => { $('rectime').value = micTime(Date.now() - m.t0); }, 250);
  $('rectime').value = '0:00'; micShow('live', t('voice.listening'));
  diag({ k: 'mic', engine: 'live', step: 'start', hold, browser: BROWSER, smart, roll }); $('rollstate').hidden = true;
  liveRec(m);
  if (m0) sfRecord(m);
}
function liveRec(m) {
  const rec = m.rec = new SR(); m.lang = liveLang(); m.langs.add(m.lang); rec.lang = LIVE_LANG[m.lang]; rollSend(m, { type: 'lang', lang: m.lang }); rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
  m.err = null; m.done = new Map(); m.lastFinal = 0; m.tRec = Date.now(); m.gap = false;
  rec.onstart = () => { if (!m.started) { m.started = true; diag({ k: 'mic', engine: 'live', step: 'perm', ok: true, lang: rec.lang }); } };
  rec.onresult = (e) => {
    if (mic !== m || m.rec !== rec) return;   // a session ended by a language switch can still deliver a late result
    if (cur.id !== m.conv) { m.drop = true; return liveEnd(m); }   // another chat was opened: its composer must not get these words
    if (!m.span.isConnected) { caretEnd(); getSelection().getRangeAt(0).insertNode(m.span); }   // the box was cleared or rewritten mid-dictation: carry on at the end
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i], txt = res[0].transcript;
      if (!res.isFinal) { interim += txt; continue; }
      // Android Chrome may deliver a final result twice, or a final that repeats the previous one plus new words: only the new part is typed
      if (m.done.get(i) === txt) continue;
      const prev = m.done.get(i) ?? [...m.done.values()].pop() ?? '', echo = ANDROID && prev && Date.now() - m.lastFinal < 1500 && txt.trim().startsWith(prev.trim());   // the repeat bug is Android's; elsewhere a repeated word is meant
      const add = echo ? txt.trim().slice(prev.trim().length) : txt; m.done.set(i, txt); m.lastFinal = Date.now();
      if (add.trim()) liveCommit(m, add);
    }
    if (!interim) m.segT = 0; else if (!m.segT) m.segT = Date.now();   // when the words now interim started showing (rolling correction maps phrases by time)
    const pv = m.span.previousSibling;   // a space in front when the interim words would touch the previous word
    m.span.textContent = interim && pv?.nodeType === 3 && pv.data && !/\s$/.test(pv.data) && !/^\s/.test(interim) ? ' ' + interim : interim;
  };
  rec.onerror = (e) => {
    if (e.error === 'audio-capture' && (m.sf || m.roll) && !m.sfShared) { m.sfShared = true; sfDrop(m); rollStop(m, 'shared-mic'); diag({ k: 'mic', engine: 'live', step: 'smart', ok: false, err: 'shared-mic' }); return; }   // a recognizer that wants the mic alone (some phones): drop the parallel recording, keep dictating
    m.err = e.error; if (e.error !== 'no-speech' && e.error !== 'aborted') diag({ k: 'mic', engine: 'live', step: 'error', err: e.error });
  };
  rec.onend = () => {
    if (mic !== m || m.rec !== rec) return;
    if (m.stopping || LIVE_FATAL[m.err]) return liveEnd(m, m.stopping ? null : LIVE_FATAL[m.err]);
    // Edge ends a session after a short pause, often before its last words became final: they are typed now, the next session's first result would overwrite them
    const pend = m.span.textContent; m.span.textContent = ''; if (pend.trim()) liveCommit(m, pend);
    if (m.switching) { m.switching = false; m.quick = 0; return liveRec(m); }   // the language chip: listen on in the new language at once
    const quick = Date.now() - m.tRec < 1000;
    if (quick && ++m.quick > 3) return liveEnd(m, 'voice.service');   // ends at once again and again: the service is not answering
    if (!quick) m.quick = 0;
    // Chrome's silent end after a pause or ~60 s: keep listening until the owner stops. A session that ended at once waits 250 / 500 / 750 ms
    // before the next: restarting in a tight loop is what made Edge drop words.
    m.gap = true; m.restartT = setTimeout(() => { if (mic !== m || m.stopping) return; try { liveRec(m); } catch { liveEnd(m, 'voice.service'); } }, quick ? 250 * m.quick : 0);
  };
  rec.start();
}
function liveSwitch(m) {   // a new language mid-dictation: the words heard so far stay typed, the next ones are heard in the new language
  const txt = m.span.textContent; m.span.textContent = ''; if (txt.trim()) liveCommit(m, txt);
  if (m.gap) return;   // between two sessions: the next one starts in the new language anyway
  if (m.switching) return;   // a second tap before the first restart finished
  m.switching = true; try { m.rec.abort(); } catch {}
}
function liveCommit(m, text) {   // typed in front of the interim span, with a space if it would glue onto the previous word
  if (document.activeElement !== ED) ED.focus({ preventScroll: true });
  // rolling correction: an empty mark in front of each final, so a phrase read again later replaces exactly the finals typed in its time
  const mk = m.fin && m.span.isConnected ? Object.assign(document.createElement('span'), { className: 'vm', contentEditable: 'false' }) : null; if (mk) m.span.before(mk);
  const sel = getSelection(), r = document.createRange(); r.setStartBefore(m.span); r.collapse(true); sel.removeAllRanges(); sel.addRange(r);
  const pre = document.createRange(); pre.selectNodeContents(ED); pre.setEnd(r.startContainer, r.startOffset);
  const before = edText(pre.cloneContents());
  m.committing = true; try { insertPlain((before && !/\s$/.test(before) ? ' ' : '') + text.trim()); } finally { m.committing = false; }
  if (mk) { const now = Date.now(); m.fin.push({ mk, s: m.segT || Math.max(m.fin.at(-1)?.e ?? 0, now - 2000), e: now, st: 'open', text: rollText(mk, m.span) }); m.segT = 0; rollTry(m); }
}
// The caret sits at the end of the dictated part, so the owner's own typing there lands between the marks: that dictation is then not replaced.
ED.addEventListener('beforeinput', () => {
  const m = mic; if (!m?.live || !m.m0 || m.committing || !m.m0.isConnected || !m.span.isConnected) return;
  const s = getSelection(); if (!s.rangeCount) return; const c = s.getRangeAt(0), seg = sfRange(m);
  if (seg.isPointInRange(c.startContainer, c.startOffset) || seg.isPointInRange(c.endContainer, c.endOffset)) m.edited = true;
});
function liveEnd(m, errKey) {
  if (m.ended) return; m.ended = true;   // stop timer and 'end' can both arrive
  if (mic === m) mic = null;
  clearInterval(m.timer); clearTimeout(m.stopT); clearTimeout(m.restartT); try { m.rec.abort(); } catch {}
  // stopped (or the service failed) before the last words became final: they are kept. Cancel, Send and a chat switch (m.drop) drop them.
  if (!m.drop && m.span.isConnected && m.span.textContent.trim()) liveCommit(m, m.span.textContent);
  rollStop(m);   // the last phrase is still read (the stream says 'end'); a dropped dictation closes it
  // DIAG: which way Smart finish went (BUG #1: a dictation with switches ended with no 'smart' line and no way to tell why)
  const marks = !!m.m0 && m.m0.isConnected && m.span.isConnected;
  const smart = !m.m0 || !m.smart ? 'off' : m.drop ? 'drop' : !m.sf ? (m.sfShared ? 'shared-mic' : 'no-recording') : !marks ? 'marks' : 'check';
  if (smart === 'check') { m.span.textContent = ''; m.span.className = 'vm'; sfFinish(m); }   // the span stays as the end mark
  else if (m.roll && !m.drop && marks) {   // rolling correction without Smart finish: the marks stay until its last phrase is in
    m.span.textContent = ''; m.span.className = 'vm'; sfDrop(m); m.waiting = true; sfOpen.add(m); sfDot();
    rollAfter(m, () => { m.waiting = false; sfDot(); rollKeep(m); });
  } else { sfDrop(m); rollClose(m); m.m0?.remove(); m.span.remove(); rollUnmark(m); }
  ED.normalize();
  diag({ k: 'mic', engine: 'live', step: 'end', ms: Date.now() - m.t0, err: errKey || null, smart, langs: [...m.langs] });
  if (errKey) micErr(errKey); else micShow('');
}
function liveStop(m) {   // the last words may still arrive as a final result before 'end'; never wait longer than 2 s for it
  if (m.stopping) return; m.stopping = true;
  if (m.gap) return liveEnd(m);   // between two sessions: no 'end' will come
  try { m.rec.stop(); } catch {} m.stopT = setTimeout(() => liveEnd(m), 2000);
}
// ---- Smart finish (Settings > Voice, default on; decision: smartfinish.js). While live dictation runs, the same speech is recorded here too;
// when it stops, Whisper on this server reads the recording with language detection. Another language it is sure of, or clearly more words
// (Edge drops words), replaces exactly the text this dictation typed (between its two marks), with "Improved by Whisper · Undo" for 8 s.
// Text typed before or after is never touched; an edit inside the dictated part, or sending first, cancels the check. DIAG gets counts, never text. ----
const sfOpen = new Set();   // dictations whose marks are still in the box (Whisper reading, or the Undo note showing)
const sfRange = (m) => { const r = document.createRange(); r.setStartAfter(m.m0); r.setEndBefore(m.span); return r; };
const sfText = (m) => edText(sfRange(m).cloneContents());
const sfDot = () => { if ([...sfOpen].some((m) => m.waiting)) MIC.dataset.check = ''; else delete MIC.dataset.check; };
async function sfRecord(m) {   // the speech service opens the microphone on its own (no way to hand it a stream); Chrome and Edge let a second capture run beside it
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }); }
  catch (x) { diag({ k: 'mic', engine: 'live', step: 'smart', ok: false, err: x.name }); return; }   // no recording = plain live dictation, as before
  if (mic !== m || m.stopping || m.ended) { stream.getTracks().forEach((tr) => tr.stop()); if (m.ended) diag({ k: 'mic', engine: 'live', step: 'smart', ok: false, err: 'late-mic' }); return; }
  m.stream = stream; if (m.fin) rollStart(m);   // one microphone capture for both: the recording below and the rolling stream
  if (!m.smart) return;
  try {
    const type = MIC_TYPES.find((x) => MediaRecorder.isTypeSupported?.(x)) || '', rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined), sf = m.sf = { rec, stream, chunks: [], t0: Date.now() };
    rec.ondataavailable = (e) => { if (e.data.size) sf.chunks.push(e.data); }; rec.start(1000);
    // BUG #1 (2026-11-24): the recording can end by itself mid-dictation (its track ended or the recorder failed; suspected on Edge when
    // the speech service restarts for a language switch). sfFinish used to wait for an 'onstop' that had already fired: no check, no DIAG.
    rec.onstop = () => { sf.endedAt = Date.now(); diag({ k: 'mic', engine: 'live', step: 'smart-rec-ended', ms: sf.endedAt - sf.t0, track: stream.getAudioTracks()[0]?.readyState || null }); };
  } catch (x) { if (!m.roll) stream.getTracks().forEach((tr) => tr.stop()); m.sf = null; diag({ k: 'mic', engine: 'live', step: 'smart', ok: false, err: x.name }); }
}
function sfDrop(m) { const sf = m.sf; if (!sf) return; m.sf = null; sf.rec.onstop = null; sf.dropped = true; try { sf.rec.stop(); } catch {} sf.stream.getTracks().forEach((tr) => tr.stop()); }
function sfFinish(m) {
  const sf = m.sf; m.sf = null; m.sfLive = sfText(m); m.waiting = true; sfOpen.add(m); sfDot();
  // the caret sits at the end of the dictated part: move it past the end mark, so typing on while Whisper reads goes after it, not into it
  const sel = getSelection(), seg = sfRange(m), c = sel.rangeCount && sel.getRangeAt(0);
  if (c && c.collapsed && seg.isPointInRange(c.startContainer, c.startOffset)) { const tail = document.createRange(); tail.setStart(c.startContainer, c.startOffset); tail.setEndBefore(m.span); if (!edText(tail.cloneContents())) { const r = document.createRange(); r.setStartAfter(m.span); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); } }
  // Whatever happens, sfCheck runs exactly once: on 'stop', at once when the recorder already stopped, or after 3 s without a 'stop'.
  // A recording that ended more than 0.4 s before the dictation, or whose 'stop' never came, may miss the last words: it is partial,
  // checked and logged, never used to replace (sf.partial).
  // With rolling correction: its last phrases come in first, then Smart finish reads only the tail it did not settle (rollTailStart).
  let once = false; const go = (late) => {
    if (once) return; once = true; clearTimeout(sf.stopT); sf.stream.getTracks().forEach((tr) => tr.stop()); sf.partial = late === true || (!!sf.endedAt && Date.now() - sf.endedAt > 400);
    const blob = new Blob(sf.chunks, { type: sf.rec.mimeType || 'audio/webm' }), recMs = (sf.endedAt || Date.now()) - sf.t0;
    rollAfter(m, () => { if (rollTailStart(m, sf)) sfCheck(m, blob, recMs, sf); else { m.waiting = false; sfDot(); rollKeep(m); } });
  };
  if (sf.rec.state === 'inactive') return go();
  sf.rec.onstop = () => go(); sf.stopT = setTimeout(() => go(true), 3000);
  try { sf.rec.stop(); } catch { go(); }
}
async function sfCheck(m, blob, recMs, sf) {
  const t0 = Date.now(); let r = {}, status = 0;
  if (recMs >= 700 && blob.size >= 1000 && !m.drop) {
    try { const res = await fetch('/api/transcribe?smart=1&lang=auto' + (m.sfGemini ? '&engine=gemini' : m.sfFrom ? '&from=' + m.sfFrom : ''), { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-Seat-Token': TOKEN }, body: blob }); status = res.status; r = await res.json().catch(() => ({})); }
    catch {}   // no server answer = the live text stays, as before
  }
  m.waiting = false; sfDot();
  const here = !m.drop && m.m0.isConnected && m.span.isConnected && ED.contains(m.m0) && ED.offsetParent && cur.id === m.conv && !m.edited
    && ![...sfOpen, mic].some((o) => o && o !== m && o.m0?.isConnected && sfRange(m).intersectsNode(o.m0)), live = here ? sfText(m) : '';   // composer hidden, typed into, or another dictation inside: no replacement
  // why not here (DIAG, session 1 of 2026-11-24 said only 'gone'): sent / chat switched, marks removed, composer hidden, typed into, another dictation inside
  const gone = m.drop ? 'drop' : !(m.m0.isConnected && m.span.isConnected && ED.contains(m.m0)) ? 'marks' : !ED.offsetParent ? 'hidden' : cur.id !== m.conv ? 'conv' : m.edited ? 'typed' : 'nested';
  const d = status === 200 && here && live === m.sfLive && !sf?.partial ? smartDecide({ live, whisper: r.text || '', liveLangs: [...m.langs], lang: r.lang, prob: r.prob, segments: r.segments, langs: r.langs, engine: r.engine })
    : { replace: false, why: sf?.partial ? 'partial' : status !== 200 ? 'server' : here ? 'edited' : 'gone:' + gone, lw: sfWords(m.sfLive), ww: sfWords(r.text) };
  diag({ k: 'mic', engine: 'live', step: 'smart', browser: BROWSER, status, liveWords: d.lw, whisperWords: d.ww, liveLangs: [...m.langs], engineUsed: r.engine || null, fallback: r.fallback || null, lang: r.lang || null, first: r.first || null, prob: r.prob ?? null,
    segments: r.segments ? r.segments.length : null, langs: r.langs || null, replaced: d.replace, why: d.why, rolled: !!m.sfGemini, recMs, serverMs: r.ms ?? null, roundMs: Date.now() - t0 });
  if (!d.replace) return rollKeep(m);   // (= sfDone without a rolling correction to undo)
  const pre = document.createRange(); pre.selectNodeContents(ED); pre.setEndBefore(m.m0); const before = edText(pre.cloneContents());
  sfPut(m, (live.match(/^\s+/)?.[0] ?? (before && !/\s$/.test(before) ? ' ' : '')) + r.text.trim()); m.sfNew = sfText(m);   // the same space in front the live text had
  if (m.sfNew === m.sfLive) return sfDone(m);   // the replacement did not take
  if (!mic && !micBusy) { micShow('note', `${t(r.engine === 'gemini' ? 'voice.improvedGemini' : 'voice.improved')} <button type="button" id="sfundo">${t('voice.undo')}</button>`); $('sfundo').onclick = () => sfUndo(m); m.note = true; }
  m.noteT = setTimeout(() => sfDone(m), 8000);
}
function sfPut(m, text, rng = sfRange(m)) {   // replaces exactly what lies between the two marks (or one phrase's marks: rolling correction; execCommand: Ctrl+Z works too); the owner's caret goes back where it was
  const back = document.activeElement, sel = getSelection(), saved = back === ED && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  ED.focus({ preventScroll: true }); sel.removeAllRanges(); sel.addRange(rng);
  if (text) insertPlain(text); else if (!sel.isCollapsed) document.execCommand('delete');
  sel.removeAllRanges();
  if (saved && ED.contains(saved.startContainer)) sel.addRange(saved); else { const r = document.createRange(); if (mic === m) r.setStartBefore(m.span); else r.setStartAfter(m.span); r.collapse(true); sel.addRange(r); }   // still dictating: where the next words go
  if (back && back !== ED && back !== document.body) back.focus({ preventScroll: true });
}
function sfUndo(m) {
  clearTimeout(m.noteT);
  const ok = m.m0.isConnected && m.span.isConnected && sfText(m) === m.sfNew; if (ok) sfPut(m, m.sfLive);   // edited since: leave it alone
  diag({ k: 'mic', engine: 'live', step: 'smart-undo', ok }); sfDone(m);
}
function sfDone(m) {
  clearTimeout(m.noteT); sfOpen.delete(m); m.waiting = false; sfDot();
  if (m.note && REC.className === 'note') micShow(''); m.note = false;
  rollClose(m); m.m0?.remove(); m.span.remove(); rollUnmark(m); ED.normalize();
}
// ---- Rolling correction (Settings > Voice, default on; server: roll.mjs over /ws/voice; decisions: rolling.js). While the browser types its
// words, the same microphone goes to this server as 16 kHz PCM; it cuts the speech at pauses and reads each phrase with Whisper (ivrit-ai for
// Hebrew), ~5 s behind the speaker. Each typed final has an empty mark in front of it (liveCommit); a phrase replaces exactly the finals typed
// in its time window, never text the owner typed or edited, with a short underline flash and one "Undo last correction" for all of them.
// The server pauses it when it is busy (load, slow phrases, another stream): live dictation + Smart finish as before. DIAG: counts only. ----
const ROLL_PCM = URL.createObjectURL(new Blob([`registerProcessor('pcm16', class extends AudioWorkletProcessor {
  constructor() { super(); this.step = sampleRate / 16000; this.acc = 0; this.buf = new Int16Array(1600); this.n = 0; }
  process(inputs) {   // 16 kHz mono 16-bit, 100 ms per message (the context runs at 16 kHz where the browser allows it; else every step-th sample)
    const c = inputs[0] && inputs[0][0]; if (!c) return true;
    for (let i = 0; i < c.length; i++) {
      if ((this.acc += 1) < this.step) continue; this.acc -= this.step;
      this.buf[this.n++] = Math.max(-1, Math.min(1, c[i])) * 32767;
      if (this.n === 1600) { this.port.postMessage(this.buf.buffer, [this.buf.buffer]); this.buf = new Int16Array(1600); this.n = 0; }
    }
    return true;
  }
});`], { type: 'text/javascript' }));
const rollFixes = [];   // { m, f, old, now }: the corrections "Undo last correction" can take back, newest last
const rollText = (a, b) => { const r = document.createRange(); r.setStartAfter(a); r.setEndBefore(b); return edText(r.cloneContents()); };
const rollEnd = (m, i) => m.fin[i + 1]?.mk || m.span;   // a final runs to the mark of the next final, the last one to the end mark
const rollSend = (m, x) => { if (m.roll?.ws.readyState === 1 && !m.roll.closed) m.roll.ws.send(JSON.stringify(x)); };
function rollStart(m) {
  let ws; try { ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/voice`, ['seat', TOKEN]); } catch { return; }   // the token as subprotocol: a WebSocket cannot carry headers
  const r = m.roll = { ws, t0: 0, pend: [], phrases: 0, replaced: 0, same: 0, skipped: 0, ms: 0, paused: null, closed: false };
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => ws.send(JSON.stringify({ type: 'start', lang: m.lang }));
  ws.onclose = () => rollClose(m, r.done ? null : 'closed');
  ws.onmessage = (e) => {
    let x; try { x = JSON.parse(e.data); } catch { return; }
    if (x.type === 'ready' && !r.ending) rollAudio(m, r);
    else if (x.type === 'paused') { r.paused = x.why; $('rollstate').hidden = false; rollClose(m); }   // "Rolling correction paused: server busy"
    else if (x.type === 'done') { r.done = true; rollClose(m); }
    else if (x.type === 'phrase' && !m.drop) {
      r.phrases++; r.ms += x.ms || 0;
      if (x.text?.trim()) { r.pend.push({ startMs: r.t0 + x.startMs, endMs: r.t0 + x.endMs, text: x.text }); rollTry(m); }
    }
  };
}
async function rollAudio(m, r) {
  if (r.closed || !m.stream) return;
  try {
    const ctx = r.ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.audioWorklet.addModule(ROLL_PCM); if (r.closed) return ctx.close();
    const src = ctx.createMediaStreamSource(m.stream), node = new AudioWorkletNode(ctx, 'pcm16');
    node.port.onmessage = (e) => { if (!r.closed && !r.ending && r.ws.readyState === 1) r.ws.send(e.data); };
    r.t0 = Date.now(); src.connect(node); node.connect(ctx.destination);   // (its output is silence: connected only so the browser runs it)
    ctx.resume?.();
  } catch (x) { if (r.ending) return; diag({ k: 'mic', engine: 'live', step: 'roll', ok: false, err: x.name }); rollClose(m); }   // ending: stopped while loading, the last phrase still comes
}
function rollTry(m) {   // the phrases that came back, matched to the finals typed in their time (rolling.js rollMatch)
  const r = m.roll; if (!r || !m.fin || !r.pend.length) return;
  if (m.drop || !m.m0?.isConnected || !m.span.isConnected || cur.id !== m.conv || !ED.offsetParent) { r.pend = []; return; }
  const ps = r.pend, p = { startMs: ps[0].startMs, endMs: ps[ps.length - 1].endMs, text: ps.map((x) => x.text.trim()).join(' ') };
  const mt = rollMatch(m.fin, p, mic === m ? m.segT || null : null);
  if (mt.wait) return;   // its words are still interim: tried again when they are typed (liveCommit)
  if (mt.why === 'nomatch' && mic === m && ps.length < 2) return;   // its final may still come, or it shares one with the next phrase: tried with that one
  r.pend = [];
  if (mt.why) { r.skipped++; return; }
  const a = m.fin[mt.from].mk, b = rollEnd(m, mt.to), live = rollText(a, b);
  // the owner typed into these finals (or around them) since they were typed: never touched
  if (live !== m.fin.slice(mt.from, mt.to + 1).map((f) => f.text).join('')) { for (let i = mt.from; i <= mt.to; i++) m.fin[i].st = 'edited'; r.skipped++; return; }
  const d = rollDecide(live, p.text);
  if (!d.replace) { if (d.why === 'same') { r.same++; for (let i = mt.from; i <= mt.to; i++) Object.assign(m.fin[i], { st: 'done', pEnd: p.endMs }); } else r.skipped++; return; }
  const rng = document.createRange(); rng.setStartAfter(a); rng.setEndBefore(b);
  const now = (live.match(/^\s+/)?.[0] ?? '') + p.text.trim();   // the same space in front the live text had
  m.committing = true; try { sfPut(m, now, rng); } finally { m.committing = false; }
  const f = m.fin[mt.from]; m.fin.splice(mt.from + 1, mt.to - mt.from);   // the finals in between lost their marks with the old text: one final now
  Object.assign(f, { st: 'done', pEnd: p.endMs, text: rollText(a, rollEnd(m, mt.from)) });
  if (f.text === live) return;
  r.replaced++; rollFixes.push({ m, f, old: live, now: f.text }); rollUndoUi();
  if (window.Highlight && CSS.highlights) {   // a short underline under the corrected words (no DOM change, so nothing to clean up in the text)
    const h = CSS.highlights.get('rollfix') || new Highlight(), fl = document.createRange(); fl.setStartAfter(a); fl.setEndBefore(rollEnd(m, mt.from));
    CSS.highlights.set('rollfix', h); h.add(fl); setTimeout(() => h.delete(fl), 1600);
  }
}
function rollStop(m, why) {   // the dictation ended: no more audio; the server reads the last phrase and says 'done' (a dropped one: closed now)
  const r = m.roll; if (!r && !m.sf && m.stream) m.stream.getTracks().forEach((tr) => tr.stop());   // no stream could be opened: the capture is still ours to stop
  if (!r || r.ending) return; r.ending = true;
  r.ctx?.close().catch(() => {}); r.ctx = null;   // (a second close() rejects)
  if (!m.sf && m.stream) m.stream.getTracks().forEach((tr) => tr.stop());   // the Smart finish recording, when there is one, stops the microphone itself
  if (why) r.paused = why; else $('rollstate').hidden = true;
  if (m.drop || why || r.ws.readyState !== 1) return rollClose(m);
  rollSend(m, { type: 'end' }); rollTry(m);
}
function rollAfter(m, fn) {   // fn once the last phrase is in (or the stream closed / paused, or 15 s passed)
  const r = m.roll; if (!r || r.closed) return fn();
  r.after = fn; r.afterT = setTimeout(() => rollClose(m, 'timeout'), 15000);
}
function rollClose(m, why) {
  const r = m.roll; if (!r || r.closed) return; r.closed = true; if (why && !r.paused) r.paused = why;
  clearTimeout(r.afterT); r.ctx?.close().catch(() => {}); r.ctx = null; try { r.ws.close(); } catch {}
  rollTry(m);   // a phrase still waiting for a merge partner: matched now, alone
  diag({ k: 'mic', engine: 'live', step: 'roll', phrases: r.phrases, replaced: r.replaced, same: r.same, skipped: r.skipped, avgMs: r.phrases ? Math.round(r.ms / r.phrases) : null, paused: r.paused, finals: m.fin?.length ?? 0, tail: m.fin ? m.fin.length - rollTail(m.fin) : null });
  const fn = r.after; r.after = null; fn?.();
}
function rollTailStart(m, sf) {   // Smart finish after rolling correction: only the finals after the last settled one, and only their audio (?from=)
  if (!m.fin || !m.m0.isConnected) return true;
  const k = rollTail(m.fin); if (!k) return true;   // nothing settled: the whole dictation, as without rolling correction
  // Gemini still reads the whole clip (owner, 2026-11-24): ivrit writes the English words of a Hebrew sentence in Hebrew letters, Gemini
  // spells them in Latin. smartDecide keeps the rolled text unless Gemini has Latin words it lacks, other languages or clearly more words;
  // Gemini failing keeps it too (?engine=gemini: no Whisper read over settled text).
  if ((setData?.settings?.voiceSmartEngine || 'whisper') === 'gemini') { m.sfGemini = true; m.sfLive = sfText(m); return true; }
  if (k >= m.fin.length) return false;   // everything settled: nothing left to read
  m.fin[k].mk.before(m.m0); m.sfLive = sfText(m); m.sfFrom = Math.max(0, Math.round(m.fin[k - 1].pEnd - sf.t0));
  return true;
}
function rollKeep(m) {   // its marks stay 8 s after a correction, for Undo
  if (!m.roll?.replaced || m.drop) return sfDone(m);
  if (!mic && !micBusy && REC.hidden) { micShow('note', ''); m.note = true; }
  m.noteT = setTimeout(() => sfDone(m), 8000);
}
function rollUnmark(m) {
  for (const f of m.fin || []) f.mk.remove();
  for (let i = rollFixes.length - 1; i >= 0; i--) if (rollFixes[i].m === m) rollFixes.splice(i, 1);
  rollUndoUi();
}
function rollUndoUi() { $('rollundo').hidden = !rollFixes.length; }
$('rollundo').onclick = () => {   // the newest correction whose text is still as it was put in: back to the live words
  const x = rollFixes.pop(); rollUndoUi(); if (!x) return;
  const { m, f } = x, i = m.fin.indexOf(f), b = i >= 0 && rollEnd(m, i), ok = !!b && f.mk.isConnected && b.isConnected && rollText(f.mk, b) === x.now;
  if (ok) { const rng = document.createRange(); rng.setStartAfter(f.mk); rng.setEndBefore(b); m.committing = true; try { sfPut(m, x.old, rng); } finally { m.committing = false; } f.text = rollText(f.mk, b); }
  diag({ k: 'mic', engine: 'live', step: 'roll-undo', ok });
};
// Send while dictating: stop first and drop the interim span, so the message holds exactly what is in the box (capture: runs before the send handler).
// A Smart finish still reading is dropped: the message went as it was.
$('composer').addEventListener('submit', () => { if (mic?.live) { const m = mic; m.stopping = true; m.drop = true; liveEnd(m); } for (const m of sfOpen) { m.drop = true; if (!m.waiting) sfDone(m); } }, true);
MIC.onclick = () => { if (mic && !mic.hold) micStop(); else if (!mic) micStart(); };
$('reccancel').onclick = micCancel;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && (mic || (!REC.hidden && !micBusy))) { e.preventDefault(); micCancel(); return; }
  // hold-to-talk: Ctrl+Space down starts (once, not on key repeat), letting go of either key stops
  if (e.code === 'Space' && e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !MIC.hidden && MIC.offsetParent && (document.activeElement === ED || document.activeElement === document.body || document.activeElement === MIC)) { e.preventDefault(); if (!e.repeat && !mic) micStart({ hold: true }); }   // not while typing in another field (cwd, Settings)
});
document.addEventListener('keyup', (e) => { if (mic?.hold && (e.code === 'Space' || e.key === 'Control')) { e.preventDefault(); micStop(); } });
addEventListener('blur', () => { if (mic?.hold) micStop(); });   // the window lost focus mid-hold: keyup will never come, keep what was said
const micUi = () => { MIC.hidden = setData?.settings?.voice === false; MICLANG.hidden = MIC.hidden || !liveOn(); langChip(); if (MIC.hidden) micCancel(); };
// ---- Settings page (#settings, server: settings.mjs + /api/settings*): what is set up, what is turned on. First run (no settings.json) opens it with a checklist. ----
let setData = null, setTab = 'start', draft = null, setNote = null;   // setNote: { tab, html } the last action's result (a login command, an error)
const onSettings = () => document.body.classList.contains('settings');
const STABS = ['start', 'seats', 'telegram', 'access', 'usage', 'projects', 'routines', 'remotes', 'models', 'voice', 'ideas', 'snippets'];
const yes = (ok, a, b) => `<span class="${ok ? 'sok' : 'sno'}">${ok ? '✓ ' + a : '✗ ' + b}</span>`;
const cmd = (c) => `<code class="scmd" dir="ltr">${esc(c)}</code>`;
const tog = (k, title, text) => `<label class="stog"><input type="checkbox" data-set="${k}"${draft[k] ? ' checked' : ''}><span><b>${title}</b><small>${text}</small></span></label>`;
const seatOpts = (sel, blank) => (blank ? `<option value="">${blank}</option>` : '') + setData.detected.seats.filter((s) => s.active).map((s) => `<option${s.name === sel ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
// "New version available": dismissed per newest commit (localStorage), so the next release shows again. The same state feeds the line under the Settings checkbox.
function showUpdate(u) {
  if (setData) setData.update = u;
  const box = $('updver'), up = u.on && u.update;
  if (up && localStorage.getItem('seat-update-dismissed') !== up.latest.sha) {
    box.innerHTML = `<span dir="auto">${t('banner.update', { n: num(up.behind), msg: esc(up.latest.message) })}</span> <a href="${esc(up.url)}" target="_blank" rel="noopener">${t('banner.updateLink')}</a> <span>${t('banner.updateHow', { cmd: '<code dir="ltr">git pull</code>' })}</span> <button type="button" id="updclose">${t('common.close')}</button>`;
    box.hidden = false;
    $('updclose').onclick = () => { localStorage.setItem('seat-update-dismissed', up.latest.sha); box.hidden = true; };
  } else box.hidden = true;
  if (onSettings()) showSettings();
}
const updateLine = () => { const u = setData.update; return !u?.on ? '' : `<small class="smuted">${u.update ? t('set.update.available', { n: num(u.update.behind) }) : t('set.update.upToDate')}${u.checkedAt ? ' · ' + t('set.update.checked', { time: dfmt(u.checkedAt, { dateStyle: 'medium', timeStyle: 'short' }) }) : ''}</small>`; };
const dirty = () => JSON.stringify(draft) !== JSON.stringify(setData.settings);
async function loadSettings() {
  const r = await api('/api/settings').catch(() => null); if (!r?.settings) return;   // a failed read keeps what the page had
  const keep = draft && setData && dirty();   // an action elsewhere on the page never wipes toggles not saved yet
  setData = r; if (!keep) { draft = JSON.parse(JSON.stringify(r.settings)); if (r.firstRun && !draft.language) draft.language = LANG; }   // first run: the language the page opened in, kept by Save (the bot uses it too)
  micUi();
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
  start: () => checklist() + langRow() + tog('updateCheck', t('set.update.title'), t('set.update.hint')) + updateLine() + `<p class="smuted">${t('set.start.note')}</p>`,
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
    + `<label class="snum" data-guide="archive-done"><span><b>${t('set.usage.archiveDone')}</b><small>${t('set.usage.archiveDoneHint')}</small></span><input type="number" min="0" max="10080" data-set="autoArchiveDoneMin" value="${draft.autoArchiveDoneMin}"> ${t('set.usage.min')}</label>`
    // auto handoff (server: rollover.mjs autoHandoffStep): HANDOFF.md first, then a fresh conversation or /compact
    + `<h3>${t('set.ah.title')}</h3>` + tog('autoHandoff', t('set.ah.on'), t('set.ah.onHint'))
    + `<label class="snum" data-guide="set-ah"><span><b>${t('set.ah.pct')}</b><small>${t('set.ah.pctHint')}</small></span><input type="number" min="5" max="90" data-set="autoHandoffPct" value="${draft.autoHandoffPct ?? 30}"> %</label>`
    + `<label class="snum"><span><b>${t('set.ah.action')}</b><small>${t('set.ah.actionHint')}</small></span><select data-set="autoHandoffAction" data-str="1">${['rollover', 'compact'].map((a) => `<option value="${a}"${(draft.autoHandoffAction || 'rollover') === a ? ' selected' : ''}>${t('set.ah.' + a)}</option>`).join('')}</select></label>`
    + `<label class="snum"><span><b>${t('set.ah.floor')}</b><small>${t('set.ah.floorHint')}</small></span><input type="number" min="0" max="900" data-set="autoHandoffMinK" value="${draft.autoHandoffMinK ?? 120}"> k</label>`,
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
  // the mic button (server: voice.mjs). Model ids = voice.mjs VOICE_MODELS; languages by their own names (the Language list's)
  voice: () => `<h3>${t('set.tab.voice')}</h3>` + tog('voice', t('set.voice.on'), t('set.voice.onHint'))
    + `<label class="snum"><span><b>${t('set.voice.engine')}</b><small>${t('set.voice.engineHint')}</small></span><select data-set="voiceEngine" data-str="1">${['live', 'local'].map((e) => `<option value="${e}"${(draft.voiceEngine || 'live') === e ? ' selected' : ''}>${t('set.voice.' + e)}</option>`).join('')}</select></label>`
    + `<label class="snum"><span><b>${t('set.voice.model')}</b><small>${t('set.voice.modelHint')}</small></span><select data-set="voiceModel" data-str="1" dir="ltr">${['small', 'large-v3-turbo', 'ivrit-ai/whisper-large-v3-turbo-ct2'].map((m) => `<option value="${m}"${draft.voiceModel === m ? ' selected' : ''}>${m}</option>`).join('')}</select></label>`
    + `<label class="snum"><span><b>${t('set.voice.lang')}</b><small>${t('set.voice.langHint')}</small></span><select data-set="voiceLang" data-str="1"><option value="">${t('set.voice.auto')}</option>${['he', 'en', 'de'].map((c) => `<option value="${c}" lang="${c}"${draft.voiceLang === c ? ' selected' : ''}>${esc(setData.languages?.[c] || c)}</option>`).join('')}</select></label>`
    + tog('voiceRolling', t('set.voice.rolling'), t('set.voice.rollingHint'))   // rolling correction (roll.mjs): each phrase re-read on this server while dictating
    + tog('voiceSmart', t('set.voice.smart'), t('set.voice.smartHint'))   // Smart finish (voice.mjs SMART_MODELS: models whose language detection works)
    // Smart finish engine (voice.mjs SMART_ENGINES / GEMINI_MODELS): Gemini by default, Whisper = private and the fallback
    + `<label class="snum"><span><b>${t('set.voice.smartEngine')}</b><small>${t('set.voice.smartEngineHint')}</small></span><select data-set="voiceSmartEngine" data-str="1">${['gemini', 'whisper'].map((e) => `<option value="${e}"${(draft.voiceSmartEngine || 'gemini') === e ? ' selected' : ''}>${t(e === 'gemini' ? 'set.voice.engGemini' : 'set.voice.engWhisper')}</option>`).join('')}</select></label>`
    + `<label class="snum"><span><b>${t('set.voice.geminiModel')}</b><small>${t('set.voice.geminiModelHint')}</small></span><select data-set="voiceGeminiModel" data-str="1" dir="ltr">${['gemini-3.8-flash-low', 'gemini-3.8-flash-medium'].map((m) => `<option value="${m}"${(draft.voiceGeminiModel || 'gemini-3.8-flash-low') === m ? ' selected' : ''}>${m}</option>`).join('')}</select></label>`
    + `<label class="snum"><span><b>${t('set.voice.smartModel')}</b><small>${t('set.voice.smartModelHint')}</small></span><select data-set="voiceSmartModel" data-str="1" dir="ltr">${['small', 'large-v3-turbo'].map((m) => `<option value="${m}"${(draft.voiceSmartModel || 'small') === m ? ' selected' : ''}>${m}</option>`).join('')}</select></label>`
    + `<p class="smuted">${t('set.voice.browserHint')}</p>`,
  // the Ideas inbox (server: ideas.mjs): which Claude seat prepares ideas, the daily Telegram reminder, Telegram capture
  ideas: () => `<h3>${t('set.tab.ideas')}</h3>`
    + `<label class="snum" data-guide="set-ideas-seat"><span><b>${t('set.ideas.seat')}</b><small>${t('set.ideas.seatHint')}</small></span><select data-set="ideasSeat" data-str="1">${setData.detected.seats.filter((s) => s.active && !s.agent).map((s) => `<option${s.name === draft.ideasSeat ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>`
    + `<label class="snum"><span><b>${t('set.ideas.digestAt')}</b><small>${t('set.ideas.digestAtHint')}</small></span><input type="time" min="07:00" max="22:59" data-set="ideasDigestAt" data-str="1" value="${esc(draft.ideasDigestAt || '18:00')}" dir="ltr"></label>`
    + `<label class="snum"><span><b>${t('set.ideas.stale')}</b><small>${t('set.ideas.staleHint')}</small></span><input type="number" min="1" max="720" data-set="ideasStaleH" value="${draft.ideasStaleH ?? 24}"> ${t('set.ideas.hours')}</label>`
    + tog('ideasTelegram', t('set.ideas.tg'), t('set.ideas.tgHint')),
  // the composer's "@" snippets (server: slash.mjs, <data>/snippets.json): the whole list is saved at once, in this order
  snippets: () => `<h3>${t('set.tab.snippets')}</h3><small class="smuted">${t('set.snip.note')}</small><form class="sform" data-form="snippets"><div id="sniprows">${(snipDraft || snippets).map(snipRow).join('')}</div>`
    + `<div class="racts"><button type="button" data-snipadd>${t('set.snip.add')}</button><button type="submit" class="primary">${t('common.save')}</button></div></form>`,
};
const snipRow = (s = {}) => `<fieldset class="ssnip"><div class="ssnip-h"><input name="sname" value="${esc(s.name || '')}" required pattern="[a-z0-9][a-z0-9_\-]{0,31}" placeholder="${t('set.snip.namePh')}" aria-label="${t('set.snip.name')}" dir="ltr" spellcheck="false">`
  + `<input name="slabel" value="${esc(s.label || '')}" maxlength="80" placeholder="${t('set.snip.label')}" aria-label="${t('set.snip.label')}" dir="auto">`
  + `<button type="button" data-snipmv="-1" aria-label="${t('set.snip.up')}">↑</button><button type="button" data-snipmv="1" aria-label="${t('set.snip.down')}">↓</button><button type="button" data-sniprm aria-label="${t('common.remove')}">✕</button></div>`
  + `<textarea name="stext" rows="3" required maxlength="8000" aria-label="${t('set.snip.text')}" dir="auto">${esc(s.text || '')}</textarea>`
  + `<input name="sseats" value="${esc((s.seats || []).join(', '))}" placeholder="${t('set.snip.seats')}" aria-label="${t('set.snip.seats')}" dir="ltr" spellcheck="false"></fieldset>`;
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
  closeGuide(); closeTodos(); closeIdeas(); closeDesktop(); document.body.classList.add('settings'); document.body.classList.remove('drawer', 'projects');
  if (tab) { setTab = tab; setNote = null; }
  if (!setData) await loadSettings(); showSettings();
}
function closeSettings() {
  if (!onSettings()) return; document.body.classList.remove('settings'); snipDraft = null;   // rows of a refused snippet save are dropped with the page
  if (location.hash === '#settings') history.replaceState(null, '', location.pathname + location.search);
}
$('setbtn').onclick = () => { if (onSettings()) return closeSettings(); if (location.hash === '#settings') openSettings(); else location.hash = 'settings'; };
// ---- Guide (#guide): how to use the console, one short answer per task. Button names are filled in from the page's own keys,
// so the guide always names a button exactly as the page shows it, in every language. ----
const GUIDE = ['seats', 'start', 'folder', 'attach', 'voice', 'slash', 'ideas', 'desktop', 'approve', 'keep', 'auto', 'search', 'projects', 'runs', 'project', 'ctx', 'settings'];
const onGuide = () => document.body.classList.contains('guide');
function showGuide() {
  const b = (k, v) => `<b>${t(k, v)}</b>`;
  const names = { settings: b('set.title'), foldAll: b('side.all'), use: b('usage.use'), new: b('side.new'), auto: b('mode.auto'), ask: b('mode.ask'), bypass: b('mode.bypass'), effort: b('composer.effort'), chip: b('composer.projectAuto'),
    attach: b('composer.attach'), stop: b('composer.stop'), mic: b('composer.mic'), send: b('composer.send'), tabVoice: b('set.tab.voice'), tabSnippets: b('set.tab.snippets'), allow: b('perm.allow'), deny: b('perm.deny'), needsApproval: b('status.waiting'), needsAnswer: b('conv.needsAnswer'), closeQuestion: b('conv.closeQuestion'),
    keep: b('conv.keep'), archive: b('conv.archive'), showArchived: b('side.showArchived', { n: '…' }), move: b('conv.moveProject'), tabUsage: b('set.tab.usage'), archiveDone: b('set.usage.archiveDone'), archiveDays: b('set.usage.archive'),
    openProjects: b('projects.open'), openProject: b('projects.openProject'), newChat: b('projects.newChat'), allFolders: b('projects.allFolders', { n: '…' }), startRun: b('projects.startRun'), plan: b('projects.plan'), approve: b('projects.approve'),
    needs: b('project.needs'), allClear: b('project.allClear'), working: b('project.working'), runs: b('project.runs'), allTasks: b('project.allTasks'), happening: b('project.happening'), backTo: b('project.backTo'), opened: b('project.opened'), related: b('project.related'), pin: b('project.pin'), notRelated: b('project.notRelated'),
    ideas: b('ideas.button'), desktop: b('desktop.button'), viewOnly: b('desktop.viewOnly'), keyboard: b('desktop.keyboard'), dictate: b('ideas.dictate'), voiceNote: b('ideas.voiceNote'), photo: b('ideas.photo'), ideaSave: b('ideas.save'), ideaStart: b('ideas.start'), ideaTodo: b('ideas.todo'), tabStart: b('set.tab.start'), lang: b('set.lang.title'), tabProjects: b('set.tab.projects'), freshAt: b('set.proj.fresh'), save: b('common.save') };
  $('guide').innerHTML = `<header class="phead shead"><button type="button" class="smenu" data-gdrawer aria-label="${t('side.seats')}">☰</button><div><h2>${t('guide.title')}</h2><small>${t('guide.subtitle')}</small></div><button type="button" data-gclose>${t('common.close')}</button></header>`
    + `<div class="gd"><p class="gd-full"><button type="button" class="primary" data-gtour="full">${t('tour.full')}</button></p>${GUIDE.map((k) => `<section class="gd-s"><h3>${t(`guide.${k}.h`)}</h3><p>${t(`guide.${k}.p`, names)}</p><button type="button" class="gd-show" data-gtour="${k}">${t('tour.show')}</button></section>`).join('')}<p class="gd-build">${t('guide.build', { id: `<code dir="ltr">${esc(BUILD)}</code>` })}</p></div>`;   // which code this page runs (the phone app too)
}
function openGuide() {
  closeSettings(); closeProjects(); closeTodos(); closeIdeas(); closeDesktop(); document.body.classList.add('guide'); document.body.classList.remove('drawer');
  showGuide(); $('guide').scrollTop = 0;
}
function closeGuide() {
  if (!onGuide()) return; document.body.classList.remove('guide');
  if (location.hash === '#guide') history.replaceState(null, '', location.pathname + location.search);
}
$('guidebtn').onclick = () => { if (onGuide()) return closeGuide(); if (location.hash === '#guide') openGuide(); else location.hash = 'guide'; };
// Rail buttons show what is open: every page switch toggles a body class, so one observer covers all the ways in and out (button, hash, Close, tour).
const railState = () => { $('projbtn').setAttribute('aria-pressed', String(onProjects())); $('setbtn').setAttribute('aria-pressed', String(onSettings())); $('guidebtn').setAttribute('aria-pressed', String(onGuide())); $('todobtn').setAttribute('aria-pressed', String(onTodos())); $('ideabtn').setAttribute('aria-pressed', String(onIdeas())); $('deskbtn').setAttribute('aria-pressed', String(onDesktop())); };
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
  if (ds.snipadd != null) { $('sniprows').insertAdjacentHTML('beforeend', snipRow()); return $('sniprows').lastElementChild.querySelector('input').focus(); }
  if (ds.sniprm != null) return b.closest('.ssnip').remove();
  if (ds.snipmv) { const row = b.closest('.ssnip'), up = ds.snipmv === '-1', nb = up ? row.previousElementSibling : row.nextElementSibling; if (nb) row.parentElement.insertBefore(up ? row : nb, up ? nb : row); return b.focus(); }
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
    if (f.dataset.form === 'snippets') {
      const list = [...f.querySelectorAll('.ssnip')].map((row) => { const v2 = (k) => row.querySelector(`[name=${k}]`).value; return { name: v2('sname').trim(), label: v2('slabel').trim(), text: v2('stext'), seats: v2('sseats').split(/[\s,]+/).filter(Boolean) }; });
      const r = await api('/api/snippets', { snippets: list }).catch((x) => ({ error: String(x) }));
      if (r.error) { snipDraft = list; note(`<bdi>${esc(r.error)}</bdi>`, true); } else { snipDraft = null; snippets = r.snippets; note(t('set.snip.saved')); }
    }
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
// Types and counts only, never message text. Active only while Date.now() < DIAG_UNTIL: set DIAG_UNTIL = Date.parse('<end date>') to debug an image-paste problem on a phone, or
// localStorage.diagUntil = <ms timestamp> in one browser (the voice tests do). Delete this block when done. ----
const DIAG_UNTIL = +localStorage.getItem('diagUntil') || 0, diagQ = []; let diagT = 0;
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

// ---- My tasks (#todos): what the seats put on the owner's board (todos.mjs). V = done (its comment rides along), Send = a comment, task stays open.
// Either one is posted into the conversation that asked (server /api/todo). The rail badge counts the open ones on every page.
var todos = { open: [], done: [], dismissed: [] }, todosStale = false;   // var + function declarations: railState() and openHash() run before this block is reached
function onTodos() { return document.body.classList.contains('todos'); }
async function loadTodos() {
  try { todos = await api('/api/todos'); } catch { return; }
  const bd = $('todobtn').querySelector('.rbadge'); bd.hidden = !todos.open.length; bd.textContent = todos.open.length;
  if (onTodos()) showTodos();
}
function todoRow(x) {
  const chat = x.conv ? `<a href="#${esc(x.conv)}" dir="${dirOf(x.title || '')}">${esc(x.title || t('todos.chat'))}</a>${x.seat ? ` · ${esc(x.seat)}` : ''}` : '';
  const closed = x.doneAt || x.dismissedAt;
  const ask = x.kind === 'approval' && !closed;   // an open approval has no Done tick: only Approve / Reject (or Not relevant) close it
  return `<div class="td-row${x.doneAt ? ' td-done' : ''}${x.outcome === 'rejected' ? ' td-rejected' : ''}${x.dismissedAt ? ' td-dismissed' : ''}" data-todo="${esc(x.id)}">${ask ? '<span class="td-ap" aria-hidden="true"></span>' : `<input type="checkbox" aria-label="${t('todos.markDone')}"${closed ? ' checked disabled' : ''}>`}<div class="td-what" dir="${dirOf(x.what)}">${esc(x.what)}</div>`
    + `<div class="td-meta">${x.dismissedAt ? `<b class="td-tag">${t('todos.dismissedTag')}</b> · ` : ''}${x.outcome ? `<b class="td-tag">${t(x.outcome === 'approved' ? 'todos.approvedTag' : 'todos.rejectedTag')}</b> · ` : ''}${x.auto ? `<b class="td-tag">${t('todos.autoTag')}</b> · ` : ''}${x.kind === 'agent' ? `<b class="td-tag">🤖 ${t('todos.agentTag')}</b> · ` : ''}${x.checkBroken && !closed ? `<span class="td-warn">${t('todos.checkBroken')}</span> · ` : ''}${chat}${chat ? ' · ' : ''}${!closed && Date.parse(x.due) ? `<span class="td-due${Date.parse(x.due) <= Date.now() ? ' late' : ''}">🕒 ${t('bot.todo.due', { time: dayOf(Date.parse(x.due)) + clock(Date.parse(x.due)) })}</span> · ` : ''}${ago(Date.parse(x.doneAt || x.dismissedAt || x.at))}${closed ? ` · <button type="button" class="td-link" data-treopen>${t('todos.reopen')}</button>` : ''}</div>`
    + x.comments.map((c) => `<div class="td-c" dir="auto">${c.src === 'telegram' ? `<span class="td-src">${t('todos.viaTelegram')}</span> ` : ''}${esc(c.text)}</div>`).join('')
    + (x.doneAt ? '' : `<div class="td-note"><input type="text" dir="auto" placeholder="${t('todos.commentPh')}" aria-label="${t('todos.commentPh')}">${SR ? todoMicHtml(x.id) : ''}<button type="button" data-tsend>${t('todos.send')}</button><button type="button" class="td-yes" data-tapprove>✅ ${t('todos.approve')}</button><button type="button" class="td-no" data-treject>❌ ${t('todos.reject')}</button><button type="button" class="td-dismiss" data-tdismiss>${t('todos.dismiss')}</button></div>`) + '</div>';
}
function showTodos() {
  if (todoLive) { todosStale = true; return; }   // never rebuilt under a dictation: redrawn when it ends
  if (document.activeElement?.matches?.('#todos .td-note input')) { todosStale = true; return; }   // never rebuilt under a comment being typed: redrawn on blur
  todosStale = false;
  const oldOpen = $('todos').querySelector('.td-old:not(.td-oldx)')?.open, oldxOpen = $('todos').querySelector('.td-oldx')?.open;
  const keep = {}; $('todos').querySelectorAll('[data-todo] .td-note input').forEach((i) => { if (i.value) keep[i.closest('[data-todo]').dataset.todo] = i.value; });   // an SSE reload never eats a comment being typed
  $('todos').innerHTML = `<header class="phead shead"><button type="button" class="smenu" data-tdrawer aria-label="${t('side.seats')}">☰</button><div><h2>${t('todos.title')}</h2><small>${t('todos.subtitle')}</small></div><button type="button" data-tclose>${t('common.close')}</button></header>`
    + `<div class="td">${todos.open.length ? todos.open.map(todoRow).join('') : `<p class="td-empty">${t('todos.empty')}</p>`}`
    + (todos.done.length ? `<details class="td-old"><summary>${t('todos.doneList', { n: todos.done.length })}</summary>${todos.done.map(todoRow).join('')}</details>` : '')
    + (todos.dismissed?.length ? `<details class="td-old td-oldx"><summary>${t('todos.dismissedList', { n: todos.dismissed.length })}</summary>${todos.dismissed.map(todoRow).join('')}</details>` : '') + '</div>';
  for (const [id, v] of Object.entries(keep)) { const i = $('todos').querySelector(`[data-todo="${id}"] .td-note input`); if (i) i.value = v; }
  if (oldOpen) $('todos').querySelector('.td-old:not(.td-oldx)')?.setAttribute('open', '');
  if (oldxOpen) $('todos').querySelector('.td-oldx')?.setAttribute('open', '');
}
function openTodos() {
  closeSettings(); closeProjects(); closeGuide(); closeIdeas(); closeDesktop(); document.body.classList.add('todos'); document.body.classList.remove('drawer');
  if (todos) showTodos(); loadTodos(); $('todos').scrollTop = 0;
}
function closeTodos() {
  if (!onTodos()) return; document.body.classList.remove('todos');
  if (location.hash === '#todos') history.replaceState(null, '', location.pathname + location.search);
}
async function todoAct(row, action) {
  const inp = row.querySelector('.td-note input'), text = inp?.value.trim() || '';
  if (action === 'comment' && !text) return inp?.focus();
  row.querySelectorAll('input,button').forEach((e) => { e.disabled = true; });
  const r = await api('/api/todo', { id: row.dataset.todo, action, text }).catch((e) => ({ error: String(e) }));
  if (r.error) { alert(r.error); row.querySelectorAll('input,button').forEach((e) => { e.disabled = false; }); return; }
  if (inp) inp.value = '';
  if (r.told === false && r.error) alert(t('todos.notTold') + '\n' + r.error);   // a task with no conversation behind it has nobody to tell: no alert
  loadTodos();
}
$('todobtn').onclick = () => { if (onTodos()) return closeTodos(); if (location.hash === '#todos') openTodos(); else location.hash = 'todos'; };
$('todos').onclick = (e) => {
  if (e.target.closest('[data-tclose]')) return closeTodos();
  if (e.target.closest('[data-tdrawer]')) return document.body.classList.add('drawer');
  const row = e.target.closest('[data-todo]'); if (!row) return;
  if (e.target.matches('input[type=checkbox]')) { e.preventDefault(); return todoAct(row, 'done'); }   // checked only once the server took it
  if (e.target.closest('[data-tmic]')) return todoDictate(row);
  if (e.target.closest('[data-tlang]')) { setLiveLang(LIVE_LANGS[(LIVE_LANGS.indexOf(liveLang()) + 1) % LIVE_LANGS.length]); todoMicState(); if (todoLive) try { todoLive.rec.abort(); } catch {} return; }   // a dictation listens on in the new language (onend restarts it)
  if (todoLive && e.target.closest('[data-tsend],[data-tapprove],[data-treject],[data-tdismiss],[data-treopen]')) { todoLive.stopping = true; try { todoLive.rec.abort(); } catch {} }   // acting on a task ends its dictation: the box holds what was heard
  if (e.target.closest('[data-tsend]')) return todoAct(row, 'comment');
  if (e.target.closest('[data-tapprove]')) return todoAct(row, 'approve');   // the comment box, if filled, is their note / reason
  if (e.target.closest('[data-treject]')) return todoAct(row, 'reject');
  if (e.target.closest('[data-tdismiss]')) return todoAct(row, 'dismiss');   // the comment box, if filled, is the reason
  if (e.target.closest('[data-treopen]')) return todoAct(row, 'reopen');
};
// ---- Dictating a task comment: the same plain live dictation as the Ideas box (ideaDictate), into THIS row's comment box;
// language = the composer's chip (liveLang / setLiveLang). Never a parallel microphone capture (Smart finish / rolling stay composer-only), so
// Android's recognizer is not starved (bd56b7f). Send / Approve / Reject / Not relevant then take the box as typed text. ----
var todoLive = null;
function todoMicHtml(id) {
  const on = todoLive?.id === id, c = liveLang();
  return `<button type="button" class="td-lang" data-tlang dir="ltr" title="${t('voice.langChip', { lang: esc(setData?.languages?.[c] || c) })}">${c.toUpperCase()}</button>`
    + `<button type="button" class="td-mic" data-tmic aria-pressed="${on}" aria-label="${t(on ? 'ideas.dictateStop' : 'composer.micTitle')}" title="${t(on ? 'ideas.dictateStop' : 'composer.micTitle')}"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></g></svg></button>`;
}
function todoMicState() {   // the pressed mic + every chip's language, without rebuilding the rows (the box being dictated into stays)
  $('todos').querySelectorAll('[data-todo]').forEach((r) => { const b = r.querySelector('[data-tmic]'); if (!b) return; const on = todoLive?.id === r.dataset.todo, l = t(on ? 'ideas.dictateStop' : 'composer.micTitle'); b.setAttribute('aria-pressed', on); b.title = l; b.setAttribute('aria-label', l); });
  $('todos').querySelectorAll('[data-tlang]').forEach((b) => { b.textContent = liveLang().toUpperCase(); });
}
function todoDictate(row) {
  const id = row.dataset.todo, was = todoLive;
  if (was) { was.stopping = true; try { was.rec.stop(); } catch {} if (was.id === id) return; }   // the same mic again = stop; another row's mic = move there
  if (!isSecureContext) return alert(t('voice.https', { url: HTTPS_URL || 'https://' }).replace(/<[^>]+>/g, ''));
  if (mic?.live) liveStop(mic);   // the composer is dictating: one recognizer at a time, its words stay in its box
  const box = () => $('todos').querySelector(`[data-todo="${CSS.escape(id)}"] .td-note input`);
  const m = todoLive = { id, base: box()?.value || '', stopping: false };
  const run = () => {
    const rec = m.rec = new SR(); rec.lang = LIVE_LANG[liveLang()]; rec.continuous = true; rec.interimResults = true;
    rec.onresult = (e) => {   // as ideaDictate: rebuilt from the session's results; Android may repeat a final with new words added, keep the longer one
      const fin = [], tail = []; for (let i = 0; i < e.results.length; i++) (e.results[i].isFinal ? fin : tail).push(e.results[i][0].transcript.trim());
      for (let i = fin.length - 1; i > 0; i--) if (ANDROID && fin[i - 1] && fin[i].startsWith(fin[i - 1])) fin.splice(i - 1, 1);
      const said = [...fin, ...tail].filter(Boolean).join(' '), b = box(); if (b) b.value = m.base + (m.base && said && !/\s$/.test(m.base) ? ' ' : '') + said;
    };
    rec.onerror = (e) => { m.err = e.error; };
    rec.onend = () => {
      if (todoLive !== m) return;
      if (m.stopping || LIVE_FATAL[m.err] || !box()) { todoLive = null; todoMicState(); if (LIVE_FATAL[m.err] && !m.stopping) alert(t(LIVE_FATAL[m.err])); if (todosStale) { todosStale = false; showTodos(); } return; }
      m.base = box().value; m.err = null; try { run(); } catch { todoLive = null; todoMicState(); }   // Chrome ends a session after a pause (or the chip changed the language): listen on
    };
    rec.start();
  };
  run(); todoMicState();
}
$('todos').addEventListener('focusout', () => setTimeout(() => { if (todosStale && onTodos() && !document.activeElement?.matches?.('#todos .td-note input')) showTodos(); }, 400));   // 400 ms: a tap on Send right after typing still finds its row
$('todos').onkeydown = (e) => { if (e.key === 'Enter' && e.target.matches('.td-note input')) todoAct(e.target.closest('[data-todo]'), 'comment'); };
loadTodos();

// ---- Ideas inbox (#ideas, #ideas/<id>; server: ideas.mjs + /api/idea*). On the go: a capture box (type, dictate, a voice note, a photo, Save).
// At a desk: the prepared ideas grouped by project, each with its original and its brief; "Start chat" opens a NEW chat in that project with the
// first message in the box (never sent by itself). The rail badge counts the ready ones on every page. ----
var ideasList = [], ideaFiles = [], ideaRec = null, ideaLive = null, ideaOpen = new Set(), ideaEdit = null, ideaDraft = null, ideasStale = false, ideaNote = '';   // var: openHash/railState can run before this block
function onIdeas() { return document.body.classList.contains('ideas'); }
async function loadIdeas() {
  try { ideasList = (await api('/api/ideas')).ideas || []; } catch { return; }
  const n = ideasList.filter((x) => x.status === 'ready').length, bd = $('ideabtn').querySelector('.rbadge'); bd.hidden = !n; bd.textContent = n;
  if (onIdeas()) showIdeas();
}
const ideaMedia = (dir, f) => `/api/idea-media?id=${encodeURIComponent(dir)}&f=${encodeURIComponent(f)}`;   // dir = the capture's own folder (it stays there after a merge)
const ideaBusy = () => !!document.activeElement?.closest?.('#ideas .ib-edit, #ideas textarea') || !!ideaRec || !!ideaLive || [...$('ideas').querySelectorAll('audio')].some((a) => !a.paused);   // never redrawn under typing, a recording or a playing voice note (redrawn when it ends)
function ideaCard(x) {
  const b = x.brief || {}, p = b.prep || {}, ed = ideaEdit === x.id, open = ideaOpen.has(x.id) || ed;
  const meta = `<span class="ib-meta">${b.type ? `<span class="ib-type">${esc(t('ideas.type.' + (b.type === 'other' ? 'misc' : b.type)))}</span>` : ''}<span>${esc(ago(Date.parse(x.at)))} · ${esc(t(x.src === 'telegram' ? 'ideas.fromTelegram' : 'ideas.fromConsole'))}${x.captures.length > 1 ? ' ×' + x.captures.length : ''}</span></span>`;
  const orig = x.captures.map((c) => `<div class="ib-cap">${c.text ? `<p dir="auto">${esc(c.text)}</p>` : ''}${c.audio.map((a) => `<audio controls preload="none" src="${ideaMedia(c.dir, a)}"></audio>${x.transcripts?.[c.dir + '/' + a] ? `<p class="ib-tr" dir="auto">${esc(x.transcripts[c.dir + '/' + a])}</p>` : ''}`).join('')}${c.photos.length ? `<div class="ib-ph">${c.photos.map((f) => `<a href="${ideaMedia(c.dir, f)}" target="_blank" rel="noopener"><img src="${ideaMedia(c.dir, f)}" alt="" loading="lazy"></a>`).join('')}</div>` : ''}</div>`).join('');
  const q = (p.questions || []);
  const brief = ed
    ? `<div class="ib-edit"><label>${t('ideas.titleLabel')}<input data-f="title" dir="auto" value="${esc(b.title || '')}"></label>`
      + `<label>${t('ideas.typeLabel')}<select data-f="type">${['build', 'bug', 'question', 'content', 'admin', 'other'].map((k) => `<option value="${k}"${b.type === k ? ' selected' : ''}>${t('ideas.type.' + (k === 'other' ? 'misc' : k))}</option>`).join('')}</select></label>`
      + `<label>${t('ideas.goal')}<textarea data-f="goal" dir="auto" rows="2">${esc(p.goal || '')}</textarea></label><label>${t('ideas.context')}<textarea data-f="context" dir="auto" rows="4">${esc(p.context || '')}</textarea></label>`
      + `<label>${t('ideas.questions')}<textarea data-f="questions" dir="auto" rows="3">${esc(q.join('\n'))}</textarea></label><label>${t('ideas.firstMessage')}<textarea data-f="firstMessage" dir="auto" rows="5">${esc(p.firstMessage || '')}</textarea></label>`
      + `<div class="ib-acts"><button type="button" class="primary" data-isave>${t('common.save')}</button><button type="button" data-icancel>${t('ideas.cancel')}</button></div></div>`
    : `<dl class="ib-brief">${p.goal ? `<dt>${t('ideas.goal')}</dt><dd dir="auto">${esc(p.goal)}</dd>` : ''}${p.context ? `<dt>${t('ideas.context')}</dt><dd dir="auto" class="pre">${esc(p.context)}</dd>` : ''}`
      + `${q.length ? `<dt>${t('ideas.questions')}</dt><dd><ol>${q.map((k) => `<li dir="auto">${esc(k)}</li>`).join('')}</ol></dd>` : ''}${p.firstMessage ? `<dt>${t('ideas.firstMessage')}</dt><dd dir="auto" class="pre ib-msg">${esc(p.firstMessage)}</dd>` : ''}`
      + `${b.related?.length ? `<dt>${t('ideas.related')}</dt><dd class="ib-rel">${b.related.map((r) => `<a href="#${esc(r.id)}" dir="auto">${esc(r.title || r.id)}</a>`).join('')}</dd>` : ''}</dl>`;
  const folders = multiData.folders || [];
  const acts = x.status === 'ready' && !ed ? `<div class="ib-acts"><button type="button" class="primary" data-istart>${t('ideas.start')}</button><button type="button" data-itodo>${t('ideas.todo')}</button><button type="button" data-iedit>${t('common.edit')}</button>`
      + `<label class="ib-proj"><span class="sr">${t('ideas.changeProject')}</span><select data-iproj aria-label="${t('ideas.changeProject')}"><option value="">${t('ideas.noProject')}</option>${folders.map((f) => `<option value="${esc(f.dir)}"${f.dir === b.project ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}${b.project && !folders.some((f) => f.dir === b.project) ? `<option value="${esc(b.project)}" selected>${esc(b.projectName || b.project)}</option>` : ''}</select></label>`
      + `<button type="button" data-iarch>${t('ideas.archive')}</button></div>`
    : x.status === 'done' || x.status === 'archived' ? `<div class="ib-acts">${x.chat ? `<a href="#${esc(x.chat)}">${t('ideas.chat')}</a>` : ''}${x.todo ? `<a href="#todos">${t('ideas.onTasks')}</a>` : ''}<button type="button" data-ireopen>${t('ideas.reopen')}</button><button type="button" data-idel>${t('common.delete')}</button></div>` : '';
  return `<details class="ib ib-${x.status}" data-idea="${esc(x.id)}" id="idea-${esc(x.id)}"${open ? ' open' : ''}><summary><span class="ib-title" dir="auto">${esc(b.title || x.captures[0]?.text?.slice(0, 80) || '…')}</span>${meta}</summary>`
    + `<div class="ib-body">${x.brief ? `<section><h4>${t('ideas.brief')}</h4>${brief}</section>` : ''}<section class="ib-orig"><h4>${t('ideas.original')}</h4>${orig}</section>${acts}</div></details>`;
}
function ideaPending(x) {   // captured / processing / failed: one slim line, a Retry button when it failed
  const txt = x.captures[0]?.text || (x.captures[0]?.audio.length ? '🎙 ' + t('ideas.voiceNote') : '📷 ' + t('ideas.photo'));
  const st = x.status === 'failed' ? `<b class="sno">${t('ideas.failed')}</b> <small dir="auto">${esc(x.error || '')}</small> <button type="button" data-iretry>${t('ideas.retry')}</button> <button type="button" data-idel>${t('common.delete')}</button>`
    : `<span class="ip-spin" aria-hidden="true"></span><small>${x.waitUntil > Date.now() ? t('ideas.waiting') : t('ideas.processing')}</small>`;
  return `<div class="ip ip-${x.status}" data-idea="${esc(x.id)}"><span class="ip-t" dir="auto">${esc(txt.slice(0, 120))}</span><span class="ip-st">${st}</span></div>`;
}
function showIdeas(force) {
  if (!force && ideaBusy()) { ideasStale = true; return; }
  ideasStale = false;
  const box = $('ideas'), y = box.scrollTop, draftText = $('ideatext')?.value || '';
  const ready = ideasList.filter((x) => x.status === 'ready'), busy = ideasList.filter((x) => ['captured', 'processing', 'failed'].includes(x.status)), old = ideasList.filter((x) => x.status === 'done' || x.status === 'archived');
  const groups = new Map(); for (const x of ready) { const k = x.brief?.projectName || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
  const order = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || Date.parse(groups.get(b)[0].at) - Date.parse(groups.get(a)[0].at));   // newest group first, "No project" last
  const fileChips = ideaFiles.map((f, i) => `<span class="ic-f">${f.kind === 'photo' ? `<img src="${f.url}" alt="">` : `🎙 ${esc(f.label)}`}<button type="button" data-irm="${i}" aria-label="${t('common.remove')}">✕</button></span>`).join('');
  box.innerHTML = `<header class="phead shead"><button type="button" class="smenu" data-idrawer aria-label="${t('side.seats')}">☰</button><div><h2>${t('ideas.title')}</h2><small>${t('ideas.subtitle')}</small></div><button type="button" data-iclose>${t('common.close')}</button></header>`
    + `<div class="idx"><form class="ic" data-guide="idea-capture"><textarea id="ideatext" dir="auto" rows="3" placeholder="${t('ideas.placeholder')}" aria-label="${t('ideas.placeholder')}"></textarea>`
    + `${fileChips ? `<div class="ic-files">${fileChips}</div>` : ''}<div class="ic-row">`
    + `<button type="button" data-idict aria-pressed="${!!ideaLive}">${ideaLive ? t('ideas.dictateStop') : t('ideas.dictate')}</button>`
    + `<button type="button" data-irec aria-pressed="${!!ideaRec}">${ideaRec ? t('ideas.voiceStop') + ' <output dir="ltr">0:00</output>' : t('ideas.voiceNote')}</button>`
    + `<button type="button" data-iphoto>${t('ideas.photo')}</button><input type="file" id="ideaphoto" accept="image/*" multiple hidden>`
    + `<button type="submit" class="primary">${t('ideas.save')}</button></div>${ideaNote ? `<p class="ic-note" role="status">${ideaNote}</p>` : ''}</form>`
    + (busy.length ? `<section class="ig ig-busy"><h3>${t('ideas.processing')}</h3>${busy.map(ideaPending).join('')}</section>` : '')
    + (ready.length ? order.map((k) => `<section class="ig"><h3>${esc(k || t('ideas.noProject'))}</h3>${groups.get(k).map(ideaCard).join('')}</section>`).join('') : `<p class="td-empty">${t('ideas.empty')}</p>`)
    + (old.length ? `<details class="td-old ig-old"><summary>${t('ideas.doneList', { n: old.length })}</summary>${old.slice(0, 50).map(ideaCard).join('')}</details>` : '') + '</div>';
  $('ideatext').value = draftText; box.scrollTop = y;
}
function openIdeas(id) {
  closeSettings(); closeProjects(); closeGuide(); closeTodos(); closeDesktop(); document.body.classList.add('ideas'); document.body.classList.remove('drawer');
  if (id) { ideaOpen.add(id); }
  showIdeas(); loadIdeas().then(() => { if (id) document.getElementById('idea-' + id)?.scrollIntoView({ block: 'start' }); });
}
function closeIdeas() {
  if (!onIdeas()) return; document.body.classList.remove('ideas');
  if (location.hash.startsWith('#ideas')) history.replaceState(null, '', location.pathname + location.search);
}
// capture: staged files are uploaded at once (voice note, photo); Save sends the text with their ids
async function ideaUpload(blob, kind, name) {
  const r = await fetch(`/api/idea-file?kind=${kind}&name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'X-Seat-Token': TOKEN, 'Content-Type': blob.type || 'application/octet-stream' }, body: blob }).then((x) => x.json(), () => ({ error: t('composer.uploadFailed') }));
  if (r.error) { ideaNote = esc(r.error); showIdeas(); return null; }
  return r.id;
}
let ideaSaving = false;   // a double tap on Save must not capture twice
async function ideaSave() {
  if (ideaSaving) return;
  const text = $('ideatext').value.trim();
  if (!text && !ideaFiles.length) { ideaNote = t('ideas.nothing'); return showIdeas(); }
  ideaSaving = true; const r = await api('/api/idea', { action: 'capture', text, files: ideaFiles.map((f) => f.id) }).catch((e) => ({ error: String(e) })); ideaSaving = false;
  if (r.error) { ideaNote = esc(r.error); return showIdeas(); }
  ideaFiles = []; $('ideatext').value = ''; ideaNote = t('ideas.saved'); document.activeElement?.blur(); loadIdeas(); showIdeas();
}
// dictation into the capture box: the browser's live speech service, the same engine and language as the composer's mic (Settings > Voice).
// Without it (Firefox, engine "local"), Dictate records a voice note instead: the server transcribes it with the idea.
function ideaDictate() {
  if (ideaLive) { ideaLive.stopping = true; try { ideaLive.rec.stop(); } catch {} return; }
  if (!isSecureContext) { ideaNote = t('voice.https', { url: HTTPS_URL ? `<a href="${esc(HTTPS_URL)}/#ideas" dir="ltr">${esc(HTTPS_URL)}</a>` : 'https://' }); return showIdeas(); }
  if (!liveOn()) return ideaRecord();
  const ta = $('ideatext'), m = ideaLive = { base: ta.value, stopping: false };
  const run = () => {
    const rec = m.rec = new SR(); rec.lang = LIVE_LANG[liveLang()]; rec.continuous = true; rec.interimResults = true;
    rec.onresult = (e) => {   // rebuilt from the session's results each time; Android may repeat a final with new words added: keep only the longer one
      const fin = [], tail = []; for (let i = 0; i < e.results.length; i++) (e.results[i].isFinal ? fin : tail).push(e.results[i][0].transcript.trim());
      for (let i = fin.length - 1; i > 0; i--) if (ANDROID && fin[i - 1] && fin[i].startsWith(fin[i - 1])) fin.splice(i - 1, 1);
      const said = [...fin, ...tail].filter(Boolean).join(' '); $('ideatext').value = m.base + (m.base && said && !/\s$/.test(m.base) ? ' ' : '') + said; m.last = fin.join(' ');
    };
    rec.onerror = (e) => { m.err = e.error; };
    rec.onend = () => {
      if (ideaLive !== m) return;
      if (m.stopping || LIVE_FATAL[m.err]) { ideaLive = null; if (LIVE_FATAL[m.err] && !m.stopping) ideaNote = t(LIVE_FATAL[m.err]); return showIdeas(); }
      m.base = $('ideatext').value; try { run(); } catch { ideaLive = null; showIdeas(); }   // Chrome ends a session after a pause: keep listening until stopped
    };
    rec.start();
  };
  ideaNote = ''; showIdeas(true); run();
}
async function ideaRecord() {
  if (ideaRec) { ideaRec.rec.stop(); return; }
  if (!isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { ideaNote = isSecureContext ? t('voice.unsupported') : t('voice.https', { url: HTTPS_URL ? `<a href="${esc(HTTPS_URL)}/#ideas" dir="ltr">${esc(HTTPS_URL)}</a>` : 'https://' }); return showIdeas(); }
  let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }); }
  catch (x) { ideaNote = t(x.name === 'NotAllowedError' ? (TOUCH ? 'voice.deniedPhone' : 'voice.denied') : x.name === 'NotFoundError' ? 'voice.noMic' : 'voice.unsupported'); return showIdeas(); }
  const type = MIC_TYPES.find((k) => MediaRecorder.isTypeSupported?.(k)) || '', rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined), chunks = [], t0 = Date.now();
  const m = ideaRec = { rec };
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    clearInterval(m.timer); stream.getTracks().forEach((tr) => tr.stop()); ideaRec = null;
    const ms = Date.now() - t0, blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    if (ms < 700 || blob.size < 1000) { ideaNote = t('voice.empty'); return showIdeas(); }
    const ext = /ogg/.test(blob.type) ? 'ogg' : /mp4/.test(blob.type) ? 'm4a' : 'webm', id = await ideaUpload(blob, 'audio', 'voice.' + ext);
    if (id) ideaFiles.push({ id, kind: 'audio', label: micTime(ms) });
    showIdeas();
  };
  rec.start(1000); ideaNote = ''; showIdeas(true);
  m.timer = setInterval(() => { const o = $('ideas').querySelector('[data-irec] output'); if (o) o.value = micTime(Date.now() - t0); if (Date.now() - t0 >= MIC_MAX_MS) rec.stop(); }, 250);
}
async function ideaStartChat(x) {   // a NEW chat in the idea's project, on its suggested seat, the first message in the box (not sent), its photos attached
  const b = x.brief, seat = seats.find((s) => s.name === b.seat && !s.remote) ? b.seat : cur.seat;
  closeIdeas(); await pick(seat, null, b.project || null);
  if (b.project) { draftDir = b.project; $('cwd').value = b.project; } showChip();
  $('text').value = b.prep?.firstMessage || b.text || ''; caretEnd();
  const photos = x.captures.flatMap((c) => c.photos.map((f) => [c.dir, f]));
  if (photos.length) { const fs = []; for (const [d, f] of photos) { try { const r = await fetch(ideaMedia(d, f)); if (r.ok) fs.push(new File([await r.blob()], f, { type: r.headers.get('Content-Type') || 'image/jpeg' })); } catch {} } if (fs.length) await attach(fs); }
  ideaDraft = { id: x.id, seat };   // sending this draft marks the idea done and links the chat (composer onsubmit); leaving it keeps the idea ready
}
async function ideaFromShare(text, files) {   // shared from Android: images and audio become the idea's photos / voice notes (other file types stay out)
  const ids = [];
  for (const f of files) { const kind = f.type.startsWith('audio/') ? 'audio' : f.type.startsWith('image/') ? 'photo' : null; if (!kind) continue; const id = await ideaUpload(kind === 'photo' ? await shrink(f) : f, kind, f.name || kind); if (id) ids.push(id); }
  const r = await api('/api/idea', { action: 'capture', text, files: ids }).catch((e) => ({ error: String(e) }));
  ideaNote = r.error ? esc(r.error) : t('ideas.saved'); location.hash = 'ideas';
}
async function ideaAct(id, body) { const r = await api('/api/idea', { id, ...body }).catch((e) => ({ error: String(e) })); if (r.error) alert(r.error); ideaEdit = null; document.activeElement?.blur(); await loadIdeas(); showIdeas(); }
$('ideabtn').onclick = () => { if (onIdeas()) return closeIdeas(); if (location.hash === '#ideas') openIdeas(); else location.hash = 'ideas'; };
$('ideas').onclick = async (e) => {
  const g = (s) => e.target.closest(s);
  if (g('[data-iclose]')) return closeIdeas();
  if (g('[data-idrawer]')) return document.body.classList.add('drawer');
  if (g('[data-idict]')) return ideaDictate();
  if (g('[data-irec]')) return ideaRecord();
  if (g('[data-iphoto]')) return $('ideaphoto').click();
  if (g('[data-irm]')) { ideaFiles.splice(+g('[data-irm]').dataset.irm, 1); return showIdeas(); }
  const row = g('[data-idea]'); if (!row) return;
  const id = row.dataset.idea, x = ideasList.find((k) => k.id === id); if (!x) return;
  if (g('summary')) { setTimeout(() => (row.open ? ideaOpen.add(id) : ideaOpen.delete(id)), 0); return; }   // remember which cards are open across redraws
  if (g('[data-istart]')) return ideaStartChat(x);
  if (g('[data-itodo]')) return ideaAct(id, { action: 'todo' });
  if (g('[data-iedit]')) { ideaEdit = id; ideaOpen.add(id); showIdeas(true); return row.ownerDocument.querySelector(`#idea-${id} [data-f=title]`)?.focus(); }
  if (g('[data-icancel]')) { ideaEdit = null; document.activeElement?.blur(); return showIdeas(); }
  if (g('[data-isave]')) { const v = {}; row.querySelectorAll('[data-f]').forEach((i) => { v[i.dataset.f] = i.value; }); return ideaAct(id, { action: 'update', brief: v }); }
  if (g('[data-iarch]')) return ideaAct(id, { action: 'update', status: 'archived' });
  if (g('[data-ireopen]')) return ideaAct(id, { action: 'update', status: 'ready' });
  if (g('[data-iretry]')) return ideaAct(id, { action: 'retry' });
  if (g('[data-idel]')) { if (confirm(t('ideas.confirmDelete'))) return ideaAct(id, { action: 'delete' }); }
};
$('ideas').onchange = async (e) => {
  if (e.target.id === 'ideaphoto') { for (const f of [...e.target.files]) { const s = await shrink(f), id = await ideaUpload(s, 'photo', f.name || 'photo.jpg'); if (id) ideaFiles.push({ id, kind: 'photo', url: URL.createObjectURL(s) }); } e.target.value = ''; return showIdeas(true); }
  if (e.target.matches('[data-iproj]')) { const id = e.target.closest('[data-idea]').dataset.idea; return ideaAct(id, { action: 'update', brief: { project: e.target.value || null } }); }
};
$('ideas').onsubmit = (e) => { e.preventDefault(); ideaSave(); };
$('ideas').onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.id === 'ideatext') { e.preventDefault(); ideaSave(); } };
$('ideas').addEventListener('focusout', () => setTimeout(() => { if (ideasStale && onIdeas() && !ideaBusy()) showIdeas(); }, 400));
for (const ev of ['pause', 'ended']) $('ideas').addEventListener(ev, () => { if (ideasStale && onIdeas() && !ideaBusy()) showIdeas(); }, true);   // media events do not bubble: capture
loadIdeas();
