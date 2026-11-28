// ---- Desktop (#desktop, rail "Desktop"): the server's own desktop (the xrdp session) in noVNC, so the owner can click something there from the
// phone, e.g. a captcha in a browser a seat opened. Server: desktop.mjs (x11vnc on demand) + /ws/desktop (Basic auth/Origin + the page token
// as the WebSocket subprotocol, no VNC password). noVNC itself (MPL-2.0) comes from the system copy as ES modules under /novnc/, loaded on
// the first open only. Touch is noVNC's own: tap = click, long press = right click, two-finger drag = scroll, pinch = Ctrl+scroll (zoom).
// Phones have no key events worth using (Gboard sends 229), so the Keyboard button focuses a hidden textarea and its text changes are typed.
var deskRfb = null, deskKeys = null, deskMods = { ctrl: false, alt: false }, deskPrev = '', deskComposing = false;   // var: app.js calls closeDesktop() early
const DESK_PAD = '        ';   // the hidden textarea always holds something, so the phone's Backspace has a character to delete (and we see it)
function onDesktop() { return document.body.classList.contains('desktop'); }
function openDesktop() {
  closeSettings(); closeProjects(); closeGuide(); closeTodos(); closeIdeas(); document.body.classList.add('desktop'); document.body.classList.remove('drawer');
  showDesktop(); deskConnect();
}
function closeDesktop() {
  if (!onDesktop()) return; if (document.fullscreenElement === DESK) deskFull(false); document.body.classList.remove('desktop'); deskStop();
  if (location.hash === '#desktop') history.replaceState(null, '', location.pathname + location.search);
}
function showDesktop() {
  $('desktop').innerHTML = `<header class="phead shead"><button type="button" class="smenu" data-ddrawer aria-label="${t('side.seats')}">☰</button><div><h2>${t('desktop.title')}</h2><small class="dk-warn">${t('desktop.warn')}</small></div><button type="button" data-dclose>${t('common.close')}</button></header>`
    + `<div class="dk-bar"><span id="dkstate" role="status"></span><button type="button" id="dkre" hidden>${t('desktop.reconnect')}</button>`
    + `<label class="dk-vo"><input type="checkbox" id="dkview"> ${t('desktop.viewOnly')}</label><button type="button" id="dkfull">${t(document.fullscreenElement === DESK ? 'desktop.exitFull' : 'desktop.fullscreen')}</button></div>`
    + `<div id="dkscreen" data-guide="desktop-screen"></div>`
    + `<div class="dk-keys" role="toolbar" aria-label="${t('desktop.keys')}"><button type="button" id="dkkb">${t('desktop.keyboard')}</button>`
    + `<button type="button" data-dmod="ctrl" aria-pressed="false">Ctrl</button><button type="button" data-dmod="alt" aria-pressed="false">Alt</button><button type="button" data-dkey="esc">Esc</button><button type="button" data-dkey="tab">Tab</button><button type="button" id="dkpaste" aria-label="${t('desktop.pasteBtn')}" title="${t('desktop.pasteBtn')}">📋<span class="dk-lbl"> ${t('desktop.pasteBtn')}</span></button><button type="button" id="dkfilesbtn" aria-label="${t('desktop.files')}" title="${t('desktop.files')}">📁<span class="dk-lbl"> ${t('desktop.files')}</span></button></div>`
    + `<textarea id="dkkbin" class="dk-kbin" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="${t('desktop.keyboard')}"></textarea>`
    + `<details class="dk-clip"><summary>${t('desktop.paste')}</summary><textarea id="dkclip" dir="auto" rows="2" placeholder="${t('desktop.pastePh')}"></textarea><button type="button" id="dkclipgo">${t('desktop.pasteSend')}</button></details>`
    + `<details class="dk-clip dk-files" id="dkfiles"><summary>${t('desktop.files')}</summary><label class="dk-up"><input type="file" id="dkupin" multiple hidden>📤 ${t('desktop.sendFile')}</label>`
    + `<small class="dk-fh">${t('desktop.recent')}</small><div id="dkflist"></div><form id="dkgetf" class="dk-get"><input id="dkpath" dir="ltr" autocapitalize="off" spellcheck="false" placeholder="${t('desktop.getPh')}" aria-label="${t('desktop.getPh')}"><button type="submit">⬇ ${t('desktop.get')}</button></form></details>`;
}
const deskState = (text, retry) => { const s = $('dkstate'); if (s) s.textContent = text; const r = $('dkre'); if (r) r.hidden = !retry; };
function deskStop() { const r = deskRfb; deskRfb = null; if (r) try { r.disconnect(); } catch {} deskMods = { ctrl: false, alt: false }; }
async function deskConnect() {
  deskStop(); deskState(t('desktop.connecting'));
  const st = await fetch('/api/desktop').then((r) => r.json(), () => null);
  if (!onDesktop()) return;
  if (!st) return deskState(t('desktop.failed'), true);
  if (!st.display) return deskState(t('desktop.none'), true);   // nobody is logged in over RDP: there is no desktop to show
  let RFB;
  try { RFB = (await import('/novnc/core/rfb.js')).default; deskKeys = (await import('/novnc/core/input/keysymdef.js')).default; } catch { return deskState(t('desktop.failed'), true); }
  if (!onDesktop() || deskRfb) return;
  const rfb = deskRfb = new RFB($('dkscreen'), `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/desktop`, { wsProtocols: ['seat', TOKEN] });
  rfb.scaleViewport = true; rfb.viewOnly = $('dkview').checked; rfb.qualityLevel = 6;
  rfb.addEventListener('connect', () => { if (deskRfb === rfb) { deskState(t('desktop.connected', { d: st.display })); deskCursorHome(); } });
  rfb.addEventListener('disconnect', () => { if (deskRfb !== rfb) return; deskRfb = null; deskState(t('desktop.disconnected'), true); });
}
// On a touch-capable device noVNC draws the remote mouse pointer on its own canvas appended to <body> (core/util/cursor.js useFallback);
// in full screen only #desktop is shown, so the pointer vanished. Keep that canvas inside the fullscreen element.
// _cursor._canvas is noVNC 1.3 internal: if it is missing nothing happens.
function deskCursorHome() {
  const c = deskRfb?._cursor?._canvas, home = document.fullscreenElement || document.body;
  if (c && c.isConnected && c.parentNode !== home) home.appendChild(c);
}
document.addEventListener('fullscreenchange', deskCursorHome);
// Phone: opening the Desktop from the rail goes straight to full screen, turned to landscape (the server's screen is wide). Only inside the
// tap: a browser allows full screen from a user gesture only, so an open from a link or a reload keeps the Full screen button.
// Full screen shows just the screen and one row of keys (app.css #desktop:fullscreen).
const DESK_TOUCH = matchMedia('(pointer: coarse)').matches;
function deskFull(on) {
  if (!on) { try { screen.orientation?.unlock?.(); } catch {} return document.exitFullscreen?.().catch(() => {}); }
  DESK.requestFullscreen?.({ navigationUI: 'hide' }).then(() => screen.orientation?.lock?.('landscape').catch(() => {}), () => {});   // lock works only in full screen, and not on every phone: a refusal changes nothing
}
document.addEventListener('fullscreenchange', () => {
  const b = document.getElementById('dkfull'); if (b) b.textContent = t(document.fullscreenElement === DESK ? 'desktop.exitFull' : 'desktop.fullscreen');
  if (!document.fullscreenElement) try { screen.orientation?.unlock?.(); } catch {}
});
// One key press on the remote, with the sticky Ctrl/Alt of the keys bar held around it; they let go after that one key (Ctrl, then C).
function deskKey(keysym, code) {
  const r = deskRfb; if (!r || r.viewOnly) return;
  const held = [['ctrl', 0xffe3, 'ControlLeft'], ['alt', 0xffe9, 'AltLeft']].filter(([m]) => deskMods[m]);
  r.sendKey(keysym, code || null);
  for (const [m, ks, c] of held) { r.sendKey(ks, c, false); deskMods[m] = false; $('desktop').querySelector(`[data-dmod="${m}"]`)?.setAttribute('aria-pressed', 'false'); }
}
// The hidden textarea: what changed since the last event is typed (removed characters = Backspace), so Gboard's word-by-word composing works.
function deskInput() {
  const el = $('dkkbin'), v = el.value; let i = 0;
  while (i < deskPrev.length && i < v.length && v[i] === deskPrev[i]) i++;
  for (let k = i; k < deskPrev.length; k++) deskKey(0xff08, 'Backspace');
  for (const ch of v.slice(i)) ch === '\n' ? deskKey(0xff0d, 'Enter') : deskKey(deskKeys.lookup(ch.codePointAt(0)));
  deskPrev = v;
  if (!deskComposing && (v.length < 4 || v.length > 60)) el.value = deskPrev = DESK_PAD;   // never reset in the middle of a composed word
}
// Paste: what the phone has copied, text or an image, goes onto the server's clipboard and is pasted there at once
// (server: /api/desktop/paste, xclip + Ctrl+V; Hebrew works). Reading the clipboard needs the browser's permission and a tap; refused or
// unsupported -> the paste box opens, its Send does the same.
async function deskPasteSend(data, type) {
  const r = await fetch('/api/desktop/paste' + (type ? '?type=' + encodeURIComponent(type) : ''), { method: 'POST', headers: { 'X-Seat-Token': TOKEN }, body: data }).catch(() => null);
  deskState(r?.ok ? t('desktop.pasteDone') : t('desktop.failed'));
}
async function deskPaste() {
  if (!deskRfb || deskRfb.viewOnly) return;
  let data = null, type = '';
  try {
    if (navigator.clipboard?.read) {
      for (const it of await navigator.clipboard.read()) {
        const img = it.types.find((x) => /^image\/(png|jpeg|gif|webp)$/.test(x));
        if (img) { data = await it.getType(img); type = img; break; }
        if (it.types.includes('text/plain')) { data = await (await it.getType('text/plain')).text(); break; }
      }
    } else data = await navigator.clipboard.readText();
  } catch { data = null; type = 'denied'; }
  if (type === 'denied' || !navigator.clipboard) { const d = $('desktop').querySelector('.dk-clip'); d.open = true; $('dkclip').focus(); return deskState(t('desktop.pasteDenied')); }
  if (!data || (typeof data === 'string' && !data.length)) return deskState(t('desktop.pasteEmpty'));
  deskPasteSend(data, type);
}
// Files: device -> server into ~/Downloads (its path lands on the server's clipboard, ready for a file dialog), and
// server -> device: the newest files in ~/Downloads and ~/Desktop, or any path under the home folder (server: /api/desktop/upload|files|file).
const deskSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
async function deskFilesList() {
  const r = await fetch('/api/desktop/files', { method: 'POST', headers: { 'X-Seat-Token': TOKEN } }).then((x) => x.json(), () => null), el = $('dkflist'); if (!el) return;
  el.innerHTML = r?.files?.length ? r.files.map((f) => `<button type="button" class="dk-f" data-dget="${esc(f.path)}"><span dir="auto">⬇ ${esc(f.name)}</span><small>${deskSize(f.size)} · ${esc(f.path.split('/')[1])}</small></button>`).join('') : `<small class="dk-fh">${t('desktop.noFiles')}</small>`;
}
async function deskUpload(files) {
  for (const f of files) {
    deskState(t('desktop.uploading', { name: f.name }));
    const r = await fetch('/api/desktop/upload?name=' + encodeURIComponent(f.name), { method: 'POST', headers: { 'X-Seat-Token': TOKEN }, body: f }).then((x) => x.json(), () => null);
    if (!r?.ok) return deskState(r?.error || t('desktop.failed'));
    deskState(t('desktop.sent', { path: r.path }));
  }
  deskFilesList();
}
async function deskDownload(p) {
  const r = await fetch('/api/desktop/ticket?path=' + encodeURIComponent(p), { method: 'POST', headers: { 'X-Seat-Token': TOKEN } }).then((x) => (x.ok ? x.json() : null), () => null);
  if (!r?.ticket) return deskState(t('desktop.notFound'));
  const a = document.createElement('a'); a.href = '/api/desktop/file?ticket=' + r.ticket; a.download = r.name; document.body.appendChild(a); a.click(); a.remove();   // the browser streams it to its downloads
  deskState(t('desktop.got', { name: r.name }));
}
// wiring at load: this file runs before app.js (so app.js can call closeDesktop at any time), hence getElementById and not app.js's $ here
const DESK = document.getElementById('desktop');
// Linux with xrdp + x11vnc + novnc only (desktop.mjs available): elsewhere the button is hidden, #desktop still says why it cannot connect.
document.getElementById('deskbtn').hidden = true;
fetch('/api/desktop').then((r) => r.json()).then((st) => { document.getElementById('deskbtn').hidden = !st.available; }, () => {});
document.getElementById('deskbtn').onclick = () => { if (onDesktop()) return closeDesktop(); if (location.hash === '#desktop') openDesktop(); else location.hash = 'desktop'; if (DESK_TOUCH) deskFull(true); };   // second click closes; a phone opens it in full screen
DESK.onclick = (e) => {
  if (e.target.closest('[data-dclose]')) return closeDesktop();
  if (e.target.closest('[data-ddrawer]')) return document.body.classList.add('drawer');
  if (e.target.id === 'dkre') return deskConnect();
  if (e.target.id === 'dkfull') return deskFull(document.fullscreenElement !== DESK);
  if (e.target.id === 'dkkb') { const el = $('dkkbin'); if (document.activeElement === el) return el.blur(); el.value = deskPrev = DESK_PAD; return el.focus(); }   // focus inside the tap: the phone opens its keyboard
  const m = e.target.closest('[data-dmod]')?.dataset.dmod;
  if (m && deskRfb && !deskRfb.viewOnly) { deskMods[m] = !deskMods[m]; e.target.setAttribute('aria-pressed', String(deskMods[m])); deskRfb.sendKey(m === 'ctrl' ? 0xffe3 : 0xffe9, m === 'ctrl' ? 'ControlLeft' : 'AltLeft', deskMods[m]); return; }
  const k = e.target.closest('[data-dkey]')?.dataset.dkey;
  if (k) return deskKey(k === 'esc' ? 0xff1b : 0xff09, k === 'esc' ? 'Escape' : 'Tab');
  if (e.target.closest('#dkpaste')) return deskPaste();
  if (e.target.closest('#dkfilesbtn')) { const d = $('dkfiles'); d.open = !d.open; return; }
  const g = e.target.closest('[data-dget]')?.dataset.dget; if (g) return deskDownload(g);
  if (e.target.id === 'dkclipgo') { const v = $('dkclip').value; if (v && deskRfb && !deskRfb.viewOnly) { $('dkclip').value = ''; deskPasteSend(v, ''); } }   // the box: same path as Paste (pasted there at once, Hebrew too)
};
DESK.onchange = (e) => { if (e.target.id === 'dkview' && deskRfb) deskRfb.viewOnly = e.target.checked; if (e.target.id === 'dkupin' && e.target.files.length) { deskUpload([...e.target.files]); e.target.value = ''; } };
DESK.addEventListener('toggle', (e) => { if (e.target.id === 'dkfiles' && e.target.open) deskFilesList(); }, true);   // the list is read each time the panel opens
DESK.addEventListener('submit', (e) => { if (e.target.id !== 'dkgetf') return; e.preventDefault(); const p = $('dkpath').value.trim(); if (p) deskDownload(p); });
// a computer: files dropped on the screen go to the server like the Send a file button
DESK.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
DESK.addEventListener('drop', (e) => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); deskUpload([...e.dataTransfer.files]); });
DESK.addEventListener('input', (e) => { if (e.target.id === 'dkkbin') deskInput(); });
DESK.addEventListener('compositionstart', () => { deskComposing = true; });
DESK.addEventListener('compositionend', () => { deskComposing = false; });
