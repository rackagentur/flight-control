// A localStorage-like double shared by several worker threads ("tabs") through SharedArrayBuffers. Every
// getItem / setItem / removeItem is atomic on its own (a spin mutex around the whole map), like localStorage in
// one origin; nothing coordinates a read-modify-write sequence across tabs (that is what the Web Lock is for).
// A test can arm a blocking pause inside one tab's setItem of a chosen key (Atomics.wait), to stop that tab
// exactly between its decision and its write. Synthetic test infrastructure only.

const DATA_BYTES = 1 << 16;
// ctl slots: 0 mutex, 1 armed tab id (0 = none), 2 paused tab id, 3 resume flag, 4 pause key index
const MUTEX = 0;
const ARMED = 1;
const PAUSED = 2;
const RESUME = 3;

export function createSharedBuffers() {
  return { data: new SharedArrayBuffer(DATA_BYTES), ctl: new SharedArrayBuffer(64) };
}

/**
 * @param {{data:SharedArrayBuffer, ctl:SharedArrayBuffer}} buffers
 * @param {number} tabId  1-based id of the tab using this view
 * @param {string} pauseKey the storage key whose setItem may be paused
 */
export function sharedStorage(buffers, tabId, pauseKey) {
  const ctl = new Int32Array(buffers.ctl);
  const len = new Int32Array(buffers.data, 0, 1);
  const bytes = new Uint8Array(buffers.data, 4);
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const lock = () => { while (Atomics.compareExchange(ctl, MUTEX, 0, 1) !== 0) Atomics.wait(ctl, MUTEX, 1, 5); };
  const unlock = () => { Atomics.store(ctl, MUTEX, 0); Atomics.notify(ctl, MUTEX); };
  const load = () => {
    const n = Atomics.load(len, 0);
    return n ? new Map(JSON.parse(dec.decode(bytes.slice(0, n)))) : new Map();
  };
  const save = (map) => {
    const out = enc.encode(JSON.stringify([...map]));
    if (out.length > bytes.length) throw new Error('quota');
    bytes.set(out);
    Atomics.store(len, 0, out.length);
  };
  const atomic = (fn) => { lock(); try { return fn(); } finally { unlock(); } };
  const maybePause = (key) => {
    if (key !== pauseKey || Atomics.compareExchange(ctl, ARMED, tabId, 0) !== tabId) return;
    Atomics.store(ctl, RESUME, 0);
    Atomics.store(ctl, PAUSED, tabId);
    Atomics.notify(ctl, PAUSED);
    while (Atomics.load(ctl, RESUME) === 0) Atomics.wait(ctl, RESUME, 0, 50);   // blocks this tab's thread
    Atomics.store(ctl, PAUSED, 0);
  };
  return {
    getItem: (k) => atomic(() => { const m = load(); return m.has(k) ? m.get(k) : null; }),
    setItem: (k, v) => { maybePause(k); atomic(() => { const m = load(); m.set(k, String(v)); save(m); }); },
    removeItem: (k) => atomic(() => { const m = load(); m.delete(k); save(m); }),
    key: (i) => atomic(() => [...load().keys()][i] ?? null),
    get length() { return atomic(() => load().size); },
  };
}

/** Main-thread controls for the pause and a raw view of the shared map. */
export function sharedControls(buffers) {
  const ctl = new Int32Array(buffers.ctl);
  const view = sharedStorage(buffers, -1, null);
  return {
    arm: (tabId) => { Atomics.store(ctl, PAUSED, 0); Atomics.store(ctl, ARMED, tabId); },
    pausedTab: () => Atomics.load(ctl, PAUSED),
    resume: () => { Atomics.store(ctl, RESUME, 1); Atomics.notify(ctl, RESUME); },
    raw: (key) => view.getItem(key),
    set: (key, value) => view.setItem(key, value),
  };
}
