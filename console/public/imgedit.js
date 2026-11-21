// Image editor for composer attachments: window.editImage(url, name) -> Promise<File | null> (null = cancelled or nothing changed).
// Laid out like a phone gallery editor: Cancel / undo-redo / Save on top, the image fitted in the middle, a floating
// two-tab bar (Crop, Markup) at the bottom with the active tool's controls above it. Generic shapes only, no copied assets.
// Edits are a list of operations in coordinates relative to the frame they were made on (0..1). They are replayed on a downscaled preview
// while editing and on the full-resolution original at Save, so nothing is lost on a 12 MP photo. Markup lives on its own layer so the
// eraser removes markup, never the photo. Every gesture, tool change, Save and error goes to the page's diagnostics beacon (app.js diag),
// because the first version "did nothing" on a real phone while every desktop test passed.
(() => {
  const mk = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
  const PREVIEW_MAX = 1600, MIN_CROP = 24, HIT = 26, MOSAIC = 0.016;   // MIN_CROP / HIT in CSS px; MOSAIC = cell size relative to the long side
  const WIDTH = [0.004, 0.008, 0.014], TOOLW = { pen: 1, marker: 3.5, eraser: 3, mosaic: 6 };   // three sizes, scaled per tool
  const log = (e) => { try { window.diag?.({ k: 'imgedit', ...e }); } catch {} };
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const copy = (c) => { const n = mk(c.width, c.height); n.getContext('2d').drawImage(c, 0, 0); return n; };
  const stroke = (x, o, W, H) => { x.beginPath(); o.p.forEach((p, i) => (i ? x.lineTo(p.x * W, p.y * H) : x.moveTo(p.x * W, p.y * H))); if (o.p.length === 1) x.lineTo(o.p[0].x * W + 0.01, o.p[0].y * H); x.stroke(); };
  const pixCache = new WeakMap();   // photo canvas -> its pixelated copy (a live mosaic stroke would rebuild it on every move otherwise)
  const pixelated = (ph) => {
    let c = pixCache.get(ph); if (c) return c;
    const blk = Math.max(3, MOSAIC * Math.max(ph.width, ph.height)), s = mk(Math.max(1, Math.round(ph.width / blk)), Math.max(1, Math.round(ph.height / blk)));
    const sx = s.getContext('2d'); sx.imageSmoothingQuality = 'high'; sx.drawImage(ph, 0, 0, s.width, s.height); c = mk(ph.width, ph.height);   // 'high': each cell averages its area instead of sampling a few pixels
    const x = c.getContext('2d'); x.imageSmoothingEnabled = false; x.drawImage(s, 0, 0, ph.width, ph.height); pixCache.set(ph, c); return c;
  };

  // One op on the layers { ph: photo, mk: markup }. Geometry ops (rot, flip, crop) turn both layers and return new ones; markup ops paint mk.
  function apply(L, o) {
    const W = L.ph.width, H = L.ph.height, m = Math.max(W, H);
    if (o.t === 'rot' || o.t === 'flip' || o.t === 'crop') {
      const geo = (c) => {
        if (o.t === 'rot') { const n = mk(H, W), x = n.getContext('2d'); x.translate(H, 0); x.rotate(Math.PI / 2); x.drawImage(c, 0, 0); return n; }
        if (o.t === 'flip') { const n = mk(W, H), x = n.getContext('2d'); x.translate(W, 0); x.scale(-1, 1); x.drawImage(c, 0, 0); return n; }
        const sx = Math.min(W - 1, Math.round(o.x * W)), sy = Math.min(H - 1, Math.round(o.y * H)), w = Math.max(1, Math.min(W - sx, Math.round(o.w * W))), h = Math.max(1, Math.min(H - sy, Math.round(o.h * H)));
        const n = mk(w, h); n.getContext('2d').drawImage(c, sx, sy, w, h, 0, 0, w, h); return n;
      };
      return { ph: geo(L.ph), mk: geo(L.mk) };
    }
    const x = L.mk.getContext('2d'); x.lineWidth = o.w * m; x.lineCap = x.lineJoin = 'round';
    if (o.t === 'pen') { x.strokeStyle = o.c; x.globalAlpha = o.al || 1; stroke(x, o, W, H); x.globalAlpha = 1; }
    if (o.t === 'erase') { x.globalCompositeOperation = 'destination-out'; x.strokeStyle = '#000'; stroke(x, o, W, H); x.globalCompositeOperation = 'source-over'; }
    if (o.t === 'mosaic') {   // the stroke becomes a mask, the pixelated photo shows through it, on the markup layer (so the eraser can take it back)
      const mask = mk(W, H), g = mask.getContext('2d'); g.lineWidth = o.w * m; g.lineCap = g.lineJoin = 'round'; g.strokeStyle = '#000'; stroke(g, o, W, H);
      g.globalCompositeOperation = 'source-in'; g.drawImage(pixelated(L.ph), 0, 0); x.drawImage(mask, 0, 0);
    }
    return L;
  }
  const render = (src, ops) => ops.reduce(apply, { ph: copy(src), mk: mk(src.width, src.height) });
  const flat = (L) => { L.ph.getContext('2d').drawImage(L.mk, 0, 0); return L.ph; };   // in place: at Save the layers are thrown away anyway

  // 24px line icons (currentColor) for the bars; the markup tray has upright pen drawings (fill, tip in the current colour).
  const ICON = {
    undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3', redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
    crop: 'M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14', markup: 'M4 20l4-1L19 8l-3-3L5 16zM14 7l3 3M13 20h7',
    rot: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4M9 10h6v6H9z', flip: 'M12 3v18M9 7L3 17h6zM15 7l6 10h-6z',
    ratio: 'M4 6h16v12H4zM8 10v4M16 10v4', compare: 'M4 5h16v14H4zM12 3v18',
  };
  const svg = (n, cls = '') => `<svg class="ie-ico ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[n]}"/></svg>`;
  const PEN = {
    pen: '<path class="tip" d="M11 18L16 3l5 15z"/><rect class="body" x="10" y="17" width="12" height="45" rx="2"/>',
    marker: '<path class="tip ie-soft" d="M10 18l2-13 9-3 1 16z"/><rect class="body" x="8" y="17" width="16" height="45" rx="3"/>',
    eraser: '<rect class="rub" x="8" y="6" width="16" height="16" rx="3"/><rect class="body" x="8" y="20" width="16" height="42" rx="3"/>',
    mosaic: '<path class="dark" d="M10 4h4v4h-4zM18 4h4v4h-4zM14 8h4v4h-4zM10 12h4v4h-4zM18 12h4v4h-4z"/><path class="light" d="M14 4h4v4h-4zM10 8h4v4h-4zM18 8h4v4h-4zM14 12h4v4h-4z"/><rect class="body" x="10" y="17" width="12" height="45" rx="2"/>',
  };

  window.editImage = async (url, name) => {
    const srcBlob = await (await fetch(url)).blob(), bmp = await createImageBitmap(srcBlob);
    const full = mk(bmp.width, bmp.height); full.getContext('2d').drawImage(bmp, 0, 0); bmp.close();
    const k0 = Math.min(1, PREVIEW_MAX / Math.max(full.width, full.height)), prev = mk(Math.round(full.width * k0), Math.round(full.height * k0));
    prev.getContext('2d').drawImage(full, 0, 0, prev.width, prev.height);

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#c96442';
    const COLORS = [['#e5332a', 'imgedit.colorRed'], ['#ffd400', 'imgedit.colorYellow'], ['#2fb94d', 'imgedit.colorGreen'], ['#2f7cf6', 'imgedit.colorBlue'], ['#ffffff', 'imgedit.colorWhite'], ['#111111', 'imgedit.colorBlack'], [accent, 'imgedit.colorAccent']];
    const TOOLS = [['pen', t('imgedit.pen')], ['marker', t('imgedit.marker')], ['eraser', t('imgedit.eraser')], ['mosaic', t('imgedit.mosaic')]];
    const RATIOS = [['free', t('imgedit.free')], ['orig', t('imgedit.original')], ['1:1', '1:1'], ['4:3', '4:3'], ['16:9', '16:9']];

    const opener = document.activeElement;
    const root = document.createElement('div'); root.id = 'imgedit'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', t('imgedit.edit'));
    root.dataset.sid = 'image-editor'; root.dataset.title = 'Image editor: crop and markup on a composer attachment';
    root.innerHTML = `<div class="ie-col">
      <div class="ie-top">
        <button type="button" class="ie-pill" data-act="cancel">${t('imgedit.cancel')}</button>
        <div class="ie-hist"><button type="button" class="ie-icon" data-act="undo" aria-label="${t('imgedit.undo')}" title="${t('imgedit.undo')}">${svg('undo', 'ie-flip')}</button><button type="button" class="ie-icon" data-act="redo" aria-label="${t('imgedit.redo')}" title="${t('imgedit.redo')}">${svg('redo', 'ie-flip')}</button></div>
        <button type="button" class="ie-pill ie-save" data-act="save">${t('imgedit.save')}</button>
      </div>
      <div class="ie-stage"><div class="ie-frame"><canvas class="ie-view"></canvas><canvas class="ie-over"></canvas></div></div>
      <div class="ie-under">
        <button type="button" class="ie-icon ie-ratio" data-act="ratio" aria-label="${t('imgedit.aspect')}" title="${t('imgedit.aspect')}">${svg('ratio')}<bdi></bdi></button>
        <button type="button" class="ie-icon ie-compare" data-act="compare" aria-label="${t('imgedit.compare')}" title="${t('imgedit.compare')}">${svg('compare')}</button>
      </div>
      <div class="ie-tools">
        <div class="ie-panel" data-panel="crop">
          <button type="button" class="ie-icon" data-act="rot" aria-label="${t('imgedit.rotate')}" title="${t('imgedit.rotate')}">${svg('rot')}</button>
          <button type="button" class="ie-icon" data-act="flip" aria-label="${t('imgedit.flip')}" title="${t('imgedit.flip')}">${svg('flip')}</button>
        </div>
        <div class="ie-panel" data-panel="markup">
          <div class="ie-colors" hidden>${COLORS.map(([c, n], i) => `<button type="button" class="ie-dot" data-col="${i}" aria-label="${t(n)}" title="${t(n)}" aria-pressed="false" style="--c:${c}"></button>`).join('')}</div>
          <div class="ie-tray">${TOOLS.map(([id, l]) => `<button type="button" class="ie-pen" data-tool="${id}" aria-label="${l}" title="${l}" aria-pressed="false"><svg viewBox="0 0 32 64" aria-hidden="true">${PEN[id]}</svg></button>`).join('')}</div>
          <span class="ie-div"></span>
          <button type="button" class="ie-icon ie-sizebtn" data-act="size" aria-label="${t('imgedit.size')}" title="${t('imgedit.size')}"><span class="ie-sz"></span></button>
          <span class="ie-div"></span>
          <button type="button" class="ie-icon ie-colorbtn" data-act="colors" aria-label="${t('imgedit.color')}" title="${t('imgedit.color')}" aria-expanded="false"><span class="ie-ring"></span></button>
        </div>
      </div>
      <nav class="ie-tabs" role="tablist" aria-label="${t('imgedit.edit')}">${[['crop', t('imgedit.crop')], ['markup', t('imgedit.markup')]].map(([id, l]) => `<button type="button" role="tab" data-tab="${id}" aria-selected="false">${svg(id)}<span>${l}</span></button>`).join('')}</nav>
    </div>`;
    document.body.appendChild(root);
    const $ = (s) => root.querySelector(s), $$ = (s) => [...root.querySelectorAll(s)];
    const view = $('.ie-view'), over = $('.ie-over'), frame = $('.ie-frame'), stage = $('.ie-stage');
    let ops = [], redo = [], L = null, live = null, tab = '', tool = 'pen', col = 0, sz = 1, ratio = 'free', cr = null, drag = null, busy = false, scale = 1, comparing = false;
    log({ ev: 'open', img: [full.width, full.height], type: srcBlob.type, prev: [prev.width, prev.height], dpr: devicePixelRatio, vp: [innerWidth, innerHeight], vv: visualViewport ? [Math.round(visualViewport.width), Math.round(visualViewport.height)] : null, coarse: matchMedia('(pointer: coarse)').matches });

    // ---- layout + paint ----
    const W_ = () => L.ph.width, H_ = () => L.ph.height;
    const fit = () => {   // CSS size of the image: all of it inside the stage, with room around it for the crop handles
      const pad = 16, s = Math.min((stage.clientWidth - 2 * pad) / W_(), (stage.clientHeight - 2 * pad) / H_());
      scale = s > 0 ? s : 1; frame.style.width = Math.floor(W_() * scale) + 'px'; frame.style.height = Math.floor(H_() * scale) + 'px';
    };
    const rebase = () => { L = render(prev, ops); if (view.width !== W_() || view.height !== H_()) { view.width = over.width = W_(); view.height = over.height = H_(); } fit(); };
    const fullCr = () => ({ l: 0, t: 0, r: W_(), b: H_() });
    const cropDirty = () => !!cr && (cr.l > 0.5 || cr.t > 0.5 || cr.r < W_() - 0.5 || cr.b < H_() - 0.5);
    const handles = () => { const { l, t: tp, r, b } = cr, mx = (l + r) / 2, my = (tp + b) / 2; return [[l, tp, 'lt'], [r, tp, 'rt'], [l, b, 'lb'], [r, b, 'rb'], ...(ratio === 'free' ? [[mx, tp, 't'], [mx, b, 'b'], [l, my, 'l'], [r, my, 'r']] : [])]; };
    function paint() {
      const v = view.getContext('2d'), g = over.getContext('2d'); g.clearRect(0, 0, over.width, over.height);
      if (comparing) {   // the untouched original, letterboxed into the current frame size
        const s = Math.min(view.width / prev.width, view.height / prev.height), w = prev.width * s, h = prev.height * s;
        v.fillStyle = '#000'; v.fillRect(0, 0, view.width, view.height); v.drawImage(prev, (view.width - w) / 2, (view.height - h) / 2, w, h); return;
      }
      v.drawImage(L.ph, 0, 0);
      if (live) { const m = copy(L.mk); apply({ ph: L.ph, mk: m }, live); v.drawImage(m, 0, 0); } else v.drawImage(L.mk, 0, 0);
      if (tab === 'crop' && cr) {   // dim outside, white frame, white corner L-handles (edge bars when free), thirds grid only while dragging
        const u = 1 / scale, w = cr.r - cr.l, h = cr.b - cr.t;
        g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(0, 0, over.width, over.height); g.clearRect(cr.l, cr.t, w, h);
        if (drag) { g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = u; g.beginPath(); for (const f of [1 / 3, 2 / 3]) { g.moveTo(cr.l + w * f, cr.t); g.lineTo(cr.l + w * f, cr.b); g.moveTo(cr.l, cr.t + h * f); g.lineTo(cr.r, cr.t + h * f); } g.stroke(); }
        g.strokeStyle = '#fff'; g.lineWidth = u; g.strokeRect(cr.l, cr.t, w, h);
        g.lineWidth = 4 * u; g.lineCap = 'square'; const C = Math.min(22 * u, w / 3, h / 3), E = Math.min(12 * u, w / 4, h / 4); g.beginPath();
        for (const [x, y, id] of handles()) {
          // drawn just inside the frame: at the image edge the canvas would clip anything outside it
          if (id.length === 2) { const sx = id[0] === 'l' ? 1 : -1, sy = id[1] === 't' ? 1 : -1, ox = x + sx * 2 * u, oy = y + sy * 2 * u; g.moveTo(ox, oy + sy * C); g.lineTo(ox, oy); g.lineTo(ox + sx * C, oy); }
          else if (id === 't' || id === 'b') { const oy = y + (id === 't' ? 2 : -2) * u; g.moveTo(x - E, oy); g.lineTo(x + E, oy); } else { const ox = x + (id === 'l' ? 2 : -2) * u; g.moveTo(ox, y - E); g.lineTo(ox, y + E); }
        }
        g.stroke();
      }
      $('[data-act=undo]').disabled = !(ops.length || cropDirty()); $('[data-act=redo]').disabled = !redo.length;
      $('[data-act=save]').disabled = busy || !(ops.length || cropDirty());
    }
    const commit = (o) => { ops.push(o); redo = []; live = null; rebase(); };

    // ---- crop ----
    const commitCrop = () => { if (cropDirty()) { const W = W_(), H = H_(); commit({ t: 'crop', x: cr.l / W, y: cr.t / H, w: (cr.r - cr.l) / W, h: (cr.b - cr.t) / H }); log({ ev: 'crop', ops: ops.length }); } cr = fullCr(); };
    const ratioOf = (id) => {   // width / height, turned to the image's orientation (4:3 on a portrait screenshot means 3:4)
      if (id === 'free') return null; if (id === 'orig') return W_() / H_();
      const [a, b] = id.split(':').map(Number), r = a / b; return W_() >= H_() ? r : 1 / r;
    };
    const setRatio = (id) => {
      ratio = id; $('.ie-ratio bdi').textContent = RATIOS.find((x) => x[0] === id)[1];
      const r = ratioOf(id); if (r) {   // the largest frame of that ratio, centred on the current frame
        const W = W_(), H = H_(), w = Math.min(W, H * r), h = w / r, cx = (cr.l + cr.r) / 2, cy = (cr.t + cr.b) / 2;
        cr.l = Math.min(W - w, Math.max(0, cx - w / 2)); cr.t = Math.min(H - h, Math.max(0, cy - h / 2)); cr.r = cr.l + w; cr.b = cr.t + h;
      }
      paint();
    };

    // ---- tabs + markup controls ----
    const setTab = (id) => {
      if (id === tab) return; if (tab === 'crop') commitCrop();
      tab = id; live = null; cr = id === 'crop' ? fullCr() : null; if (id === 'crop') setRatio('free');
      $$('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
      $$('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== id)); root.dataset.tab = id; showColors(false);
      log({ ev: 'tab', tab: id }); paint();
    };
    const setTool = (id) => { tool = id; $$('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === id))); };
    const setCol = (i) => { col = i; root.style.setProperty('--ie-cur', COLORS[i][0]); $$('[data-col]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.col === i))); };
    const setSize = (i) => { sz = i; root.dataset.size = i; };
    const showColors = (on) => { $('.ie-colors').hidden = !on; $('[data-act=colors]').setAttribute('aria-expanded', String(on)); };

    // ---- pointer on the image (touch, pen, mouse alike). One pointer at a time; a second finger is ignored. Listened on the stage, not the
    // canvas, so a finger landing just outside the image edge still grabs a crop corner. No preventDefault on pointerdown: on Android Chrome
    // that swallowed the click of the NEXT tap (Save after a stroke did nothing); touch-action:none on the stage already stops scroll/zoom. ----
    const pos = (e) => { const r = over.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
    let pt = null, raf = 0;   // the gesture in progress, also what gets logged; raf: one repaint per frame while a finger moves
    const paintSoon = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); }); };
    stage.addEventListener('pointerdown', (e) => {
      if (pt || (e.pointerType === 'mouse' && e.button !== 0)) return;
      try { stage.setPointerCapture(e.pointerId); } catch {}
      showColors(false);
      const p = pos(e); pt = { id: e.pointerId, type: e.pointerType, n: 0, a: p, b: p };
      if (tab === 'crop') {
        const q = { x: p.x * W_(), y: p.y * H_() }, reach = HIT / scale, hit = handles().find(([x, y]) => Math.hypot(x - q.x, y - q.y) <= reach);
        const inside = q.x > cr.l && q.x < cr.r && q.y > cr.t && q.y < cr.b;
        drag = hit ? { h: hit[2] } : inside ? { h: 'move', q, cr: { ...cr } } : null; pt.h = drag?.h || null;
      } else {
        const w = WIDTH[sz] * TOOLW[tool];
        live = tool === 'pen' ? { t: 'pen', c: COLORS[col][0], w, p: [p] } : tool === 'marker' ? { t: 'pen', c: COLORS[col][0], w, al: 0.4, p: [p] } : { t: tool === 'eraser' ? 'erase' : 'mosaic', w, p: [p] };
      }
      paint();
    });
    stage.addEventListener('pointermove', (e) => {
      if (!pt || e.pointerId !== pt.id) return;
      const p = pos(e); pt.n++; pt.b = p;
      if (drag && cr) {
        const q = { x: p.x * W_(), y: p.y * H_() }, W = W_(), H = H_(), h = drag.h, r = ratioOf(ratio), mn = MIN_CROP / scale;
        if (h === 'move') { const dx = q.x - drag.q.x, dy = q.y - drag.q.y, w = drag.cr.r - drag.cr.l, ht = drag.cr.b - drag.cr.t; cr.l = Math.min(W - w, Math.max(0, drag.cr.l + dx)); cr.t = Math.min(H - ht, Math.max(0, drag.cr.t + dy)); cr.r = cr.l + w; cr.b = cr.t + ht; }
        else if (r) {   // corner with a fixed ratio: the opposite corner stays put, the larger pull leads, both sides clamped to the image
          const ox = h[0] === 'l' ? cr.r : cr.l, oy = h[1] === 't' ? cr.b : cr.t, maxW = Math.min(h[0] === 'l' ? ox : W - ox, (h[1] === 't' ? oy : H - oy) * r);
          const w = Math.min(maxW, Math.max(mn, Math.abs(q.x - ox), Math.abs(q.y - oy) * r)), ht = w / r;
          if (h[0] === 'l') cr.l = ox - w; else cr.r = ox + w; if (h[1] === 't') cr.t = oy - ht; else cr.b = oy + ht;
        } else {
          if (h.includes('l')) cr.l = Math.max(0, Math.min(q.x, cr.r - mn)); if (h.includes('r')) cr.r = Math.min(W, Math.max(q.x, cr.l + mn));
          if (h.includes('t')) cr.t = Math.max(0, Math.min(q.y, cr.b - mn)); if (h.includes('b')) cr.b = Math.min(H, Math.max(q.y, cr.t + mn));
        }
        paintSoon(); return;
      }
      if (live) { live.p.push(p); paintSoon(); }
    });
    const end = (e) => {
      if (!pt || e.pointerId !== pt.id) return;
      const g = pt; pt = null; drag = null; cancelAnimationFrame(raf); raf = 0;
      if (live) commit(live); paint();
      const r = over.getBoundingClientRect();
      log({ ev: 'ptr', end: e.type, tab, tool: tab === 'markup' ? tool : undefined, h: g.h, type: g.type, n: g.n, a: [r3(g.a.x), r3(g.a.y)], b: [r3(g.b.x), r3(g.b.y)], css: [Math.round(r.width), Math.round(r.height)], canvas: [W_(), H_()], ops: ops.length });
    };
    stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);

    // Compare: the original shows only while the button is held.
    const cmp = $('[data-act=compare]');
    const cmpOn = (e) => { e.preventDefault(); comparing = true; cmp.setAttribute('aria-pressed', 'true'); paint(); log({ ev: 'compare', type: e.pointerType || 'key' }); };
    const cmpOff = () => { if (!comparing) return; comparing = false; cmp.setAttribute('aria-pressed', 'false'); paint(); };
    cmp.addEventListener('pointerdown', cmpOn); for (const k of ['pointerup', 'pointercancel', 'pointerleave']) cmp.addEventListener(k, cmpOff);
    cmp.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) cmpOn(e); }); cmp.addEventListener('keyup', cmpOff);
    cmp.addEventListener('contextmenu', (e) => e.preventDefault());   // a long press must not open the phone's context menu

    // ---- history, close, save ----
    const undo = () => {
      if (tab === 'crop' && cropDirty()) { cr = fullCr(); return setRatio('free'); }
      if (!ops.length) return; redo.push(ops.pop()); rebase(); if (tab === 'crop') { cr = fullCr(); setRatio('free'); } else paint(); log({ ev: 'undo', ops: ops.length });
    };
    const redoIt = () => { if (!redo.length) return; ops.push(redo.pop()); rebase(); if (tab === 'crop') { cr = fullCr(); setRatio('free'); } else paint(); log({ ev: 'redo', ops: ops.length }); };
    const onErr = (e) => {   // the message only for errors in this file: another script's message can quote user text
      const src = String(e.filename || '').split('/').pop(), own = src === 'imgedit.js';
      log({ ev: 'err', name: e.error?.name || e.reason?.name || e.type, m: own ? String(e.message).slice(0, 200) : undefined, src, line: e.lineno });
    };
    const relayout = () => { fit(); paint(); };
    const close = (v) => {
      document.removeEventListener('keydown', onKey, true); removeEventListener('resize', relayout); visualViewport?.removeEventListener('resize', relayout);
      removeEventListener('error', onErr); removeEventListener('unhandledrejection', onErr); root.remove(); opener?.focus?.(); return v;
    };
    let finish; const result = new Promise((ok) => (finish = ok));
    const cancel = () => {
      if ((ops.length || cropDirty()) && !confirm(t('imgedit.discard'))) return;
      log({ ev: 'cancel', ops: ops.length }); finish(close(null));
    };
    const save = async () => {
      if (busy) return; if (tab === 'crop') { commitCrop(); paint(); }
      if (!ops.length) { log({ ev: 'save', result: 'nochange' }); return finish(close(null)); }
      busy = true; paint(); const t0 = performance.now();
      const type = /^image\/(jpeg|webp)$/.test(srcBlob.type) ? srcBlob.type : 'image/png', ext = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' }[type];
      try {
        const out = flat(render(full, ops)), blob = await new Promise((ok) => out.toBlob(ok, type, 0.92));
        if (!blob) throw new Error('toBlob returned null');
        log({ ev: 'save', result: 'ok', out: [out.width, out.height], bytes: blob.size, ops: ops.length, ms: Math.round(performance.now() - t0) });
        finish(close(new File([blob], (name || 'image').replace(/\.[^.]*$/, '').replace(/-edited$/, '') + '-edited.' + ext, { type })));
      } catch (err) { busy = false; paint(); log({ ev: 'save', result: 'error', m: String(err?.message || err).slice(0, 200) }); alert(t('imgedit.saveFailed')); }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!$('.ie-colors').hidden) return showColors(false); return cancel(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) redoIt(); else undo(); }
    };
    document.addEventListener('keydown', onKey, true); addEventListener('resize', relayout); visualViewport?.addEventListener('resize', relayout);
    addEventListener('error', onErr); addEventListener('unhandledrejection', onErr);

    // Buttons: a finger acts on pointerup (same button, no slide), mouse and keyboard on click. Measured in Chrome touch emulation: a tap
    // within ~0.3 s of a stroke on the image produced pointerdown/pointerup but no click in about half the runs, so the button did nothing.
    let down = null, tapped = null;   // tapped: the button a finger already activated; its click (which may only come after a confirm()) is skipped
    root.addEventListener('pointerdown', (e) => { tapped = null; down = e.pointerType !== 'mouse' && e.target.closest?.('button') ? { b: e.target.closest('button'), id: e.pointerId, x: e.clientX, y: e.clientY } : null; });
    root.addEventListener('pointerup', (e) => {
      const d = down; down = null; if (!d || e.pointerId !== d.id || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12) return;
      if (document.elementFromPoint(e.clientX, e.clientY)?.closest('button') !== d.b) return;   // touch is captured by the down target: check where the finger let go
      tapped = d.b; act(d.b);
    });
    root.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (tapped === b) { tapped = null; return; }   // the click that follows a handled tap
      act(b);
    });
    function act(b) {
      if (b.disabled) return;
      if (b.dataset.tab) return setTab(b.dataset.tab);
      if (b.dataset.tool) { setTool(b.dataset.tool); showColors(false); return log({ ev: 'tool', tool }); }
      if (b.dataset.col) { setCol(+b.dataset.col); return showColors(false); }
      const a = b.dataset.act;
      if (a === 'rot' || a === 'flip') { commitCrop(); commit({ t: a }); cr = fullCr(); setRatio(ratio); log({ ev: a, ops: ops.length }); }
      if (a === 'ratio') { const i = RATIOS.findIndex((x) => x[0] === ratio); cr = cr || fullCr(); setRatio(RATIOS[(i + 1) % RATIOS.length][0]); log({ ev: 'ratio', ratio }); }
      if (a === 'size') setSize((sz + 1) % WIDTH.length);
      if (a === 'colors') showColors($('.ie-colors').hidden);
      if (a === 'undo') undo();
      if (a === 'redo') redoIt();
      if (a === 'cancel') cancel();
      if (a === 'save') save();
    }

    rebase(); setCol(0); setSize(1); setTool('pen'); setTab('markup'); $('[data-act=cancel]').focus();
    return result;
  };
})();
