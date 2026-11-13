/*
 * BetZone service worker. Kept deliberately small:
 *  - makes the app installable ("Add to home screen");
 *  - shows a simple offline page when the network is down;
 *  - opens the admin Requests tab when an admin alert notification is tapped.
 * It does not cache app files or API responses, so every deploy is picked up
 * immediately and balances are never shown from a stale cache.
 */
const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>BetZone · Offline</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#020617;color:#e2e8f0;font:16px system-ui,sans-serif;text-align:center;padding:24px}
button{margin-top:16px;min-height:44px;padding:0 20px;border:0;border-radius:12px;background:#059669;color:#fff;font-weight:600;font-size:15px}</style></head>
<body><div><h1 style="font-size:20px">You're offline</h1><p>Check your internet connection and try again.</p>
<button onclick="location.reload()">Try again</button></div></body></html>`;

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return; // everything else goes straight to the network
  event.respondWith(
    fetch(event.request).catch(() => new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows[0];
    if (client) {
      await client.focus();
      client.postMessage({ type: 'open-admin-requests' });
      return;
    }
    await self.clients.openWindow('/');
  })());
});
