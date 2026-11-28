// Run: node console/test-desktop.mjs. Remote desktop (desktop.mjs + /ws/desktop): the pure parts (xrdp display lookup on a fake /proc, the
// "is this input" check behind the idle disconnect), the proxy with a fake x11vnc (fixtures/fake-x11vnc.mjs: no token / wrong token = 403,
// the page token = 101 and bytes flow both ways, no display = 503, idle disconnect, x11vnc stopped after the last viewer), then the real
// gate on an isolated console instance: no token / foreign Origin / no Origin = 403, the token from the page's own origin = 101 (503 when
// nobody is logged in over RDP), the noVNC files served, nothing outside them. DESKTOP_SKIP_LIVE=1 = without the instance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDesktop, findDisplay, isInput, available } from './desktop.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rows = [];
async function t(name, fn) { try { const d = await fn(); rows.push(['PASS', name, d || '']); } catch (e) { rows.push(['FAIL', name, String(e.message || e)]); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
// the raw handshake: the status line, and on 101 the socket (caller reads/destroys it)
const handshake = (port, headers) => new Promise((ok) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/ws/desktop', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': KEY, ...headers } });
  req.on('upgrade', (res, sock, head) => ok({ code: res.statusCode, sock, head })); req.on('response', (res) => { res.resume(); ok({ code: res.statusCode }); }); req.on('error', (e) => ok({ code: 'err ' + e.message })); req.end();
});
const status = async (port, headers) => { const r = await handshake(port, headers); r.sock?.destroy(); return r.code; };
const masked = (buf) => { const k = Buffer.from([1, 2, 3, 4]), d = Buffer.from(buf).map((b, i) => b ^ k[i & 3]); return Buffer.concat([Buffer.from([0x82, 0x80 | d.length]), k, d]); };
// unframes server -> client binary frames (unmasked, short payloads in these tests)
const payloads = (buf) => { const out = []; let o = 0; while (o + 2 <= buf.length) { const n = buf[o + 1] & 127; out.push({ op: buf[o] & 15, data: buf.subarray(o + 2, o + 2 + n) }); o += 2 + n; } return out; };

// ---- pure parts
if (process.platform !== 'win32') await t('findDisplay: the xrdp Xorg with a live X socket, not an Xvfb', () => {   // uid check: no process.getuid on Windows
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-proc-')), proc = path.join(w, 'proc'), xd = path.join(w, 'x');
  fs.mkdirSync(xd); for (const [pid, argv] of [['10', ['Xvfb', ':10', '-screen', '0']], ['11', ['/usr/lib/xorg/Xorg', ':11', '-auth', '.Xauthority', '-config', 'xrdp/xorg.conf']]]) { fs.mkdirSync(path.join(proc, pid), { recursive: true }); fs.writeFileSync(path.join(proc, pid, 'cmdline'), argv.join('\0') + '\0'); }
  fs.writeFileSync(path.join(xd, 'X10'), ''); assert.equal(findDisplay(proc, xd), null, 'no X11 socket yet');
  fs.writeFileSync(path.join(xd, 'X11'), ''); assert.equal(findDisplay(proc, xd), ':11');
  fs.rmSync(w, { recursive: true });
});
await t('isInput: update requests only = not input; pointer / key / mixed = input', () => {
  const fbur = Buffer.from([3, 1, 0, 0, 0, 0, 7, 128, 5, 0]);
  assert.equal(isInput(fbur), false); assert.equal(isInput(Buffer.concat([fbur, fbur])), false);
  assert.equal(isInput(Buffer.from([5, 0, 0, 10, 0, 20])), true); assert.equal(isInput(Buffer.from([4, 1, 0, 0, 0, 0, 0, 97])), true);
  assert.equal(isInput(Buffer.concat([fbur, Buffer.from([5, 0, 0, 10, 0, 20])])), true);
});

