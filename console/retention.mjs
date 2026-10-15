// Log retention. A conversation that is archived, or idle for more than 14 days, has its jsonl chat log (and a leftover host-out file) gzipped into
// logs/archive/<seat>/<id>.jsonl.gz. NOTHING is ever deleted without the user: the gz is verified (decompressed byte count == original size) before the original goes.
// Loading such a conversation reads the .gz transparently (readLogText); the next event appended to it restores the jsonl first (restoreLog).
// Also swept: console/test-data/smoke-* run folders older than 2 days and upload folders whose conversation no longer exists.
// CLI: `node console/retention.mjs --dry-run [--data <dir>]` reports bytes before/after on that data dir without touching anything (the server does the real run).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { paths, pidAlive, readJson } from './hostlink.mjs';

export const IDLE_DAYS = 14, TEST_DATA_DAYS = 2, DAY = 864e5;
const archiveDir = (data, seat) => path.join(data, 'logs', 'archive', seat);
export const gzPath = (data, c) => path.join(archiveDir(data, c.seat), c.id + '.jsonl.gz');

// The chat log as text: the live .jsonl, else the archived .gz. null = no log at all.
export function readLogText(file, gz) {
  if (fs.existsSync(file)) return { text: fs.readFileSync(file, 'utf8'), fromGz: false };
  if (fs.existsSync(gz)) return { text: zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8'), fromGz: true };
  return null;
}
// Put the jsonl back from the archive (before a new event is appended to an archived conversation). false = nothing to restore. A live jsonl is never overwritten.
export function restoreLog(file, gz) {
  if (fs.existsSync(file) || !fs.existsSync(gz)) return false;
  const tmp = file + '.restore'; fs.writeFileSync(tmp, zlib.gunzipSync(fs.readFileSync(gz))); fs.renameSync(tmp, file); fs.rmSync(gz, { force: true });
  return true;
}
// Everything archived for a deleted conversation.
export function purgeArchive(data, c) {
  try { for (const f of fs.readdirSync(archiveDir(data, c.seat))) if (f.startsWith(c.id + '.')) fs.rmSync(path.join(archiveDir(data, c.seat), f), { force: true }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

const countTo = (box) => new Writable({ write(chunk, _enc, cb) { box.n += chunk.length; cb(); } });
// Gzip src (its first `size` bytes). dest = a file to write, or null = only measure the compressed size.
async function gzipSize(src, size, dest) {
  const box = { n: 0 };
  await pipeline(fs.createReadStream(src, { end: size - 1 }), zlib.createGzip({ level: 6 }), dest ? fs.createWriteStream(dest) : countTo(box));
  return dest ? fs.statSync(dest).size : box.n;
}
async function gunzippedSize(file) { const box = { n: 0 }; await pipeline(fs.createReadStream(file), zlib.createGunzip(), countTo(box)); return box.n; }

// Walk a folder for its total byte size (missing = 0).
export function dirBytes(dir) {
  let n = 0;
  try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); n += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size; } } catch {}
  return n;
}

// What a run would do. busy(c) = the server's view of a conversation that is live or in flight; the file checks (live host, working flag) also apply without a server (the CLI).
export function planRetention({ data, state, now = Date.now(), busy = () => false, testDataDir = null }) {
  const files = [], orphanUploads = [], testData = [];
  for (const c of Object.values(state.conversations || {})) {
    const base = path.join(data, 'logs', c.seat, c.id), jsonl = base + '.jsonl';
    let st; try { st = fs.statSync(jsonl); } catch { continue; }
    if (!st.size) continue;
    const idle = now - Math.max(c.updatedAt || 0, st.mtimeMs);
    const why = c.archived ? 'archived' : idle > IDLE_DAYS * DAY ? `idle ${Math.floor(idle / DAY)} d` : null;
    if (!why || c.working || c.interrupted || c.bg?.length || busy(c)) continue;
    if (readJson(paths(base).info)) continue;                       // a host record (alive or not) belongs to the server's reattach logic; checked again tomorrow
    files.push({ seat: c.seat, id: c.id, why, from: jsonl, to: gzPath(data, c), size: st.size });
    const out = paths(base).out;
    try { const s = fs.statSync(out); if (s.size) files.push({ seat: c.seat, id: c.id, why, from: out, to: path.join(archiveDir(data, c.seat), c.id + '.host-out.gz'), size: s.size }); } catch {}
  }
  try {
    for (const e of fs.readdirSync(path.join(data, 'uploads'), { withFileTypes: true })) {
      const p = path.join(data, 'uploads', e.name);
      if (e.isDirectory() && /^[0-9a-f-]{36}$/.test(e.name) && !Object.hasOwn(state.conversations || {}, e.name) && now - fs.statSync(p).mtimeMs > DAY) orphanUploads.push({ path: p, size: dirBytes(p) });
    }
  } catch {}
  if (testDataDir) try {
    for (const e of fs.readdirSync(testDataDir, { withFileTypes: true })) {
      // Only smoke-run folders: test-data itself is the persistent TEST instance's data dir (start-test.ps1: state.json, token.txt, logs/, routines.json).
      if (!e.isDirectory() || !e.name.startsWith('smoke-')) continue;
      const p = path.join(testDataDir, e.name), s = fs.statSync(p);
      if (now - s.mtimeMs > TEST_DATA_DAYS * DAY) testData.push({ path: p, size: e.isDirectory() ? dirBytes(p) : s.size });
    }
  } catch {}
  return { files, orphanUploads, testData };
}

// dryRun measures the gz size of every candidate without writing. Otherwise: gzip -> verify -> (same tick) size unchanged? -> rename + remove the original.
// onCompressed(seat, id, file) fires right after the original is gone (the server flags the conversation so its next append restores the jsonl).
export async function runRetention({ data, state, now = Date.now(), dryRun = false, busy, testDataDir = null, onCompressed = () => {}, log = () => {} }) {
  const plan = planRetention({ data, state, now, busy, testDataDir });
  const rep = { dryRun, compressed: [], skipped: [], orphanUploads: plan.orphanUploads, testData: plan.testData, logsBefore: dirBytes(path.join(data, 'logs')) };
  for (const f of plan.files) {
    // An archive already there (a restore that failed half-way, a corrupt gz kept for the user) may hold the only full history: never overwrite it, leave both for a person.
    if (fs.existsSync(f.to)) { rep.skipped.push({ ...f, reason: 'archive already exists' }); log(`[retention] ${path.basename(f.from)} kept as is: ${path.basename(f.to)} already exists`); continue; } // not "skipped": the digest counts that word as an error, and this repeats daily by design
    try {
      if (dryRun) { rep.compressed.push({ ...f, before: f.size, after: await gzipSize(f.from, f.size, null) }); continue; }
      fs.mkdirSync(path.dirname(f.to), { recursive: true });
      const tmp = f.to + '.tmp', after = await gzipSize(f.from, f.size, tmp);
      { const fd = fs.openSync(tmp, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }   // on disk before the original is deleted: a power cut must not lose both copies
      if (await gunzippedSize(tmp) !== f.size) throw new Error('verification failed: decompressed size differs');
      // Appends are synchronous on the same event loop, so this check and the removal below cannot be interleaved with one.
      if (fs.statSync(f.from).size !== f.size) { fs.rmSync(tmp, { force: true }); rep.skipped.push({ ...f, reason: 'changed while compressing' }); continue; }
      fs.renameSync(tmp, f.to);
      // The gz is complete now. A locked original (EBUSY) is harmless, the jsonl still wins on read: keep it and move on.
      try { fs.rmSync(f.from, { force: true }); } catch (e) { log(`[retention] ${path.basename(f.from)} archived, original still locked (${e.code || e.message}), kept`); continue; }
      onCompressed(f.seat, f.id, f.from);
      rep.compressed.push({ ...f, before: f.size, after });
      log(`[retention] ${f.seat}/${path.basename(f.from)} ${f.why}: ${f.size} -> ${after} bytes`);
    } catch (e) { fs.rmSync(f.to + '.tmp', { force: true }); rep.skipped.push({ ...f, reason: e.message }); log(`[retention] ${path.basename(f.from)} skipped: ${e.message}`); }
  }
  if (!dryRun) for (const x of [...plan.orphanUploads, ...plan.testData]) { try { fs.rmSync(x.path, { recursive: true, force: true }); log(`[retention] removed ${x.path}`); } catch (e) { log(`[retention] could not remove ${x.path}: ${e.message}`); } }
  rep.saved = rep.compressed.reduce((n, f) => n + f.before - f.after, 0);
  return rep;
}

// ---- CLI: node console/retention.mjs --dry-run [--data <dir>] ----
const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const HERE = path.dirname(fileURLToPath(import.meta.url)), i = process.argv.indexOf('--data');
  const data = i > 0 ? path.resolve(process.argv[i + 1]) : HERE;
  if (!process.argv.includes('--dry-run')) { console.log('usage: node console/retention.mjs --dry-run [--data <dir>]   (the real run is the server\'s: at start and daily 04:00)'); process.exit(2); }
  const state = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
  const rep = await runRetention({ data, state, dryRun: true, testDataDir: data === HERE ? path.join(HERE, 'test-data') : null });
  console.log(`retention dry run on ${data}  (nothing was changed)`);
  for (const f of rep.compressed) console.log(`  ${f.seat.padEnd(7)} ${f.id.slice(0, 8)} ${path.basename(f.from).replace(f.id, '').padEnd(10)} ${f.why.padEnd(12)} ${mb(f.before).padStart(10)} -> ${mb(f.after).padStart(9)}`);
  if (!rep.compressed.length) console.log('  no conversation is archived or idle for more than 14 days');
  for (const x of rep.orphanUploads) console.log(`  orphan upload folder ${x.path} ${mb(x.size)}`);
  for (const x of rep.testData) console.log(`  test-data leftover ${x.path} ${mb(x.size)}`);
  const before = rep.logsBefore, drop = rep.saved;
  console.log(`logs dir: ${mb(before)} before, ${mb(before - drop)} after (saves ${mb(drop)}); candidates: ${rep.compressed.length} files; orphan uploads ${rep.orphanUploads.length}; test-data entries ${rep.testData.length} (${mb(rep.testData.reduce((n, x) => n + x.size, 0))})`);
}
