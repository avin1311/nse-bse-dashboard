/* Service worker: makes the dashboard installable as an app and lets alerts show as system notifications while the
   app is in the background. It does not cache data: prices and calls always come live from the server. */
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', e => { /* network only: live data must never come from a stale cache */ });
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { c.postMessage({ type: 'open-monitor' }); return c.focus(); } }
    return self.clients.openWindow('/?view=home#monitor');
  }));
});
