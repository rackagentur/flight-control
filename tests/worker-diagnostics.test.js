import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchWorkerDiagnostics, workerDiagnosticsView, mountWorkerDiagnostics, updateWorkerDiagnostics } from '../src/ui/worker-diagnostics.js';

const BUILD = '0123456789abcdef0123';
function harness({ answer = { version: BUILD, ready: true }, controlled = true, waiting = false, failRegistration = false } = {}) {
  const sw = new EventTarget(), reg = new EventTarget(), events = new EventTarget(), doc = new EventTarget();
  const messages = [], states = [], callbacks = [];
  const worker = new EventTarget();
  worker.postMessage = (message, [port]) => {
    messages.push(message);
    if (answer === 'throw') throw new Error('cannot message worker');
    if (answer === 'held') { callbacks.push(() => { port.postMessage({ version: BUILD, ready: true }); port.close(); }); return; }
    if (answer !== null) port.postMessage(answer);
    port.close();
  };
  reg.active = { postMessage() { throw new Error('must not query registration.active'); } };
  reg.waiting = waiting ? new EventTarget() : null;
  sw.controller = controlled ? worker : null;
  sw.getRegistration = async () => {
    if (failRegistration === 'pending') return new Promise(() => {});
    if (failRegistration) throw new Error('unavailable');
    return reg;
  };
  for (const target of [sw, reg]) for (const name of ['register', 'update', 'unregister']) {
    target[name] = () => { throw new Error(`diagnostics must not ${name}`); };
  }
  const stop = watchWorkerDiagnostics((state) => states.push(state), { nav: { serviceWorker: sw }, events, doc, timeoutMs: 25 });
  return { sw, reg, worker, events, doc, states, messages, callbacks, stop };
}
async function settled(h, predicate = (s) => s.waiting !== null) {
  for (let i = 0; i < 100; i++) {
    if (predicate(h.states.at(-1))) return h.states.at(-1);
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail('diagnostics did not settle');
}

test('identity comes from controller response, never registration.active; waiting is separate', async () => {
  const h = harness({ waiting: true });
  try {
    assert.deepEqual(await settled(h), { control: 'controlled', version: BUILD, ready: true, waiting: true });
    assert.deepEqual(h.messages, [{ type: 'FC_SHELL_STATUS' }]);
  } finally { h.stop(); }
});
test('uncontrolled page does not report the registered active worker as its controller', async () => {
  const h = harness({ controlled: false, waiting: true });
  try {
    assert.deepEqual(await settled(h), { control: 'uncontrolled', version: null, ready: null, waiting: true });
    assert.equal(h.messages.length, 0);
  } finally { h.stop(); }
});
test('unsupported browser is explicit, with no false identity or readiness', () => {
  const states = []; watchWorkerDiagnostics((s) => states.push(s), { nav: {} })();
  assert.deepEqual(states, [{ control: 'unsupported', version: null, waiting: null, ready: null }]);
});
test('timeout, thrown messages and malformed replies never invent a build or readiness', async () => {
  for (const answer of [null, 'throw', { version: '<secret>', ready: 'true' }, { ready: true }]) {
    const h = harness({ answer });
    try {
      const status = await settled(h);
      assert.equal(status.version, null);
      assert.equal(status.ready, answer?.ready === true ? true : null);
      assert.equal(String(workerDiagnosticsView(status)).includes('<secret>'), false);
    } finally { h.stop(); }
  }
});
test('registration failure leaves waiting status unknown but retains controller evidence', async () => {
  const h = harness({ failRegistration: true });
  try {
    const s = await settled(h, (s) => s.version === BUILD);
    assert.equal(s.waiting, null); assert.equal(s.control, 'controlled');
  } finally { h.stop(); }
});
test('a stalled registration lookup is bounded and does not hide controller evidence', async () => {
  const h = harness({ failRegistration: 'pending' });
  try {
    const s = await settled(h, (s) => s.version === BUILD);
    assert.equal(s.waiting, null); assert.equal(s.ready, true);
  } finally { h.stop(); }
});
test('late reply from replaced controller cannot label the new page control state', async () => {
  const h = harness({ answer: 'held' });
  try {
    h.sw.controller = null; h.sw.dispatchEvent(new Event('controllerchange'));
    h.callbacks.forEach((reply) => reply());
    assert.deepEqual(await settled(h), { control: 'uncontrolled', version: null, ready: null, waiting: false });
    assert.ok(h.states.every((s) => s.version === null));
  } finally { h.stop(); }
});
test('updatefound and installing state changes refresh waiting status without activating it', async () => {
  const h = harness();
  try {
    await settled(h);
    h.reg.installing = new EventTarget(); h.reg.dispatchEvent(new Event('updatefound'));
    await settled(h);
    h.reg.waiting = h.reg.installing; h.reg.installing = null;
    h.reg.waiting.dispatchEvent(new Event('statechange'));
    const s = await settled(h); assert.equal(s.waiting, true); assert.equal(s.version, BUILD);
  } finally { h.stop(); }
});
test('foreground observation refreshes status; unmount removes listeners and ignores pending replies', async () => {
  const h = harness();
  await settled(h);
  h.events.dispatchEvent(new Event('pageshow')); await settled(h);
  assert.equal(h.messages.length, 2);
  h.stop(); const count = h.states.length;
  h.sw.dispatchEvent(new Event('controllerchange')); h.events.dispatchEvent(new Event('pageshow'));
  assert.equal(h.states.length, count);
  const pending = harness({ answer: 'held' }); pending.stop();
  pending.callbacks.forEach((reply) => reply());
  await new Promise((r) => setTimeout(r, 30)); assert.equal(pending.states.length, 1);
});
test('About labels separate control, waiting update and combined roster/shell readiness', () => {
  const base = { control: 'controlled', version: BUILD, waiting: true, ready: true };
  const ready = String(workerDiagnosticsView(base, { offlineReady: true }));
  assert.match(ready, new RegExp(BUILD)); assert.match(ready, /Waiting · not controlling this page/);
  assert.match(ready, /Ready · application and saved roster/);
  for (const [state, view] of [[base, {}], [{ ...base, ready: false }, { offlineReady: true }], [{ ...base, ready: null }, { offlineReady: true }]]) {
    assert.doesNotMatch(String(workerDiagnosticsView(state, view)), /Ready · application and saved roster/);
  }
  assert.match(String(workerDiagnosticsView({ control: 'uncontrolled', version: null, waiting: false, ready: null })), /This page is not controlled/);
});
test('Settings clock updates do not reannounce identical diagnostics; unmount detaches updater', () => {
  let writes = 0;
  const target = { set innerHTML(value) { writes++; assert.match(value, /Controlling worker build/); } };
  const root = { querySelector: () => target };
  const stop = mountWorkerDiagnostics(root, () => ({}));
  const first = writes; assert.equal(first, 1);
  updateWorkerDiagnostics(root); updateWorkerDiagnostics(root);
  assert.equal(writes, first);
  stop(); updateWorkerDiagnostics(root); assert.equal(writes, first);
});
