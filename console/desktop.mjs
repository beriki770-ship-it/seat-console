// Remote desktop in the console (rail "Desktop", page public/desktop.js + noVNC from /usr/share/novnc). Linux only: the owner's interactive
// desktop is an xrdp session (Xorg started by xrdp; its display number can change per xrdp login), so the display is looked up at every
// connect. Without xrdp, x11vnc or the novnc package (and on Windows / macOS) status().available is false and the page hides the button. x11vnc is attached to it on demand and listens on a UNIX socket in a 0700 folder only (-rfbport 0 = no TCP port at all):
// no VNC port exists on any interface and no VNC password is needed, because only this OS user can open the socket and that user can
// already reach the X display. The gate is the console's own: Basic auth / Host / Origin (server.mjs gate) + the page token as the
// WebSocket subprotocol. x11vnc stops a few minutes after the last viewer left; a viewer with no input for 30 minutes is disconnected.
import { spawn, execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { wsServe } from './roll.mjs';

// The display of the xrdp session: an Xorg whose command line names xrdp's config, with a live X socket. null = nobody is logged in over RDP.
export function findDisplay(proc = '/proc', xdir = '/tmp/.X11-unix') {
  let pids = []; try { pids = fs.readdirSync(proc).filter((d) => /^\d+$/.test(d)); } catch { return null; }
  for (const pid of pids) {
    let argv; try { argv = fs.readFileSync(path.join(proc, pid, 'cmdline'), 'utf8').split('\0'); } catch { continue; }
    if (!/(^|\/)Xorg$/.test(argv[0]) || !argv.some((a) => a.includes('xrdp'))) continue;
    try { if (fs.statSync(path.join(proc, pid)).uid !== process.getuid()) continue; } catch { continue; }   // only our own user's session
    const d = argv.find((a) => /^:\d+$/.test(a));
    if (d && fs.existsSync(path.join(xdir, 'X' + d.slice(1)))) return d;
  }
  return null;
}

// Can this machine show its desktop at all: Linux with x11vnc on PATH and the novnc package's ES modules (server.mjs serves /novnc/ from there).
// Checked once per x11vnc name; the page hides the Desktop button when this is false.
const availableCache = new Map();
export function available(x11vnc = 'x11vnc') {
  if (process.platform !== 'linux') return false;
  if (!availableCache.has(x11vnc)) {
    let vnc = false; try { vnc = x11vnc.includes('/') ? fs.existsSync(x11vnc) : !!execFileSync('/bin/sh', ['-c', 'command -v "$0"', x11vnc], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
    availableCache.set(x11vnc, vnc && fs.existsSync('/usr/share/novnc/core/rfb.js'));
  }
  return availableCache.get(x11vnc);
}

// Files between the device and the server (the Desktop page's Files panel). Only under the home folder and never through a hidden folder
// (.ssh, .config...): homePath answers the real path, or null.
export function homePath(home, p) {
  let root, real; try { root = fs.realpathSync(home); real = fs.realpathSync(path.resolve(root, String(p || '').trim().replace(/^~(?=$|\/)/, root))); } catch { return null; }
  const rel = path.relative(root, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).some((s) => s.startsWith('.'))) return null;
  return real;
}
// The newest files (not folders) in ~/Downloads and ~/Desktop, for the "get from the server" list
export function recentFiles(home, dirs = ['Downloads', 'Desktop'], n = 30) {
  const out = [];
  for (const d of dirs) { let names = []; try { names = fs.readdirSync(path.join(home, d)); } catch { continue; }
    for (const name of names) { if (name.startsWith('.')) continue; try { const st = fs.statSync(path.join(home, d, name)); if (st.isFile()) out.push({ path: `~/${d}/${name}`, name, size: st.size, mtime: st.mtimeMs }); } catch {} } }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, n);
}
// A file name from the device, made safe and not overwriting anything: "photo.jpg" -> "photo (2).jpg" when taken
export function freeName(dir, name) {
  let n = path.basename(String(name || '')).replace(/[\u0000-\u001f\/\\]/g, '_').replace(/^\.+/, '').trim().slice(0, 180) || 'file';
  const ext = path.extname(n), stem = n.slice(0, n.length - ext.length);
  for (let i = 2; fs.existsSync(path.join(dir, n)); i++) n = `${stem} (${i})${ext}`;
  return n;
}

// A viewer is "doing something" when its message holds more than FramebufferUpdateRequests (type 3, 10 bytes each), which noVNC sends all
// the time while it only watches. Key, pointer and clipboard messages count, so the idle disconnect hits a forgotten tab, not someone reading.
export const isInput = (b) => !(b.length && b.length % 10 === 0 && [...Array(b.length / 10)].every((_, i) => b[i * 10] === 3));

export function createDesktop({ auth, dir, log = () => {}, display = () => findDisplay(), x11vnc = 'x11vnc', idleMs = 30 * 60000, stopMs = 5 * 60000 }) {
  let vnc = null, stopTimer = null, starting = null;   // vnc = { proc, display, sock }; starting = the ensure() in flight (a reload while x11vnc starts must not kill it)
  const viewers = new Set();
  const stopVnc = (why) => { if (!vnc) return; log(`[desktop] x11vnc on ${vnc.display} stopped (${why})`); try { vnc.proc.kill(); } catch {} vnc = null; };
  function ensure(disp) {
    clearTimeout(stopTimer);
    if (vnc && vnc.display === disp && vnc.proc.exitCode === null && fs.existsSync(vnc.sock)) return Promise.resolve(vnc.sock);
    if (!starting) starting = start(disp).finally(() => { starting = null; });
    return starting;
  }
  async function start(disp) {
    stopVnc('display changed');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // the folder's mode is what keeps other users off the socket: a real folder of ours, 0700 (on a shared /tmp someone could have made it first)
    const st = fs.lstatSync(dir); if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077)) throw new Error('unsafe socket folder ' + dir);
    const sock = path.join(dir, 'vnc.sock'); try { fs.unlinkSync(sock); } catch {}
    // an x11vnc left behind by a console that was killed (supervisor restart) still holds the display: end it before starting ours
    for (const pid of (fs.existsSync('/proc') ? fs.readdirSync('/proc') : []).filter((d) => /^\d+$/.test(d))) { try { const a = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); if (/(^|\/)x11vnc$/.test(a[0]) && a[a.indexOf('-unixsock') + 1] === sock) process.kill(+pid); } catch {} }
    const proc = spawn(x11vnc, ['-display', disp, '-unixsock', sock, '-rfbport', '0', '-shared', '-forever', '-nopw', '-noxdamage', '-quiet'], { stdio: 'ignore' });
    const me = { proc, display: disp, sock }; vnc = me;
    proc.on('exit', (code) => { if (vnc === me) { vnc = null; log(`[desktop] x11vnc on ${disp} exited (${code})`); } });
    proc.on('error', () => {});
    for (let i = 0; i < 80 && proc.exitCode === null; i++) { if (fs.existsSync(sock)) { log(`[desktop] x11vnc attached to ${disp}`); return sock; } await new Promise((r) => setTimeout(r, 100)); }
    if (vnc === me) stopVnc('did not start'); throw new Error('x11vnc did not start');
  }
  const refuse = (socket, code, text) => socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  // from = where the viewer connects from, for the audit line (server.mjs: address + forwarding headers).
  async function upgrade(req, socket, from = '?') {
    const key = req.headers['sec-websocket-key'], protos = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());
    if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket' || !auth(protos[1] || '')) return refuse(socket, 403, 'Forbidden');
    const disp = display(); if (!disp) return refuse(socket, 503, 'No Desktop Session');
    if (viewers.size >= 4) return refuse(socket, 503, 'Too Many Viewers');   // a phone and a PC, plus reloads: more is a loop or misuse
    let sock; try { sock = await ensure(disp); } catch { return refuse(socket, 503, 'Service Unavailable'); }
    if (socket.destroyed) return;
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: seat\r\n\r\n`);
    socket.setNoDelay(true); socket.setKeepAlive(true, 20000);
    const me = { t0: Date.now(), last: Date.now() }, vncConn = net.connect(sock);
    let why = 'closed';
    const ws = wsServe(socket, (m) => { if (typeof m === 'string') return; if (isInput(m)) me.last = Date.now(); if (!vncConn.write(m) && !socket.isPaused()) { socket.pause(); vncConn.once('drain', () => socket.resume()); } }, () => end(why), 4 << 20);
    const end = (reason) => {
      if (!viewers.delete(me)) return; clearInterval(me.idle); vncConn.destroy(); ws.close(); socket.resume();   // a socket paused by backpressure must still read the client's close
      log(`[desktop] session end ${disp} from ${from} after ${Math.round((Date.now() - me.t0) / 1000)} s (${reason})`);
      if (!viewers.size) { clearTimeout(stopTimer); stopTimer = setTimeout(() => { if (!viewers.size) stopVnc('no viewer'); }, stopMs); }
    };
    viewers.add(me); log(`[desktop] session start ${disp} from ${from}`);
    me.idle = setInterval(() => { if (Date.now() - me.last > idleMs) { why = 'idle'; ws.close(4000); end('idle'); } }, Math.min(60000, idleMs / 2));
    vncConn.on('data', (d) => { if (ws.bin(d) === false && !vncConn.isPaused()) { vncConn.pause(); socket.once('drain', () => vncConn.resume()); } });   // a slow phone link: hold the VNC side, never buffer without end
    vncConn.on('close', () => { why = 'vnc closed'; ws.close(); end(why); });
    vncConn.on('error', () => {});
  }
  // Paste from the phone straight into the server: the text or image goes onto the X clipboard of the RDP session with xclip (UTF-8, so
  // non-Latin text survives: the VNC clipboard message is Latin-1 only), then xdotool presses Ctrl+V there. xclip stays in the background
  // serving the clipboard until something else takes it, as a copy on that desktop would. press:false = clipboard only (the Files panel).
  async function paste(data, type, { press = true } = {}) {
    const d = display(); if (!d) throw Object.assign(new Error('nobody is logged in over RDP'), { status: 409 });
    const env = { ...process.env, DISPLAY: d };
    await new Promise((ok, no) => {
      const p = spawn('xclip', ['-selection', 'clipboard', ...(type ? ['-t', type] : []), '-i'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
      p.on('error', no); p.on('exit', (c) => (c === 0 ? ok() : no(new Error('xclip exited ' + c)))); p.stdin.end(data);
    });
    if (press) await new Promise((ok, no) => execFile('xdotool', ['key', '--clearmodifiers', 'ctrl+v'], { env, timeout: 5000 }, (e) => (e ? no(e) : ok())));
    log(`[desktop] ${press ? 'pasted' : 'clipboard set,'} ${data.length} bytes${type ? ' ' + type : ''} on ${d}`);
  }
  return { upgrade, paste, status: () => ({ available: available(x11vnc), display: display(), running: !!vnc, viewers: viewers.size }), stop: () => { clearTimeout(stopTimer); stopVnc('console exit'); } };
}
