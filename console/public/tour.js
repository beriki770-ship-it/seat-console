// Guided tours over the live page: "Show me" on each Guide section, "Take the full tour", and the one-time "quick tour?" question on a fresh install.
// Targets are [data-guide="..."] attributes, never CSS classes, so a tour survives a redesign of the sidebar. A target that is not on the page right now
// (no chat waiting, no run in this folder) is shown as a centred card with a note, never an error.
// Loaded BEFORE app.js so it can see whether this browser has been here before (app.js stores 'seat' on its first paint). Everything else it uses
// (t, $, pick, openSettings, allConvs, multiData, ...) is app.js's and is only touched once a tour runs. Wrapped so none of its names clash with app.js.
(() => {
  const firstVisit = localStorage.getItem('seat') == null;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const narrow = () => matchMedia('(max-width: 700px)').matches;   // app.css: the sidebar is a drawer below 700px
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const inView = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth; };
  const find = (k) => [...document.querySelectorAll(`[data-guide="${k}"]`)].find(inView);

  // ---- where a step needs the page to be ----
  const side = async () => { if (narrow()) document.body.classList.add('drawer'); };   // phone: the sidebar slides in
  const main = async () => document.body.classList.remove('drawer');
  const hashTo = (h) => { if (location.hash === h) openHash(); else location.hash = h; };
  const toDraft = async () => { await main(); if (cur.id || onProjects() || onSettings() || onGuide()) await pick(cur.seat, null); };   // the new-chat composer
  const toSettings = async (tab) => { await main(); setTab = tab; setNote = null; if (location.hash === '#settings') await openSettings(); else location.hash = 'settings'; };
  const folder = () => projCtx || projDir || multiData.folders?.[0]?.dir || null;
  const toProject = async () => { await main(); const d = folder(); if (d) hashTo('#project/' + encodeURIComponent(d)); };
  const toChatInProject = async () => {   // a conversation opened from its project page, so the project bar is on top
    await main(); const d = folder(); if (!d) return;
    let r = null; try { r = await api('/api/project?dir=' + encodeURIComponent(d)); } catch {}
    const c = r?.convs?.[0]; hashTo(`#project/${encodeURIComponent(d)}/${c ? 'c/' + c.id : 'new'}`);
  };
  const openMenu = async () => { await side(); const c = allConvs().find((x) => !x.archived && !x.remote); if (c && menuFor !== c.id) { menuFor = c.id; showSeats(); } };
  const openWaiting = async () => { await main(); const c = allConvs().find((x) => x.pending); if (c && c.id !== cur.id) await pick(c.seat, c.id); };

  // ---- the tours: k = data-guide target, h = title key (an existing button name where one exists), p = text key, go = get the page there first ----
  const S = {
    seat: { k: 'seat', h: 'tour.seat.h', p: 'tour.seat.p', go: side },
    usage: { k: 'usage', h: 'tour.usage.h', p: 'tour.usage.p', go: side },
    foldall: { k: 'foldall', h: 'side.foldAll', p: 'tour.foldall.p', go: side },
    new: { k: 'new', h: 'side.newConversation', p: 'tour.new.p', go: side },
    folder: { k: 'folder', h: 'composer.projectAuto', p: 'tour.folder.p', go: toDraft },
    mode: { k: 'mode', h: 'composer.mode', p: 'tour.mode.p', go: toDraft },
    model: { k: 'model', h: 'composer.model', p: 'tour.model.p', go: toDraft },
    effort: { k: 'effort', h: 'composer.effort', p: 'tour.effort.p', go: toDraft },
    attach: { k: 'attach', h: 'composer.attach', p: 'tour.attach.p', go: toDraft },
    stop: { k: 'stop', h: 'composer.stop', p: 'tour.stop.p', go: main },
    needs: { k: 'needs', h: 'tour.needs.h', p: 'tour.needs.p', go: side },
    perm: { k: 'perm', h: 'tour.perm.h', p: 'tour.perm.p', go: openWaiting },
    reply: { k: 'reply', h: 'tour.reply.h', p: 'tour.reply.p', go: main },
    menu: { k: 'convmenu', h: 'conv.menu', p: 'tour.menu.p', go: openMenu },
    keep: { k: 'keep', h: 'conv.keep', p: 'tour.keep.p', go: openMenu },
    archive: { k: 'archive', h: 'conv.archive', p: 'tour.archive.p', go: openMenu },
    archiveDone: { k: 'archive-done', h: 'set.usage.archiveDone', p: 'tour.archiveDone.p', go: () => toSettings('usage') },
    archiveDays: { k: 'archive-days', h: 'set.usage.archive', p: 'tour.archiveDays.p', go: () => toSettings('usage') },
    search: { k: 'search', h: 'side.searchLabel', p: 'tour.search.p', go: side },
    projOpen: { k: 'projects-open', h: 'projects.open', p: 'tour.projOpen.p', go: side },
    folders: { k: 'folders', h: 'projects.title', p: 'tour.folders.p', go: async () => { await main(); hashTo('#projects'); } },
    openProject: { k: 'open-project', h: 'projects.openProject', p: 'tour.openProject.p', go: async () => { await main(); hashTo('#projects'); } },
    runForm: { k: 'run-form', h: 'projects.startRun', p: 'tour.runForm.p', go: async () => { await main(); hashTo('#projects'); } },
    pjNeeds: { k: 'pj-needs', h: 'project.needs', p: 'tour.pjNeeds.p', go: toProject },
    pjWorking: { k: 'pj-working', h: 'project.working', p: 'tour.pjWorking.p', go: toProject },
    pjRuns: { k: 'pj-runs', h: 'project.runs', p: 'tour.pjRuns.p', go: toProject },
    pjHappening: { k: 'pj-happening', h: 'project.happening', p: 'tour.pjHappening.p', go: toProject },
    pbar: { k: 'pbar', h: 'tour.pbar.h', p: 'tour.pbar.p', go: toChatInProject },
    pbMove: { k: 'pb-move', h: 'conv.moveProject', p: 'tour.pbMove.p', go: toChatInProject },
    settings: { k: 'settings', h: 'set.title', p: 'tour.settings.p', go: side },
    lang: { k: 'set-lang', h: 'set.lang.title', p: 'tour.lang.p', go: () => toSettings('start') },
    tabUsage: { k: 'tab-usage', h: 'set.tab.usage', p: 'tour.tabUsage.p', go: () => toSettings('start') },
    fresh: { k: 'set-fresh', h: 'set.proj.fresh', p: 'tour.fresh.p', go: () => toSettings('projects') },
  };
  // One tour per Guide section (the keys of GUIDE in app.js); "full" chains the main ones.
  const TOURS = {
    seats: ['seat', 'usage', 'foldall'], start: ['new', 'folder', 'mode', 'model', 'effort', 'attach'], folder: ['folder'], attach: ['attach', 'stop'],
    approve: ['needs', 'perm', 'reply'], keep: ['menu', 'keep', 'archive', 'archiveDone'], auto: ['archiveDone', 'archiveDays'], search: ['search'],
    projects: ['projOpen', 'folders', 'openProject'], runs: ['runForm'], project: ['pjNeeds', 'pjWorking', 'pjRuns', 'pjHappening'], ctx: ['pbar', 'pbMove'],
    settings: ['settings', 'lang', 'tabUsage', 'fresh'],
  };
  TOURS.full = [...TOURS.seats, ...TOURS.start, 'menu', 'keep', 'archive', ...TOURS.search, ...TOURS.projects, ...TOURS.project, ...TOURS.ctx, ...TOURS.settings];

  // ---- the overlay: a dim layer with a cut-out around the target (one box-shadow), and a callout beside it ----
  let steps = [], at = 0, root = null, target = null, before = null, seq = 0;
  function build() {
    root = document.createElement('div'); root.className = 'tour'; root.dataset.sid = 'tour'; root.dataset.title = 'Guided tour over the live page';
    root.innerHTML = `<div class="tour-hole" aria-hidden="true"></div><div class="tour-tip" role="dialog" aria-modal="true" aria-labelledby="tour-h" aria-describedby="tour-p" tabindex="-1">`
      + `<small class="tour-n"></small><h3 id="tour-h"></h3><p id="tour-p"></p><p class="tour-miss" hidden></p>`
      + `<div class="tour-acts"><button type="button" data-tback></button><button type="button" class="primary" data-tnext></button></div>`
      + `<button type="button" class="tour-x" data-tclose>×</button></div>`;
    root.addEventListener('click', (e) => { if (e.target.closest('[data-tclose]')) end(); else if (e.target.closest('[data-tback]')) show(at - 1); else if (e.target.closest('[data-tnext]')) { if (at < steps.length - 1) show(at + 1); else end(); } });
    document.body.appendChild(root); root.querySelector('.tour-tip').focus({ preventScroll: true });   // focus inside the callout from the start, also while a step loads
  }
  // Below the target if it fits, else above, else centred; always inside the window. Centred too when the target is missing.
  function place() {
    if (!root) return;
    const hole = root.querySelector('.tour-hole'), tip = root.querySelector('.tour-tip'), m = 12, W = innerWidth, H = innerHeight;
    const r = target && target.isConnected && inView(target) ? target.getBoundingClientRect() : null;
    hole.hidden = !r; root.classList.toggle('tour-dim', !r);   // no target: the whole page is dimmed instead of cut out
    if (r) { const pad = 6; Object.assign(hole.style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' }); }
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = (W - tw) / 2, y = (H - th) / 2;
    if (r) {
      x = Math.min(Math.max(m, r.left + r.width / 2 - tw / 2), W - tw - m);
      y = r.bottom + 14 + th <= H - m ? r.bottom + 14 : r.top - 14 - th >= m ? r.top - 14 - th : Math.min(H - th - m, Math.max(m, r.bottom - th));
    }
    tip.style.left = Math.max(m, x) + 'px'; tip.style.top = Math.max(m, y) + 'px';
  }
  async function show(i) {
    if (i < 0 || i >= steps.length) return;
    const my = ++seq, s = S[steps[i]]; at = i;
    const tip = root.querySelector('.tour-tip'); tip.setAttribute('aria-busy', 'true');
    try { await s.go?.(); } catch {}
    target = null;
    for (let w = 0; w < 30 && my === seq; w++) { target = find(s.k); if (target) break; await sleep(100); }   // pages load their data: up to 3 s
    for (let w = 0, prev = ''; target && w < 15 && my === seq; w++) {   // wait until it stops moving (the phone drawer slides in)
      const b = target.getBoundingClientRect(), now = `${b.left},${b.top},${b.width},${b.height}`; if (now === prev) break; prev = now; await sleep(60);
    }
    if (my !== seq || !root) return;
    if (target) target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
    root.querySelector('.tour-n').textContent = t('tour.step', { n: num(i + 1), total: num(steps.length) });
    root.querySelector('#tour-h').textContent = t(s.h);
    root.querySelector('#tour-p').textContent = t(s.p);
    const miss = root.querySelector('.tour-miss'); miss.hidden = !!target; miss.textContent = t('tour.missing');
    const back = root.querySelector('[data-tback]'); back.textContent = t('tour.back'); back.hidden = i === 0;
    root.querySelector('[data-tnext]').textContent = t(i === steps.length - 1 ? 'tour.done' : 'tour.next');
    root.querySelector('[data-tclose]').setAttribute('aria-label', t('common.close'));
    tip.removeAttribute('aria-busy'); place(); if (!reduced()) setTimeout(place, 350);   // after the smooth scroll settles
    root.querySelector('[data-tnext]').focus({ preventScroll: true });
  }
  function onKey(e) {
    if (!root) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return end(); }
    if (e.key === 'Tab') {   // focus stays inside the callout
      const f = [...root.querySelectorAll('.tour-tip button:not([hidden])')], i = f.indexOf(document.activeElement);
      e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    }
  }
  function end() {
    seq++; if (!root) return;
    root.remove(); root = null; target = null;
    removeEventListener('keydown', onKey, true); removeEventListener('resize', place); removeEventListener('scroll', place, true);
    if (menuFor) { menuFor = null; showSeats(); }   // a ⋯ menu the tour opened
    document.body.classList.remove('drawer');
    (before?.isConnected ? before : $('guidebtn')).focus({ preventScroll: true });   // "Show me" was inside the Guide, which is gone by now
  }
  window.startTour = (name) => {
    if (!TOURS[name]) return;
    end(); before = document.activeElement; closeGuide();
    steps = TOURS[name]; build();
    addEventListener('keydown', onKey, true); addEventListener('resize', place); addEventListener('scroll', place, true);
    show(0);
  };

  // ---- the first-run question. Answer kept per install in settings.json (guideOffered: 'later' | 'done'), mirrored in localStorage in case the save fails.
  // Asked when nothing was answered yet AND (no conversation exists OR this browser has never opened the console): a fresh install, or a new device.
  // An existing install seen from a known browser is never asked. "Not now" = 'later': asked once more in a later browser session, then never. ----
  const answer = (v) => {
    try { localStorage.setItem('guideOffered', v); sessionStorage.setItem('guideAsked', '1'); } catch {}
    if (setData?.settings) setData.settings.guideOffered = v;
    if (draft) draft.guideOffered = v;   // a Settings page already open must not save the old answer back
    api('/api/settings', { settings: { guideOffered: v } }).catch(() => {});
  };
  window.offerTour = () => {
    const vals = [setData?.settings?.guideOffered, localStorage.getItem('guideOffered')];
    if (vals.includes('done')) return;
    if (vals.includes('later') ? sessionStorage.getItem('guideAsked') : !(firstVisit || !allConvs().length)) return;
    const d = document.createElement('dialog'), later = vals.includes('later');
    d.className = 'tourask'; d.dataset.sid = 'tour-offer'; d.dataset.title = 'First run: would you like a quick tour?';
    d.setAttribute('aria-labelledby', 'tourask-h'); d.setAttribute('aria-describedby', 'tourask-p');
    d.innerHTML = `<h2 id="tourask-h">${t('tour.ask.h')}</h2><p id="tourask-p">${t('tour.ask.p')}</p>`
      + (later ? '' : `<label class="tourask-never"><input type="checkbox"> ${t('tour.ask.never')}</label>`)
      + `<div class="tour-acts"><button type="button" data-no>${t('tour.ask.no')}</button><button type="button" class="primary" data-yes>${t('tour.ask.yes')}</button></div>`;
    const close = (yes) => {
      const never = d.querySelector('input')?.checked;
      answer(yes || never || later ? 'done' : 'later'); d.close(); d.remove();
      if (yes) startTour('full');
    };
    d.addEventListener('click', (e) => { if (e.target.closest('[data-yes]')) close(true); else if (e.target.closest('[data-no]')) close(false); });
    d.addEventListener('cancel', (e) => { e.preventDefault(); close(false); });   // Esc = Not now
    document.body.appendChild(d); d.showModal(); d.querySelector('[data-yes]').focus();
  };
})();
