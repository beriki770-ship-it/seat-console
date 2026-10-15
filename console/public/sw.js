// Seat Console service worker. Exists so the browser offers "Install app"; it also keeps the static shell so a dead server shows a message, not Chrome's offline page.
// Network-first. Only the shell files below are ever stored: /api/* (incl. the SSE stream), the token (index.html carries it per run) and every non-GET are never cached.
const CACHE = 'seat-console-shell-v1';
const SHELL = ['/app.css', '/app.js', '/paths.js', '/manifest.webmanifest', '/icon-192.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });

const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Seat Console</title>
<body style="font:16px system-ui;background:#faf9f5;color:#1f1e1d;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center">
<div><h1 style="font-size:20px">Server not reachable</h1><p style="color:#73726c">Is the PC on, and is Tailscale connected?</p><button onclick="location.reload()" style="font:inherit;padding:8px 16px">Try again</button></div>`;

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;   // browser handles it, uncached
  if (req.mode === 'navigate') {   // the page itself holds the token: never stored, only an offline message when the server is down
    e.respondWith(fetch(req).catch(() => new Response(OFFLINE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
    return;
  }
  if (!SHELL.includes(url.pathname)) return;
  e.respondWith(fetch(req).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return r; }).catch(() => caches.match(req)));
});
