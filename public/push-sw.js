/**
 * Web Push handlers, imported INTO the Workbox-generated service worker (LBV-1481).
 *
 * ## Why this is a separate file and not `src/sw.ts`
 *
 * The app deliberately uses `vite-plugin-pwa`'s `generateSW` strategy: the precache manifest, the
 * `navigateFallback`, the `/api` and `reset-sw.html` denylists and `cleanupOutdatedCaches` are all
 * generated and each is documented in `vite.config.ts` as load-bearing. Switching to `injectManifest`
 * to add two event listeners would mean re-implementing all of that by hand and owning it forever.
 * Instead this file is added to the generated worker with `workbox.importScripts: ['push-sw.js']`,
 * so every generateSW guarantee stays intact and this only adds `push` and `notificationclick`.
 *
 * It lives in `public/` (copied to the site root verbatim), which is why the import path is a bare
 * `'push-sw.js'` resolved against the worker's own scope. It is plain ES5-ish service-worker script,
 * not a module: `importScripts` runs it in the worker's global scope, where `self`, `clients` and
 * `registration` are the API surface.
 *
 * ## What it must not assume
 *
 * A push can arrive with no data, or with data that is not the JSON this app sends (a probe from the
 * push service, a payload from a future version). `userVisibleOnly: true` means the browser will
 * show a generic notification if this handler shows none, so the fallbacks below exist to show
 * something honest rather than to satisfy a contract. Nothing here reads IndexedDB or the network:
 * a notification handler has no session and must be instant.
 */

/* global self, clients */

/** The app's start URL, matched loosely so an already-open tab is focused rather than duplicated. */
const APP_URL = './';

self.addEventListener('push', (event) => {
  /** @type {{ title?: string, body?: string, url?: string, tag?: string }} */
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (_) {
      // Not our JSON. Fall back to the raw text as the body so a probe still renders something.
      payload = { body: event.data.text() };
    }
  }

  const title = typeof payload.title === 'string' && payload.title !== '' ? payload.title : 'GodMode';
  const options = {
    body: typeof payload.body === 'string' ? payload.body : 'Time to train.',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    // Coalesce reminders: a second reminder replaces the first rather than stacking, unless the
    // sender deliberately tags them apart.
    tag: typeof payload.tag === 'string' && payload.tag !== '' ? payload.tag : 'godmode-reminder',
    // Carry where a tap should land, read back in `notificationclick`.
    data: { url: typeof payload.url === 'string' && payload.url !== '' ? payload.url : APP_URL },
  };

  // `waitUntil` keeps the worker alive until the notification is shown; without it the browser may
  // kill the worker first and drop the notification.
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || APP_URL;

  event.waitUntil(
    // Focus an existing GodMode tab if one is open — opening a second is disorienting and, on iOS,
    // loses the running app — otherwise open a new one.
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(target);
      return undefined;
    }),
  );
});
