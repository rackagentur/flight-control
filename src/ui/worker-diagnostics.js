// About-only observation. Never registers, updates, activates or claims a worker.
import { html, render } from '../lib/html.js';
import { listRow } from './components.js';

const UNKNOWN = { control: 'checking', version: null, waiting: null, ready: null };

/** Observe the controller itself; registration.active may control a different page. */
export function watchWorkerDiagnostics(onStatus, {
  nav = globalThis.navigator, events = globalThis.window, doc = globalThis.document,
  timeoutMs = 4000,
} = {}) {
  const sw = nav?.serviceWorker;
  if (!sw) { onStatus({ ...UNKNOWN, control: 'unsupported' }); return () => {}; }
  let alive = true, revision = 0;
  const removers = [], observed = new WeakSet(), pending = new Set();
  const listen = (target, type, fn) => {
    target?.addEventListener(type, fn);
    removers.push(() => target?.removeEventListener(type, fn));
  };
  const observe = (target, type) => {
    if (!target || observed.has(target)) return;
    observed.add(target); listen(target, type, check);
  };
  const reply = (worker) => new Promise((resolve) => {
    let channel, timer;
    const finish = (value = null) => {
      clearTimeout(timer); channel?.port1.close(); channel?.port2.close();
      pending.delete(finish); resolve(value);
    };
    pending.add(finish);
    try {
      channel = new MessageChannel();
      timer = setTimeout(finish, timeoutMs);
      channel.port1.onmessage = ({ data }) => finish({
        // Whitelist the generated build format; never display arbitrary worker data.
        version: typeof data?.version === 'string' && /^[a-f0-9]{20}$/.test(data.version) ? data.version : null,
        ready: typeof data?.ready === 'boolean' ? data.ready : null,
      });
      worker.postMessage({ type: 'FC_SHELL_STATUS' }, [channel.port2]);
    } catch { finish(); }
  });
  const registration = () => new Promise((resolve) => {
    const finish = (value = null) => { clearTimeout(timer); pending.delete(finish); resolve(value); };
    const timer = setTimeout(finish, timeoutMs); pending.add(finish);
    Promise.resolve().then(() => sw.getRegistration()).then(finish, () => finish());
  });
  async function check() {
    if (!alive) return;
    const ticket = ++revision, controller = sw.controller;
    const control = controller ? 'controlled' : 'uncontrolled';
    onStatus({ ...UNKNOWN, control });
    const [status, reg] = await Promise.all([controller ? reply(controller) : null, registration()]);
    if (!alive || ticket !== revision) return;
    if (controller !== sw.controller) { check(); return; }
    observe(reg, 'updatefound');
    observe(reg?.installing, 'statechange');
    observe(reg?.waiting, 'statechange');
    onStatus({ control, version: status?.version ?? null, ready: status?.ready ?? null,
      waiting: reg ? Boolean(reg.waiting) : null });
  }
  listen(sw, 'controllerchange', check);
  listen(sw, 'message', (event) => { if (event.data?.type === 'FC_SHELL_CHANGED') check(); });
  listen(events, 'pageshow', check);
  listen(doc, 'visibilitychange', () => { if (doc.visibilityState === 'visible') check(); });
  check();
  return () => { alive = false; revision++; removers.forEach((remove) => remove()); [...pending].forEach((finish) => finish()); };
}

export function workerDiagnosticsView(status = UNKNOWN, view = {}) {
  const control = { checking: 'Checking…', unsupported: 'Not supported by this browser',
    uncontrolled: 'This page is not controlled', controlled: 'This page is controlled' }[status.control];
  const version = status.version ?? (status.control === 'uncontrolled' || status.control === 'unsupported' ? 'None' : 'Not confirmed');
  const waiting = status.control === 'unsupported' ? 'Not supported' : status.waiting === null ? 'Not confirmed'
    : status.waiting ? 'Waiting · not controlling this page' : 'No waiting update';
  const readiness = status.ready === true && view.offlineReady === true ? 'Ready · application and saved roster'
    : status.ready === false ? 'Not ready · application cache incomplete'
    : status.ready === true ? 'Not ready · roster persistence not confirmed'
    : 'Not confirmed';
  return html`
    ${listRow({ iconName: 'info', label: 'Controlling worker build', detail: version })}
    ${listRow({ iconName: 'info', label: 'Worker control', detail: control })}
    ${listRow({ iconName: 'info', label: 'Waiting update', detail: waiting })}
    ${listRow({ iconName: 'info', label: 'Offline readiness', detail: readiness })}`;
}

const updates = new WeakMap();
export function updateWorkerDiagnostics(root) { updates.get(root)?.(); }
export function mountWorkerDiagnostics(root, getView) {
  const target = root.querySelector('[data-worker-diagnostics]');
  if (!target) return () => {};
  let status = UNKNOWN, previous = '';
  const update = () => {
    const markup = workerDiagnosticsView(status, getView());
    // Controller clock ticks must not repeatedly announce unchanged diagnostics.
    if (String(markup) === previous) return;
    previous = String(markup); render(target, markup);
  };
  updates.set(root, update);
  const stop = watchWorkerDiagnostics((next) => { status = next; update(); });
  return () => { updates.delete(root); stop(); };
}
