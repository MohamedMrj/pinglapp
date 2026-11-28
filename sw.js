// Pinglapp service worker: makes the app installable and usable offline.
// Pages load from the network first (so everyone gets updates), falling back to the cached copy offline.
const CACHE = 'ping-v3';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png',
  './icon-maskable-192.png', './icon-maskable-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});

// A reminder sent by the server (phase 7b: Edge Function send-due-pushes), so it arrives with Pinglapp closed.
// Payload: { t: title, at: due time (ms), id: reminder id, l: 'sv' | 'en' }. The tag is the reminder id, the same as the
// notification Pinglapp shows itself when it is open: if that one was shown in the last 3 minutes, this replaces it
// quietly instead of ringing twice. A push must always show something (browsers stop sending to sites that don't).
const PUSH_RECENT_MS = 180000;
function pushWhen(at, lang) {
  try {
    return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'sv-SE', { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(at));
  } catch (e) { return ''; }
}
self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (err) { m = {}; }
  const lang = m.l === 'en' ? 'en' : 'sv';
  const title = typeof m.t === 'string' && m.t ? m.t : (lang === 'en' ? 'Reminder' : 'Påminnelse');
  const tag = typeof m.id === 'string' && m.id ? m.id : 'ping-push';
  const at = typeof m.at === 'number' ? m.at : Date.now();
  e.waitUntil((async () => {
    let recent = false;
    try {
      const now = Date.now();
      recent = (await self.registration.getNotifications({ tag })).some(n => now - ((n.data && n.data.shownAt) || n.timestamp || 0) < PUSH_RECENT_MS);
    } catch (err) { }
    await self.registration.showNotification(title, {
      body: pushWhen(at, lang), tag, renotify: !recent, silent: recent, icon: 'icon-192.png', badge: 'icon-192.png',
      timestamp: at, data: { push: true, shownAt: Date.now(), id: tag, at }
    });
  })());
});

// Clicking a notification brings the Pinglapp window to the front.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    if (list.length) return list[0].focus();
    return self.clients.openWindow('./');
  }));
});
