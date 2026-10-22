// Worker body; scripts/build-offline.mjs supplies a content-addressed static allowlist.
// No credentials, API responses, personal data or arbitrary runtime URLs enter this cache.
const PREFIX = 'fc-shell-';
const CACHE = PREFIX + VERSION;
const scope = new URL('./', self.location.href);
const assets = new Map(ASSETS.map((a) => [new URL(a.path, scope).href, a]));
const home = new URL('index.html', scope).href;

async function matchesAsset(response, asset) {
  if (!response.ok || response.type === 'opaque') return false;
  const hash = await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer());
  const digest = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return digest === asset.sha256;
}
const fetchStatic = (url) => fetch(url, { cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
async function verifiedResponse(url, asset) {
  const response = await fetchStatic(url);
  if (!await matchesAsset(response, asset)) throw new Error('Incomplete application update');
  return response;
}
async function notifyShellChange() {
  const clients = await self.clients.matchAll();
  for (const client of clients) client.postMessage({ type: 'FC_SHELL_CHANGED' });
}
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const responses = await Promise.all([...assets].map(async ([url, asset]) => [url, await verifiedResponse(url, asset)]));
      const cache = await caches.open(CACHE);
      await Promise.all(responses.map(([url, response]) => cache.put(url, response)));
      // No skipWaiting: existing tabs finish using the old, internally consistent version.
    } catch (error) {
      await caches.delete(CACHE);
      throw error;
    }
  })());
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Activation happens only after a complete install and after older clients close.
    // Keep the previous complete shell as a recovery copy; never touch unrelated caches.
    const keys = (await caches.keys()).filter((key) => key.startsWith(PREFIX) && key !== CACHE);
    await Promise.all(keys.slice(0, -1).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== scope.origin) return;
  const navigation = request.mode === 'navigate' && (url.pathname === scope.pathname || url.pathname === new URL(home).pathname);
  const key = navigation ? home : url.href;
  if (!assets.has(key)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const saved = await cache.match(key);
    if (saved) return saved;
    // A previous shell can repair an unchanged asset, but only after validating it
    // against THIS worker's manifest. Never borrow different-version bytes.
    const asset = assets.get(key);
    for (const name of (await caches.keys()).filter((name) => name.startsWith(PREFIX) && name !== CACHE).reverse()) {
      const previous = await (await caches.open(name)).match(key);
      if (previous && await matchesAsset(previous, asset)) {
        try { await cache.put(key, previous.clone()); } catch { /* usable response; readiness stays false */ }
        await notifyShellChange();
        return previous;
      }
    }
    // Let an online response recover the request even when a new version is live.
    // Nonmatching bytes are transient only: never add them to the offline shell.
    try {
      const response = await fetchStatic(key);
      if (await matchesAsset(response, asset)) {
        try { await cache.put(key, response.clone()); } catch { /* storage may be full */ }
      }
      return response;
    } finally { await notifyShellChange(); }
  })());
});
self.addEventListener('message', (event) => {
  if (event.data?.type === 'FC_SHELL_CLAIM') {
    // Only an in-scope window can request recovery from the first-install/navigation race.
    // Do not activate a waiting version or claim on behalf of an incomplete shell.
    const source = event.source;
    if (!source || source.type !== 'window') return;
    const url = new URL(source.url);
    if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
    event.waitUntil((async () => {
      if (self.registration.active?.state !== 'activated' || self.registration.waiting || self.registration.installing) return;
      const cache = await caches.open(CACHE);
      if ((await Promise.all([...assets.keys()].map((url) => cache.match(url)))).every(Boolean)) await self.clients.claim();
    })());
    return;
  }
  if (event.data?.type !== 'FC_SHELL_STATUS') return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const ready = (await Promise.all([...assets.keys()].map((url) => cache.match(url)))).every(Boolean);
    event.ports[0]?.postMessage({ ready, version: VERSION });
  })());
});
