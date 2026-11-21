// Full-text search over every conversation (live and archived). The jsonl logs can grow to many GB, almost all tool output, so each conversation's
// readable text (the user's messages + Claude's text replies) is extracted once into search/<id>.txt and kept in memory, lower-cased.
// Incremental: a live jsonl that grew is read from the last indexed byte (whole lines only); a log that retention gzipped keeps its index
// (same bytes). The index is a cache: deleting the search/ folder only costs one rebuild.
// The same pass collects which files each conversation's tool calls touched (touched.mjs) into search/<id>.touched.json, paths under
// `root` only: the base of "Related" on a project page. meta[id].t is how far that went (a log indexed before it existed is read once more).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { lineTouched } from './touched.mjs';

export function createSearch({ data, logFile, gzPath, root = '/' }) {
  const dir = path.join(data, 'search'), metaFile = path.join(dir, 'index.json');
  fs.mkdirSync(dir, { recursive: true });
  let meta = {}; try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch {}
  const text = new Map();   // id -> lower-cased text
  const touch = new Map();   // id -> Map(path -> 'w' | 'r')
  const txtFile = (id) => path.join(dir, id + '.txt'), touchFile = (id) => path.join(dir, id + '.touched.json');
  const under = root.replace(/\/$/, '') + '/';
  const saveMeta = () => { const t = metaFile + '.tmp'; fs.writeFileSync(t, JSON.stringify(meta)); fs.renameSync(t, metaFile); };

  // One log line -> its readable text, or ''. Tool calls and results are skipped: they are the bulk and never what the user remembers.
  const lineText = (line) => {
    if (line.startsWith('{"type":"console_user"')) { try { return JSON.parse(line).text || ''; } catch { return ''; } }
    if (line.startsWith('{"type":"assistant"')) {
      try { return (JSON.parse(line).message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'); } catch { return ''; }
    }
    return '';
  };
  // text false: only the touched files are collected (into paths, a Map; a write wins over a read). Returns whether paths changed.
  async function extract(stream, { text = true, paths = null } = {}) {
    const out = [], rl = readline.createInterface({ input: stream, crlfDelay: Infinity }); let grew = false;
    for await (const line of rl) {
      if (text) { const t = lineText(line); if (t) out.push(t); }
      if (paths) for (const { path: p, kind } of lineTouched(line)) if (p.startsWith(under) && paths.get(p) !== 'w' && paths.get(p) !== kind) { paths.set(p, kind); grew = true; }
    }
    return { text: out.join('\n'), grew };
  }
  const loadTouch = (id) => { let m = new Map(); try { m = new Map(Object.entries(JSON.parse(fs.readFileSync(touchFile(id), 'utf8')))); } catch {} touch.set(id, m); return m; };
  const saveTouch = (id, m) => fs.writeFileSync(touchFile(id), JSON.stringify(Object.fromEntries(m)));

  async function refreshOne(c) {
    const id = c.id, jsonl = logFile(c), gz = gzPath(c), m = meta[id];
    let st = null; try { st = fs.statSync(jsonl); } catch {}
    if (st) {
      if (m && m.size === st.size && m.t === st.size) return false;
      const from = m && m.size >= 0 && m.size <= st.size ? m.size : 0;   // -1 = indexed from the gz: a restored jsonl is read whole
      const tFrom = Math.min(from, m && m.t >= 0 ? m.t : 0);   // touched lags behind the text only for a log indexed before it existed
      // Only up to the last newline: a half-written line is read next time.
      const fd = fs.openSync(jsonl, 'r'); let end = st.size;
      try { const tail = Buffer.alloc(Math.min(65536, st.size - from)); if (tail.length) { fs.readSync(fd, tail, 0, tail.length, st.size - tail.length); const nl = tail.lastIndexOf(10); end = nl < 0 ? from : st.size - tail.length + nl + 1; } } finally { fs.closeSync(fd); }
      const paths = tFrom === 0 ? new Map() : (touch.get(id) ?? loadTouch(id)); let grew = tFrom === 0 && m?.t !== 0;
      if (tFrom < from) grew = (await extract(fs.createReadStream(jsonl, { start: tFrom, end: from - 1 }), { text: false, paths })).grew || grew;
      let add = '';
      if (end > from) { const x = await extract(fs.createReadStream(jsonl, { start: from, end: end - 1 }), { paths }); add = x.text; grew = x.grew || grew; }
      if (grew) { saveTouch(id, paths); paths.ver = (paths.ver || 0) + 1; } touch.set(id, paths);   // ver: a read that became a write changes no size
      if (end <= from) { meta[id] = { size: from, t: from }; return tFrom < from; }
      if (from === 0) fs.writeFileSync(txtFile(id), add); else if (add) fs.appendFileSync(txtFile(id), '\n' + add);
      meta[id] = { size: end, t: end };
      if (from === 0) text.set(id, add.toLowerCase()); else if (add) text.set(id, (text.get(id) ?? load(id)) + '\n' + add.toLowerCase());
      return true;
    }
    if ((m && m.t !== undefined) || !fs.existsSync(gz)) return false;   // gzipped by retention after it was indexed: same bytes, index stands
    const paths = new Map(), x = await extract(fs.createReadStream(gz).pipe(zlib.createGunzip()), { text: !m, paths });   // text indexed already: touched only
    if (!m) { fs.writeFileSync(txtFile(id), x.text); text.set(id, x.text.toLowerCase()); }
    saveTouch(id, paths); touch.set(id, paths); meta[id] = { size: m ? m.size : -1, t: -1 };
    return true;
  }
  const load = (id) => { let t = ''; try { t = fs.readFileSync(txtFile(id), 'utf8').toLowerCase(); } catch {} text.set(id, t); return t; };

  let running = null;
  // Bring the index up to date for these conversations. One pass at a time; a caller during a pass waits for it, then runs its own.
  // wait false: if a pass is already running (the startup build), return at once and search what is indexed so far.
  async function refresh(convs, { wait = true } = {}) {
    if (running && !wait) return false;
    while (running) await running.catch(() => {});
    running = (async () => {
      let changed = 0;
      for (const c of convs) {
        try { if (await refreshOne(c) && ++changed % 10 === 0) saveMeta(); } catch (e) { console.log(`[search] ${c.id.slice(0, 8)}: ${e.message}`); }
        if (!text.has(c.id)) load(c.id);
        if (!touch.has(c.id)) loadTouch(c.id);
        await new Promise((r) => setImmediate(r));   // the first build reads every log: other requests get their turn between files
      }
      if (changed) saveMeta();
    })();
    try { await running; } finally { running = null; }
    return true;
  }
  function forget(id) { delete meta[id]; text.delete(id); touch.delete(id); fs.rmSync(txtFile(id), { force: true }); fs.rmSync(touchFile(id), { force: true }); saveMeta(); }

  // Every word must appear (in the title or the text). Title hits first, then the most recent.
  function query(q, convs, limit = 60) {
    const words = String(q).toLowerCase().split(/\s+/).filter(Boolean); if (!words.length) return [];
    const hits = [];
    for (const c of convs) {
      const title = String(c.title || '').toLowerCase(), body = text.get(c.id) || '';
      if (words.every((w) => title.includes(w) || body.includes(w))) hits.push({ id: c.id, inTitle: words.every((w) => title.includes(w)), snippet: '', updatedAt: c.updatedAt || 0 });
    }
    hits.sort((x, y) => (y.inTitle - x.inTitle) || (y.updatedAt - x.updatedAt));
    const top = hits.slice(0, limit);
    for (const h of top) {   // snippets only for what is returned: the original casing is read from disk
      const body = text.get(h.id) || '', w = words.find((x) => body.includes(x)); if (!w) continue;
      const i = body.indexOf(w), a = Math.max(0, i - 60), b = Math.min(body.length, i + w.length + 100);
      let src = body; try { const o = fs.readFileSync(txtFile(h.id), 'utf8'); if (o.length === body.length) src = o; } catch {}
      h.snippet = (a ? '…' : '') + src.slice(a, b).replace(/\s+/g, ' ') + (b < body.length ? '…' : '');
    }
    return top;
  }
  return { refresh, query, forget, touched: (id) => touch.get(id) || null, building: () => !!running };
}
