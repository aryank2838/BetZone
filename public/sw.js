/*
 * BetZone service worker. Kept deliberately small:
 *  - makes the app installable ("Add to home screen");
 *  - shows a simple offline page when the network is down;
 *  - opens the admin Requests tab when an admin alert notification is tapped;
 *  - shows player push notifications (money added, withdrawal sent, winnings)
 *    and opens the matching screen when one is tapped.
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

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = typeof data.title === 'string' && data.title ? data.title : 'BetZone';
  // Only same-site paths are opened on tap.
  const url = typeof data.url === 'string' && data.url.startsWith('/') && !data.url.startsWith('//') ? data.url : '/';
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof data.body === 'string' ? data.body : '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: typeof data.tag === 'string' ? data.tag : undefined,
    renotify: true,
    data: { url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const pushUrl = event.notification.data && event.notification.data.url;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows[0];
    if (pushUrl) {
      // Player notification: open the matching screen.
      if (client) {
        await client.focus();
        client.postMessage({ type: 'open-url', url: pushUrl });
        return;
      }
      await self.clients.openWindow(pushUrl);
      return;
    }
    // Admin alert (shown by the page itself, no url).
    if (client) {
      await client.focus();
      client.postMessage({ type: 'open-admin-requests' });
      return;
    }
    await self.clients.openWindow('/');
  })());
});
