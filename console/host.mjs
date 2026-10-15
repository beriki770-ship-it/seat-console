// Per-conversation host: owns one claude.exe (stream-json over pipes) so it outlives the Seat Console server.
// Started detached by hostlink.spawnHost with a config file; zero dependencies. Lives exactly as long as claude does.
// The server (any number of times, one at a time) connects to 127.0.0.1:<port>, proves the token, and gets the output replayed from its offset.
import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readOutFrom } from './hostlink.mjs';
import { posixKill } from './procid.mjs';

const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const atomic = (f, o) => { fs.writeFileSync(f + '.tmp', JSON.stringify(o)); fs.renameSync(f + '.tmp', f); };
const out = fs.openSync(cfg.out, 'a');
const clients = new Set();
const send = (s, o) => { if (!s.destroyed) s.write(JSON.stringify(o) + '\n'); };
const tokenOk = (t) => { const a = Buffer.from(String(t)), b = Buffer.from(cfg.token); return a.length === b.length && crypto.timingSafeEqual(a, b); };

let child;
const WIN = process.platform === 'win32';
// tree: claude's tools are children. POSIX: claude leads its own process group (spawned detached below), so -pid kills the group.
const killClaude = () => { if (!child?.pid) return; if (WIN) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else posixKill(child.pid, true); };
const server = net.createServer((s) => {
  let buf = '', authed = false;
  const t = setTimeout(() => s.destroy(), 3000);
  s.setEncoding('utf8'); s.on('error', () => {}); s.on('close', () => { clearTimeout(t); clients.delete(s); });
  s.on('data', (d) => {
    buf += d; if (!authed && buf.length > 4096) return s.destroy();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      let m; try { m = JSON.parse(buf.slice(0, i)); } catch { m = null; } buf = buf.slice(i + 1); if (!m) continue;
      if (!authed) {
        if (!tokenOk(m.hello)) return s.destroy();
        authed = true; clearTimeout(t); send(s, { ok: true });
        for (const x of readOutFrom(cfg.out, +m.from || 0).lines) send(s, { o: x.end, l: x.line }); // synchronous: no live line can slip between replay and join
        clients.add(s);
      } else if (typeof m.w === 'string') { if (child.stdin.writable) child.stdin.write(m.w); }
      else if (m.kill) { killClaude(); setTimeout(() => process.exit(0), 100); }
    }
  });
});

server.listen(0, '127.0.0.1', () => {
  child = spawn(cfg.exe, cfg.args, { cwd: cfg.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !WIN }); // detached on Windows would open a console window
  child.on('error', (e) => { atomic(cfg.exit, { code: -1, err: e.message }); process.exit(1); });
  child.on('spawn', () => atomic(cfg.info, { pid: process.pid, port: server.address().port, token: cfg.token, claudePid: child.pid }));
  child.stdin.on('error', () => {});
  let pend = Buffer.alloc(0), err = '';
  child.stdout.on('data', (d) => {
    pend = Buffer.concat([pend, d]); let i;
    while ((i = pend.indexOf(10)) >= 0) {
      const line = pend.subarray(0, i); pend = pend.subarray(i + 1);
      fs.writeSync(out, Buffer.concat([line, Buffer.from('\n')]));
      const end = fs.fstatSync(out).size; // an append-only file: size after the write is the resume offset
      for (const s of clients) send(s, { o: end, l: line.toString('utf8') });
    }
  });
  child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  child.on('close', (code) => { // streams are drained here, so every stdout line is already in the file
    atomic(cfg.exit, { code, err });
    for (const s of clients) { send(s, { x: code, err }); s.end(); }
    setTimeout(() => process.exit(0), 300);
  });
});