// ---- the proxy with a fake x11vnc (Linux only: x11vnc, /proc, unix sockets and uid checks; elsewhere the feature is off)
const LINUX = process.platform === 'linux';
if (!LINUX) rows.push(['SKIP', 'proxy + isolated instance', 'Linux only (' + process.platform + '): available() = ' + available()]);
if (LINUX) {
  const TOKEN = 'tok-' + 'x'.repeat(40), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-sock-')), logs = [];
  let disp = ':11';
  const d = createDesktop({ auth: (tok) => tok === TOKEN, dir, log: (l) => logs.push(l), display: () => disp, x11vnc: path.join(HERE, 'fixtures', 'fake-x11vnc.mjs'), idleMs: 600, stopMs: 300 });
  const srv = http.createServer((q, s) => s.end()).on('upgrade', (req, sock) => d.upgrade(req, sock, 'test'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  try {
    await t('proxy: no token = 403', async () => assert.equal(await status(port, {}), 403));
    await t('proxy: wrong token = 403', async () => assert.equal(await status(port, { 'Sec-WebSocket-Protocol': 'seat, nope' }), 403));
    await t('proxy: the token = 101, VNC greeting arrives, bytes echo back', async () => {
      const r = await handshake(port, { 'Sec-WebSocket-Protocol': 'seat, ' + TOKEN }); assert.equal(r.code, 101);
      let got = Buffer.from(r.head || []); r.sock.on('data', (x) => { got = Buffer.concat([got, x]); });
      for (let i = 0; i < 50 && !got.length; i++) await sleep(50);
      assert.equal(payloads(got)[0].data.toString(), 'RFB 003.008\n');
      got = Buffer.alloc(0); r.sock.write(masked(Buffer.from([5, 0, 0, 10, 0, 20])));
      for (let i = 0; i < 50 && !got.length; i++) await sleep(50);
      assert.deepEqual([...payloads(got)[0].data], [5, 0, 0, 10, 0, 20]);
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'socket folder is 0700');
      r.sock.destroy(); return logs.filter((l) => l.includes('session')).join(' | ');
    });
    await t('proxy: idle viewer disconnected, x11vnc stopped after the last one', async () => {
      const r = await handshake(port, { 'Sec-WebSocket-Protocol': 'seat, ' + TOKEN }); assert.equal(r.code, 101);
      let closed = false; r.sock.on('close', () => { closed = true; }); r.sock.resume();
      for (let i = 0; i < 40 && !closed; i++) await sleep(100);
      assert.ok(closed, 'not closed after idle'); assert.ok(logs.some((l) => /session end .*idle/.test(l)), logs.join(' | '));
      await sleep(600); assert.equal(d.status().running, false, 'x11vnc still running');
    });
    await t('proxy: no xrdp session = 503', async () => { disp = null; assert.equal(await status(port, { 'Sec-WebSocket-Protocol': 'seat, ' + TOKEN }), 503); });
  } finally { d.stop(); srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---- the real gate on an isolated instance (own port, data dir, fake claude, throwaway HOME)
if (LINUX && process.env.DESKTOP_SKIP_LIVE !== '1') {
  const PORT = await new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-desk-test-')), DATA = path.join(WORK, 'data');
  fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(path.join(WORK, 'home'), { recursive: true });
  const SEATS_JSON = path.join(WORK, 'seats.json'); fs.writeFileSync(SEATS_JSON, JSON.stringify({ projectsDir: WORK, seats: { ops: { email: 'ops@example.com', role: 'test seat' } } }));   // own seats file: a fresh clone (CI) has no seats.json
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/i.test(k))), HOME: path.join(WORK, 'home'), XAUTHORITY: process.env.XAUTHORITY || path.join(os.homedir(), '.Xauthority') };
  const fd = fs.openSync(path.join(DATA, 'server.log'), 'a');
  const srv = spawn(process.execPath, [path.join(HERE, 'server.mjs'), '--port', String(PORT), '--data', DATA, '--seats', SEATS_JSON, '--claude', path.join(HERE, 'fixtures', 'fake-claude.mjs')], { stdio: ['ignore', fd, fd], env, cwd: HERE });
  fs.closeSync(fd);
  const get = (p) => new Promise((ok) => http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { let b = ''; r.on('data', (x) => { b += x; }); r.on('end', () => ok({ code: r.statusCode, body: b })); }).on('error', (e) => ok({ code: 'err ' + e.message })));
  let TOKEN = '';
  const ORIGIN = `http://127.0.0.1:${PORT}`;
  try {
    for (let i = 0; ; i++) { try { TOKEN = fs.readFileSync(path.join(DATA, 'token.txt'), 'utf8').trim(); if (TOKEN && (await get('/health')).code === 200) break; } catch {} if (i > 200) throw new Error('server did not start'); await sleep(300); }
    const P = { 'Sec-WebSocket-Protocol': 'seat, ' + TOKEN };
    await t('server: no token = 403', async () => assert.equal(await status(PORT, { Origin: ORIGIN }), 403));
    await t('server: wrong token = 403', async () => assert.equal(await status(PORT, { Origin: ORIGIN, 'Sec-WebSocket-Protocol': 'seat, ' + 'x'.repeat(TOKEN.length) }), 403));
    await t('server: token from a foreign Origin = 403', async () => assert.equal(await status(PORT, { Origin: 'https://evil.example', ...P }), 403));
    await t('server: token without an Origin = 403', async () => assert.equal(await status(PORT, P), 403));
    await t('server: token from the page origin = 101 (503 without an RDP session)', async () => {
      const want = findDisplay() ? 101 : 503, r = await handshake(PORT, { Origin: ORIGIN, ...P }); r.sock?.destroy(); assert.equal(r.code, want); return 'display ' + findDisplay();
    });
    await t('server: /api/desktop says which display and whether the feature is available', async () => { const r = await get('/api/desktop'); assert.equal(r.code, 200); const j = JSON.parse(r.body); assert.equal(j.display, findDisplay()); assert.equal(j.available, available()); });
    await t('server: noVNC modules served, nothing outside core/ vendor/', async () => {
      assert.equal((await get('/novnc/core/rfb.js')).code, fs.existsSync('/usr/share/novnc/core/rfb.js') ? 200 : 404);   // 404 without the novnc package
      for (const p of ['/novnc/vnc.html', '/novnc/core/../../../etc/passwd', '/novnc/core/%2e%2e/%2e%2e/etc/hostname.js', '/novnc/utils/novnc_proxy']) assert.notEqual((await get(p)).code, 200, p);
    });
    // Files panel: device -> ~/Downloads (no overwrite), the recent list, server -> device; page only; never outside home or through a hidden folder
    const rq = (method, p, headers = {}, body) => new Promise((ok) => { const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, (res) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => ok({ code: res.statusCode, body: Buffer.concat(c), h: res.headers })); }); r.on('error', (e) => ok({ code: 'err ' + e.message })); r.end(body); });
    const PG = { 'X-Seat-Token': TOKEN, Origin: ORIGIN, Referer: ORIGIN + '/' }, HOMEDIR = path.join(WORK, 'home');
    await t('files: upload lands in ~/Downloads, a second one with the same name is kept apart', async () => {
      const a = await rq('POST', '/api/desktop/upload?name=' + encodeURIComponent('דוח.pdf'), PG, Buffer.from('one')), b = await rq('POST', '/api/desktop/upload?name=' + encodeURIComponent('דוח.pdf'), PG, Buffer.from('two'));
      assert.equal(a.code, 200, String(a.body)); assert.equal(JSON.parse(a.body).path, '~/Downloads/דוח.pdf'); assert.equal(JSON.parse(b.body).path, '~/Downloads/דוח (2).pdf');
      assert.equal(fs.readFileSync(path.join(HOMEDIR, 'Downloads', 'דוח.pdf'), 'utf8'), 'one'); assert.equal(fs.readFileSync(path.join(HOMEDIR, 'Downloads', 'דוח (2).pdf'), 'utf8'), 'two');
      assert.equal((await rq('POST', '/api/desktop/upload?name=x', { 'X-Seat-Token': TOKEN }, Buffer.from('x'))).code, 403, 'not from the page');
      // paste is reachable (never sent for real here: it would press Ctrl+V on the live session): a wrong type = 415, not from the page = 403
      assert.equal((await rq('POST', '/api/desktop/paste?type=text/html', PG, Buffer.from('x'))).code, 415); assert.equal((await rq('POST', '/api/desktop/paste', { 'X-Seat-Token': TOKEN }, Buffer.from('x'))).code, 403);
    });
    await t('files: recent list + download byte for byte; hidden folders, outside home and no token refused', async () => {
      const l = await rq('POST', '/api/desktop/files', PG); assert.equal(l.code, 200); assert.ok(JSON.parse(l.body).files.some((f) => f.path === '~/Downloads/דוח (2).pdf'));
      const tk = JSON.parse((await rq('POST', '/api/desktop/ticket?path=' + encodeURIComponent('~/Downloads/דוח.pdf'), PG)).body).ticket;
      const d = await rq('GET', '/api/desktop/file?ticket=' + tk); assert.equal(d.code, 200);
      assert.equal((await rq('GET', '/api/desktop/file?ticket=' + tk)).code, 404, 'a ticket is used once'); assert.equal((await rq('GET', '/api/desktop/file?path=~/Downloads/x')).code, 404, 'no ticket'); assert.equal(String(d.body), 'one'); assert.match(d.h['content-disposition'], /attachment; filename\*=UTF-8''/);
      fs.mkdirSync(path.join(HOMEDIR, '.ssh'), { recursive: true }); fs.writeFileSync(path.join(HOMEDIR, '.ssh', 'id'), 'secret');
      for (const p of ['~/.ssh/id', '/etc/hostname', '~/../../etc/hostname', '~/Downloads']) assert.equal((await rq('POST', '/api/desktop/ticket?path=' + encodeURIComponent(p), PG)).code, 404, p);
      assert.equal((await rq('POST', '/api/desktop/files', { Origin: ORIGIN, Referer: ORIGIN + '/' })).code, 403, 'no token');
    });
  } finally {
    srv.kill(); await sleep(500);
    const sockDir = path.join(process.env.XDG_RUNTIME_DIR || (fs.existsSync(`/run/user/${process.getuid()}`) ? `/run/user/${process.getuid()}` : os.tmpdir()), `seat-console-desktop-${PORT}`);   // the instance's x11vnc goes with it (exit handler); this catches a straggler
    for (const pid of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) { try { if (fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(sockDir)) process.kill(+pid); } catch {} }
    fs.rmSync(sockDir, { recursive: true, force: true }); fs.rmSync(WORK, { recursive: true, force: true });
  }
}

