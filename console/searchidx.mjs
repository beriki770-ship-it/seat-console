// Full-text search over every conversation (live and archived). The jsonl logs can grow to many GB, almost all tool output, so each conversation's
// readable text (the user's messages + Claude's text replies) is extracted once into search/<id>.txt and kept in memory, lower-cased.
// Incremental: a live jsonl that grew is read from the last indexed byte (whole lines only); a log that retention gzipped keeps its index
// (same bytes). The index is a cache: deleting the search/ folder only costs one rebuild.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';

export function createSearch({ data, logFile, gzPath }) {
  const dir = path.join(data, 'search'), metaFile = path.join(dir, 'index.json');
  fs.mkdirSync(dir, { recursive: true });
  let meta = {}; try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch {}
  const text = new Map();   // id -> lower-cased text
  const txtFile = (id) => path.join(dir, id + '.txt');
  const saveMeta = () => { const t = metaFile + '.tmp'; fs.writeFileSync(t, JSON.stringify(meta)); fs.renameSync(t, metaFile); };

  // One log line -> its readable text, or ''. Tool calls and results are skipped: they are the bulk and never what the user remembers.
  const lineText = (line) => {
    if (line.startsWith('{"type":"console_user"')) { try { return JSON.parse(line).text || ''; } catch { return ''; } }
    if (line.startsWith('{"type":"assistant"')) {
      try { return (JSON.parse(line).message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'); } catch { return ''; }
    }
    return '';
  };
  async function extract(stream) {
    const out = [], rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) { const t = lineText(line); if (t) out.push(t); }
    return out.join('\n');
  }

  async function refreshOne(c) {
    const id = c.id, jsonl = logFile(c), gz = gzPath(c), m = meta[id];
    let st = null; try { st = fs.statSync(jsonl); } catch {}
    if (st) {
      if (m && m.size === st.size) return false;
      const from = m && m.size >= 0 && m.size < st.size ? m.size : 0;   // -1 = indexed from the gz: a restored jsonl is read whole
      // Only up to the last newline: a half-written line is read next time.
      const fd = fs.openSync(jsonl, 'r'); let end = st.size;
      try { const tail = Buffer.alloc(Math.min(65536, st.size - from)); if (tail.length) { fs.readSync(fd, tail, 0, tail.length, st.size - tail.length); const nl = tail.lastIndexOf(10); end = nl < 0 ? from : st.size - tail.length + nl + 1; } } finally { fs.closeSync(fd); }
      if (end <= from) return false;
      const add = await extract(fs.createReadStream(jsonl, { start: from, end: end - 1 }));
      if (from === 0) fs.writeFileSync(txtFile(id), add); else if (add) fs.appendFileSync(txtFile(id), '\n' + add);
      meta[id] = { size: end };
      if (from === 0) text.set(id, add.toLowerCase()); else if (add) text.set(id, (text.get(id) ?? load(id)) + '\n' + add.toLowerCase());
      return true;
    }
    if (m || !fs.existsSync(gz)) return false;   // gzipped by retention after it was indexed: same bytes, index stands
    const t = await extract(fs.createReadStream(gz).pipe(zlib.createGunzip()));
    fs.writeFileSync(txtFile(id), t); meta[id] = { size: -1 }; text.set(id, t.toLowerCase());
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
      }
      if (changed) saveMeta();
    })();
    try { await running; } finally { running = null; }
    return true;
  }
  function forget(id) { delete meta[id]; text.delete(id); fs.rmSync(txtFile(id), { force: true }); saveMeta(); }

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
  return { refresh, query, forget, building: () => !!running };
}
