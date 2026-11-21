// Seat Console service worker. Exists so the browser offers "Install app"; it also keeps the static shell so a dead server shows a message, not Chrome's offline page.
// Network-first. Only the shell files below are ever stored: /api/* (incl. the SSE stream), the token (index.html carries it per run) and every non-GET are never cached.
const CACHE = 'seat-console-shell-v2';   // v2: the manifest gained share_target (2026-11-21)
const SHARE = 'seat-console-share';   // files shared into the app from Android's share sheet, waiting for the page to pick them up
const SHELL = ['/app.css', '/app.js', '/paths.js', '/manifest.webmanifest', '/icon-192.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== SHARE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });

const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Seat Console</title>
<body style="font:16px system-ui;background:#faf9f5;color:#1f1e1d;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center">
<div><h1 style="font-size:20px">Server not reachable</h1><p style="color:#73726c">Is the PC on, and is Tailscale connected?</p><button onclick="location.reload()" style="font:inherit;padding:8px 16px">Try again</button></div>`;

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  // Web Share Target (manifest share_target): Android POSTs the shared files here. They are parked in a cache and the app opens with ?share=1;
  // the page then uploads them through the normal Attach path with its token. The server never takes this POST (no token = 403), so this opens no
  // upload without the page's token.
  if (req.method === 'POST' && url.origin === location.origin && url.pathname === '/share-target') { e.respondWith(takeShare(req)); return; }
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;   // browser handles it, uncached
  if (req.mode === 'navigate') {   // the page itself holds the token: never stored, only an offline message when the server is down
    e.respondWith(fetch(req).catch(() => new Response(OFFLINE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
    return;
  }
  if (!SHELL.includes(url.pathname)) return;
  e.respondWith(fetch(req).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return r; }).catch(() => caches.match(req)));
});
async function takeShare(req) {
  try {
    const f = await req.formData(), c = await caches.open(SHARE);
    for (const k of await c.keys()) await c.delete(k);   // only the latest share waits
    const files = f.getAll('files').filter((x) => x && typeof x === 'object' && x.size);
    await Promise.all(files.map((x, i) => c.put(`/share/${i}`, new Response(x, { headers: { 'Content-Type': x.type || 'application/octet-stream', 'X-Name': encodeURIComponent(x.name || 'file') } }))));
    const text = ['title', 'text', 'url'].map((k) => f.get(k)).filter((v) => typeof v === 'string' && v.trim()).join('\n');
    if (text) await c.put('/share/text', new Response(text));
  } catch {}
  return Response.redirect('/?share=1', 303);
}