// ---- Paste (desktop.mjs paste): on a throwaway Xvfb, never the real session. Hebrew text and a PNG land on its clipboard byte for byte,
// and the Ctrl+V key press runs. Skipped where Xvfb / xclip / xdotool are missing (CI on Windows / macOS).
{
  const has = (b) => process.env.PATH.split(path.delimiter).some((d) => fs.existsSync(path.join(d, b)));
  if (LINUX && has('Xvfb') && has('xclip') && has('xdotool')) {
    const disp = ':' + (90 + Math.floor(Math.random() * 9)), xv = spawn('Xvfb', [disp, '-screen', '0', '640x480x24'], { stdio: 'ignore' });
    const { execFileSync } = await import('node:child_process'), env = { ...process.env, DISPLAY: disp };
    try {
      for (let i = 0; i < 50 && !fs.existsSync('/tmp/.X11-unix/X' + disp.slice(1)); i++) await sleep(100);
      const dk = createDesktop({ auth: () => true, dir: os.tmpdir(), display: () => disp });
      await t('paste: Hebrew text onto the session clipboard (UTF-8), Ctrl+V pressed', async () => {
        const text = 'שלום עולם – hello 123'; await dk.paste(Buffer.from(text), '');
        assert.equal(execFileSync('xclip', ['-selection', 'clipboard', '-o'], { env, encoding: 'utf8', timeout: 5000 }), text);
      });
      await t('paste: an image as image/png, byte for byte', async () => {
        const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex'); await dk.paste(png, 'image/png');
        assert.ok(execFileSync('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], { env, timeout: 5000 }).equals(png));
      });
      await t('paste: no RDP session = 409, nothing run', async () => {
        const none = createDesktop({ auth: () => true, dir: os.tmpdir(), display: () => null });
        await assert.rejects(none.paste(Buffer.from('x'), ''), (e) => e.status === 409);
      });
    } finally { xv.kill(); }   // its xclip exits with the display (never pkill: the real session's xclip would go too)
  }
}

console.log('| result | test | detail |\n|---|---|---|'); for (const r of rows) console.log(`| ${r.join(' | ')} |`);
const failed = rows.filter((r) => r[0] === 'FAIL').length; console.log(`\n${rows.length - failed}/${rows.length} passed`); process.exit(failed ? 1 : 0);
