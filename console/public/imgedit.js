// Image editor for composer attachments: window.editImage(url, name) -> Promise<File | null> (null = cancelled or nothing changed).
// Edits are a list of operations in coordinates relative to the frame they were drawn on (0..1), so the same list is replayed
// on a downscaled preview while editing and on the full-resolution original at export: nothing is lost on a 12 MP photo.
(() => {
  const mk = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
  const PREVIEW_MAX = 1600, MIN_CROP = 24;

  // Replays ops on a copy of src; returns the resulting canvas.
  function render(src, ops) {
    let c = mk(src.width, src.height); c.getContext('2d').drawImage(src, 0, 0);
    for (const o of ops) {
      const W = c.width, H = c.height, m = Math.max(W, H);
      if (o.t === 'rot') { const n = mk(H, W), x = n.getContext('2d'); x.translate(H, 0); x.rotate(Math.PI / 2); x.drawImage(c, 0, 0); c = n; continue; }
      if (o.t === 'crop') {
        const sx = Math.min(W - 1, Math.round(o.x * W)), sy = Math.min(H - 1, Math.round(o.y * H)), w = Math.max(1, Math.min(W - sx, Math.round(o.w * W))), h = Math.max(1, Math.min(H - sy, Math.round(o.h * H)));
        const n = mk(w, h); n.getContext('2d').drawImage(c, sx, sy, w, h, 0, 0, w, h); c = n; continue;
      }
      const x = c.getContext('2d');
      if (o.t === 'blur') {   // pixelate: shrink the region, then enlarge it without smoothing
        const rx = Math.round(Math.min(o.a.x, o.b.x) * W), ry = Math.round(Math.min(o.a.y, o.b.y) * H), rw = Math.round(Math.abs(o.a.x - o.b.x) * W), rh = Math.round(Math.abs(o.a.y - o.b.y) * H);
        if (rw < 2 || rh < 2) continue;
        const blk = Math.max(4, 0.012 * m), s = mk(Math.max(1, Math.round(rw / blk)), Math.max(1, Math.round(rh / blk)));
        s.getContext('2d').drawImage(c, rx, ry, rw, rh, 0, 0, s.width, s.height);
        x.imageSmoothingEnabled = false; x.drawImage(s, 0, 0, s.width, s.height, rx, ry, rw, rh); x.imageSmoothingEnabled = true; continue;
      }
      x.strokeStyle = x.fillStyle = o.c; x.lineWidth = o.w * m; x.lineCap = x.lineJoin = 'round'; x.globalAlpha = o.al || 1;
      if (o.t === 'pen') { x.beginPath(); o.p.forEach((p, i) => (i ? x.lineTo(p.x * W, p.y * H) : x.moveTo(p.x * W, p.y * H))); if (o.p.length === 1) x.lineTo(o.p[0].x * W + 0.01, o.p[0].y * H); x.stroke(); }
      if (o.t === 'rect') x.strokeRect(o.a.x * W, o.a.y * H, (o.b.x - o.a.x) * W, (o.b.y - o.a.y) * H);
      if (o.t === 'arrow') {
        const ax = o.a.x * W, ay = o.a.y * H, bx = o.b.x * W, by = o.b.y * H, ang = Math.atan2(by - ay, bx - ax), hd = Math.max(o.w * m * 4, 14);
        x.beginPath(); x.moveTo(ax, ay); x.lineTo(bx, by); x.stroke();
        x.beginPath(); x.moveTo(bx, by); x.lineTo(bx - hd * Math.cos(ang - 0.45), by - hd * Math.sin(ang - 0.45)); x.lineTo(bx - hd * Math.cos(ang + 0.45), by - hd * Math.sin(ang + 0.45)); x.closePath(); x.fill();
      }
      x.globalAlpha = 1;
    }
    return c;
  }

  window.editImage = async (url, name) => {
    const bmp = await createImageBitmap(await (await fetch(url)).blob());
    const full = mk(bmp.width, bmp.height); full.getContext('2d').drawImage(bmp, 0, 0);
    const k = Math.min(1, PREVIEW_MAX / Math.max(full.width, full.height)), prev = mk(Math.round(full.width * k), Math.round(full.height * k));
    prev.getContext('2d').drawImage(full, 0, 0, prev.width, prev.height);

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#c96442';
    const COLORS = [[accent, t('imgedit.colorAccent')], ['#ffd400', t('imgedit.colorYellow')], ['#111111', t('imgedit.colorDark')]];
    const TOOLS = [['crop', 'imgedit.crop'], ['rot', 'imgedit.rotate'], ['pen', 'imgedit.pen'], ['marker', 'imgedit.marker'], ['arrow', 'imgedit.arrow'], ['rect', 'imgedit.rect'], ['blur', 'imgedit.blur']];
    const label = { crop: t('imgedit.crop'), rot: t('imgedit.rotate'), pen: t('imgedit.pen'), marker: t('imgedit.marker'), arrow: t('imgedit.arrow'), rect: t('imgedit.rect'), blur: t('imgedit.blur') };
    const opener = document.activeElement;
    const root = document.createElement('div'); root.id = 'imgedit'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', t('imgedit.edit'));
    root.innerHTML = `<div class="ie-stage"><canvas class="ie-view"></canvas><canvas class="ie-over"></canvas></div>
      <div class="ie-bar">
        <div class="ie-row" data-row="tools">${TOOLS.map(([id]) => `<button type="button" data-tool="${id}" aria-pressed="false">${label[id]}</button>`).join('')}</div>
        <div class="ie-row">${COLORS.map(([c, n], i) => `<button type="button" class="ie-col" data-col="${i}" aria-label="${n}" title="${n}" aria-pressed="${i === 0}" style="--c:${c}"></button>`).join('')}
          <button type="button" data-act="ratio" aria-pressed="false" hidden>${t('imgedit.ratio')}</button><button type="button" data-act="apply" hidden>${t('imgedit.applyCrop')}</button>
          <button type="button" data-act="undo">${t('imgedit.undo')}</button><button type="button" data-act="redo">${t('imgedit.redo')}</button><button type="button" data-act="reset">${t('imgedit.reset')}</button></div>
        <div class="ie-row"><button type="button" data-act="cancel">${t('imgedit.cancel')}</button><button type="button" class="primary" data-act="done">${t('imgedit.done')}</button></div>
      </div>`;
    document.body.appendChild(root);
    const view = root.querySelector('.ie-view'), over = root.querySelector('.ie-over'), stage = root.querySelector('.ie-stage'), $$ = (s) => [...root.querySelectorAll(s)];
    let ops = [], redo = [], tool = 'pen', col = 0, cur = prev, live = null, cr = null, lock = false, drag = null;

    const fit = () => {   // CSS size: the whole frame inside the stage, never cropped
      const s = Math.min((stage.clientWidth - 16) / cur.width, (stage.clientHeight - 16) / cur.height) || 1;
      for (const el of [view, over]) { el.style.width = Math.floor(cur.width * s) + 'px'; el.style.height = Math.floor(cur.height * s) + 'px'; }
    };
    const draw = () => {
      cur = render(prev, live ? [...ops, live] : ops); view.width = over.width = cur.width; view.height = over.height = cur.height; view.getContext('2d').drawImage(cur, 0, 0); fit();
      const g = over.getContext('2d'); g.clearRect(0, 0, over.width, over.height);
      if (tool === 'crop' && cr) {   // dim the outside, outline the keep area, 44px-ish touch handles (drawn in canvas px, so scaled by the CSS ratio)
        const u = over.width / over.getBoundingClientRect().width;
        g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, 0, over.width, over.height); g.clearRect(cr.l, cr.t, cr.r - cr.l, cr.b - cr.t);
        g.strokeStyle = '#fff'; g.lineWidth = 2 * u; g.strokeRect(cr.l, cr.t, cr.r - cr.l, cr.b - cr.t); g.fillStyle = '#fff';
        for (const [x, y] of handles()) g.fillRect(x - 7 * u, y - 7 * u, 14 * u, 14 * u);
      }
      $$('[data-act=undo]')[0].disabled = !ops.length; $$('[data-act=redo]')[0].disabled = !redo.length; $$('[data-act=reset]')[0].disabled = !ops.length;
    };
    const handles = () => { const { l, t: tp, r, b } = cr, mx = (l + r) / 2, my = (tp + b) / 2; return [[l, tp, 'lt'], [r, tp, 'rt'], [l, b, 'lb'], [r, b, 'rb'], [mx, tp, 't'], [mx, b, 'b'], [l, my, 'l'], [r, my, 'r']]; };
    const setTool = (id) => {
      tool = id; live = null; cr = id === 'crop' ? { l: cur.width * 0.05, t: cur.height * 0.05, r: cur.width * 0.95, b: cur.height * 0.95 } : null;
      $$('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === id)));
      root.querySelector('[data-act=ratio]').hidden = root.querySelector('[data-act=apply]').hidden = id !== 'crop'; draw();
    };
    const commit = (o) => { ops.push(o); redo = []; live = null; draw(); };
    const pos = (e) => { const r = over.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
    const px = (p) => ({ x: p.x * cur.width, y: p.y * cur.height });

    over.style.touchAction = 'none';
    over.addEventListener('pointerdown', (e) => {
      over.setPointerCapture(e.pointerId); const p = pos(e);
      if (tool === 'crop') {
        const q = px(p), reach = 22 * (over.width / over.getBoundingClientRect().width), hit = handles().find(([x, y]) => Math.hypot(x - q.x, y - q.y) <= reach);
        const inside = q.x > cr.l && q.x < cr.r && q.y > cr.t && q.y < cr.b;
        drag = hit ? { h: hit[2] } : inside ? { h: 'move', q, cr: { ...cr } } : null; return;
      }
      const base = { c: COLORS[col][0] };
      if (tool === 'pen') live = { ...base, t: 'pen', w: 0.006, p: [p] };
      else if (tool === 'marker') live = { ...base, t: 'pen', w: 0.026, al: 0.4, p: [p] };
      else live = { ...base, t: tool, w: 0.006, a: p, b: p };
      draw();
    });
    over.addEventListener('pointermove', (e) => {
      const p = pos(e);
      if (drag && cr) {
        const q = px(p), W = cur.width, H = cur.height, h = drag.h;
        if (h === 'move') { const dx = q.x - drag.q.x, dy = q.y - drag.q.y, w = drag.cr.r - drag.cr.l, ht = drag.cr.b - drag.cr.t; cr.l = Math.min(W - w, Math.max(0, drag.cr.l + dx)); cr.t = Math.min(H - ht, Math.max(0, drag.cr.t + dy)); cr.r = cr.l + w; cr.b = cr.t + ht; }
        else {
          if (h.includes('l')) cr.l = Math.min(q.x, cr.r - MIN_CROP); if (h.includes('r')) cr.r = Math.max(q.x, cr.l + MIN_CROP);
          if (h.includes('t')) cr.t = Math.min(q.y, cr.b - MIN_CROP); if (h.includes('b')) cr.b = Math.max(q.y, cr.t + MIN_CROP);
          if (lock && h.length === 2) {   // corner with ratio lock: width leads, height follows, the opposite corner stays put
            const ar = W / H, w0 = Math.min(cr.r - cr.l, h[0] === 'l' ? cr.r : W - cr.l, (h[1] === 't' ? cr.b : H - cr.t) * ar);
            const w = Math.max(w0, MIN_CROP); if (h[0] === 'l') cr.l = cr.r - w; else cr.r = cr.l + w; if (h[1] === 't') cr.t = cr.b - w / ar; else cr.b = cr.t + w / ar;
          }
          cr.l = Math.max(0, cr.l); cr.t = Math.max(0, cr.t); cr.r = Math.min(W, cr.r); cr.b = Math.min(H, cr.b);
        }
        draw(); return;
      }
      if (!live) return;
      if (live.p) live.p.push(p); else live.b = p; draw();
    });
    const end = () => { drag = null; if (live) commit(live); };
    over.addEventListener('pointerup', end); over.addEventListener('pointercancel', end);

    const close = (v) => { document.removeEventListener('keydown', onKey, true); removeEventListener('resize', fit); root.remove(); opener?.focus?.(); return v; };
    let finish; const result = new Promise((ok) => (finish = ok));
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(close(null)); } };
    document.addEventListener('keydown', onKey, true); addEventListener('resize', fit);

    root.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.tool === 'rot') { commit({ t: 'rot' }); if (tool === 'crop') setTool('crop'); return; }
      if (b.dataset.tool) return setTool(b.dataset.tool);
      if (b.dataset.col) { col = +b.dataset.col; $$('[data-col]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); return; }
      const a = b.dataset.act;
      if (a === 'ratio') { lock = !lock; b.setAttribute('aria-pressed', String(lock)); }
      if (a === 'apply' && cr) { commit({ t: 'crop', x: cr.l / cur.width, y: cr.t / cur.height, w: (cr.r - cr.l) / cur.width, h: (cr.b - cr.t) / cur.height }); setTool('pen'); }
      if (a === 'undo' && ops.length) { redo.push(ops.pop()); if (tool === 'crop') setTool('crop'); else draw(); }
      if (a === 'redo' && redo.length) { ops.push(redo.pop()); if (tool === 'crop') setTool('crop'); else draw(); }
      if (a === 'reset') { ops = []; redo = []; setTool(tool); }
      if (a === 'cancel') finish(close(null));
      if (a === 'done') {
        if (!ops.length) return finish(close(null));
        render(full, ops).toBlob((blob) => finish(close(blob ? new File([blob], (name || 'image').replace(/\.[^.]*$/, '').replace(/-edited$/, '') + '-edited.png', { type: 'image/png' }) : null)), 'image/png');
      }
    });
    setTool('pen'); root.querySelector('[data-act=done]').focus();
    return result;
  };
})();
