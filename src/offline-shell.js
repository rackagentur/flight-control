// Readiness is checked with the controlling worker, never inferred from registration alone.
export function watchOfflineShell(onReady, { nav = globalThis.navigator, events = globalThis.window, timeoutMs = 4000, retryDelayMs = 1000 } = {}) {
  if (!nav?.serviceWorker) { onReady(false); return; }
  let checking = 0;
  let registration;
  const claimed = new WeakSet();
  const recoverControl = () => {
    const worker = registration?.active;
    // A navigation begun during first installation can miss activate's clients.claim().
    // Ask once after it finishes loading; never force a waiting update into service.
    if (!nav.serviceWorker.controller && worker?.state === 'activated'
        && !registration.installing && !registration.waiting && !claimed.has(worker)) {
      claimed.add(worker);
      worker.postMessage({ type: 'FC_SHELL_CLAIM' });
    }
  };
  const probe = async (retries = 0) => {
    const attempt = ++checking;
    const worker = nav.serviceWorker.controller;
    if (!worker) { onReady(false); recoverControl(); return; }
    const ready = await new Promise((resolve) => {
      const channel = new MessageChannel();
      const finish = (value) => { clearTimeout(timer); channel.port1.close(); channel.port2.close(); resolve(value); };
      const timer = setTimeout(() => finish(null), timeoutMs);
      channel.port1.onmessage = (event) => finish(event.data?.ready === true);
      worker.postMessage({ type: 'FC_SHELL_STATUS' }, [channel.port2]);
    });
    if (attempt !== checking) return;
    onReady(ready === true);
    // A busy or waking worker can miss the message deadline. Retry twice without
    // inferring readiness or polling indefinitely. New lifecycle checks supersede it.
    if (ready === null && retries < 2) setTimeout(() => {
      if (attempt === checking) probe(retries + 1);
    }, retryDelayMs);
  };
  const check = () => probe();
  nav.serviceWorker.addEventListener('controllerchange', check);
  nav.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'FC_SHELL_CHANGED') check();
  });
  events?.addEventListener('pageshow', check);
  events?.addEventListener('online', check);
  events?.addEventListener('offline', check);
  globalThis.document?.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  check();
  nav.serviceWorker.register(new URL('../sw.js', import.meta.url), { updateViaCache: 'none' })
    .then((registered) => {
      registration = registered;
      const watch = (worker) => worker?.addEventListener('statechange', check);
      watch(registration.installing);
      registration.addEventListener('updatefound', () => watch(registration.installing));
      check();
    }).catch(() => { check(); }); // An offline update failure does not invalidate a working old shell.
}
