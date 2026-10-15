// Seat host link: the server side of the per-conversation HOST process (host.mjs) that owns claude.exe.
// Why: a claude.exe that is a child of the server dies with it (code deploy, supervisor restart, node crash), taking the turn with it.
// The host is spawned DETACHED, so it survives the server; the server talks to it over a 127.0.0.1 TCP port guarded by a random token.
// Files per conversation (all next to the chat log, base = logs/<seat>/<id>):
//   .host.json       {pid, port, token, claudePid}  written by the host once claude runs; its existence = "this conversation has a host"
//   .host-out        every raw stdout line of claude, appended by the host (the replay source, also readable when the host is dead)
//   .host-exit.json  {code, err} written by the host when claude exited
//   .host.log        host stdout/stderr (debug only, never holds the token)
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const paths = (base) => ({ cfg: base + '.host-cfg.json', info: base + '.host.json', out: base + '.host-out', exit: base + '.host-exit.json', log: base + '.host.log' });
export const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// Complete lines of the host's output file from byte offset `from`; `end` is the byte offset after each line (the resume point).
export function readOutFrom(file, from) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { if (e.code === 'ENOENT') return { lines: [], end: from }; throw e; }
  const lines = []; let pos = Math.min(from || 0, buf.length), i;
  while ((i = buf.indexOf(10, pos)) >= 0) { lines.push({ line: buf.toString('utf8', pos, i), end: i + 1 }); pos = i + 1; }
  return { lines, end: pos };
}

// Spawn a detached host and wait (async, up to 8 s) until it reports its port, or its claude failed to start. Returns the info record.
// Async on purpose: a blocking wait here froze every other conversation and the page for the seconds a host needs to start.
export async function spawnHost({ base, script, exe, args, cwd, env, token }) {
  const p = paths(base);
  fs.mkdirSync(path.dirname(base), { recursive: true });
  for (const f of [p.info, p.exit, p.out]) fs.rmSync(f, { force: true });
  fs.writeFileSync(p.cfg, JSON.stringify({ exe, args, cwd, token, out: p.out, info: p.info, exit: p.exit }));
  const fd = fs.openSync(p.log, 'a');
  const child = spawn(process.execPath, [script, p.cfg], { detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env });
  child.on('error', () => {}); child.unref(); fs.closeSync(fd);
  for (let i = 0; i < 160; i++) {
    const info = readJson(p.info);
    if (info) { fs.rmSync(p.cfg, { force: true }); return info; }
    const ex = readJson(p.exit); if (ex) { fs.rmSync(p.cfg, { force: true }); throw new Error(ex.err || 'claude failed to start'); }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('host did not start');
}

// Connect to a host. Output lines from byte offset `from` are replayed first, then streamed live: h.onLine(line, endOffset).
// h.onExit(code, err) when claude exited; h.onClose() when the connection dropped without that (host died); neither fires after close().
export function connectHost(info, from, h = {}) {
  const sock = net.connect(info.port, '127.0.0.1');
  let buf = '', connected = false, closing = false, exited = false, finish, fail;
  const ready = new Promise((ok, no) => { finish = ok; fail = no; });
  ready.catch(() => {});
  const timer = setTimeout(() => { fail(new Error('host handshake timeout')); sock.destroy(); }, h.timeout ?? 5000);
  sock.setEncoding('utf8');
  sock.write(JSON.stringify({ hello: info.token, from }) + '\n');
  sock.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      let m; try { m = JSON.parse(buf.slice(0, i)); } catch { m = null; }
      buf = buf.slice(i + 1); if (!m) continue;
      if (m.ok) { connected = true; clearTimeout(timer); finish(true); }
      else if (m.l !== undefined) h.onLine?.(m.l, m.o);
      else if (m.x !== undefined) { exited = true; h.onExit?.(m.x, m.err || ''); }
    }
  });
  sock.on('error', (e) => { fail(e); });
  sock.on('close', () => { clearTimeout(timer); fail(new Error('host closed')); if (connected && !closing && !exited) h.onClose?.(); });
  return {
    ready,
    get writable() { return sock.writable && !sock.destroyed; },
    write(str) { if (!sock.writable || sock.destroyed) return false; sock.write(JSON.stringify({ w: str }) + '\n'); return true; },
    kill() { if (sock.writable) sock.write(JSON.stringify({ kill: true }) + '\n'); },
    close() { closing = true; sock.destroy(); },
  };
}

// Tell a host to kill claude and exit (used for hosts whose conversation no longer exists). Resolves false if nothing answered.
export async function stopHost(info) {
  const link = connectHost(info, 1e15, { timeout: 2000 });
  try { await link.ready; link.kill(); await new Promise((r) => setTimeout(r, 400)); return true; } catch { return false; } finally { link.close(); }
}
