// EMERGENCY ROLLBACK WORKER for the Flight Control offline shell. NOT part of a normal build.
// Activation (docs/STEP-6.6-OFFLINE.md, "Emergency rollback"): serve this file verbatim as `sw.js`
// at the same URL as the installed worker (e.g. /flight-control/sw.js) together with the restored
// application. Installed clients pick it up through the normal update check, then:
//   1. it activates at once (skipWaiting), so it never waits behind the old shell;
//   2. it deletes ONLY this app's shell caches (prefix `fc-shell-`); other caches on the origin stay;
//   3. it unregisters ONLY its own registration (this scope); other registrations stay;
//   4. it reloads its open windows, which now load the restored application from the network.
// It has no fetch handler (every request goes to the network) and never touches localStorage,
// IndexedDB or cookies: saved roster, access token and settings survive.
const SHELL_PREFIX = 'fc-shell-';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(SHELL_PREFIX)).map((key) => caches.delete(key)));
    await self.clients.claim();
    await self.registration.unregister();
    const windows = await self.clients.matchAll({ type: 'window' });
    await Promise.all(windows.map((client) => client.navigate(client.url).catch(() => null)));
  })());
});
