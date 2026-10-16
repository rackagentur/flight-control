import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPullGesture, mountPullRefresh, PULL_THRESHOLD, refreshControls } from '../src/ui/pull-refresh.js';

function harness() {
  const handlers = new Map(), nodes = new Map(); let calls = 0, release, enabled = true;
  const node = () => ({ textContent: '', dataset: {}, setAttribute() {} });
  const bar = node(); bar.querySelector = (s) => { if (!nodes.has(s)) nodes.set(s, node()); return nodes.get(s); };
  const root = { querySelector: () => bar, addEventListener: (s, f) => handlers.set(s, f), removeEventListener: (s) => handlers.delete(s) };
  const win = { scrollY: 0, innerWidth: 390, getComputedStyle: () => ({ overflowY: 'visible' }) };
  const target = { closest: () => null, parentElement: root, scrollHeight: 10, clientHeight: 10 };
  const mount = mountPullRefresh({ root, win, enabled: () => enabled, view: () => ({ loading: false }), refresh: () => { calls++; return new Promise((r) => { release = r; }); } });
  const touch = (name, x, y, options = {}) => {
    let prevented = false;
    handlers.get(name)({ target, touches: name === 'touchend' ? [] : [{ clientX: x, clientY: y }], cancelable: true, preventDefault: () => { prevented = true; }, ...options });
    return prevented;
  };
  return { touch, win, mount, target, bar, nodes, root, handlers, disable: () => { enabled = false; }, get calls() { return calls; }, finish: () => release?.() };
}

test('deliberate vertical pull requires threshold on release; retreat, horizontal and upward gestures cancel', () => {
  const g = createPullGesture();
  g.start(100, 100, true); assert.equal(g.move(101, 112), null); assert.equal(g.move(101, 140), 'pulling'); assert.equal(g.end(), false);
  g.start(100, 100, true); assert.equal(g.move(101, 100 + PULL_THRESHOLD), 'armed'); assert.equal(g.end(), true); assert.equal(g.end(), false);
  g.start(100, 100, true); g.move(100, 200); g.move(100, 120); assert.equal(g.end(), false);
  for (const [x, y] of [[180, 110], [100, 80], [180, 180]]) { g.start(100, 100, true); g.move(x, y); assert.equal(g.end(), false); }
  g.start(100, 100, false); assert.equal(g.move(100, 220), null); assert.equal(g.end(), false);
});

test('only top vertical gesture is claimed; scroll, controls, edge swipes, nested scroll and multitouch remain native', () => {
  for (const variant of ['scrolled', 'control', 'edge', 'nested', 'horizontal', 'multi', 'uncancelable', 'disabled']) {
    const h = harness();
    if (variant === 'scrolled') h.win.scrollY = 20;
    if (variant === 'control') h.target.closest = () => ({});
    if (variant === 'nested') { h.target.scrollHeight = 100; h.win.getComputedStyle = () => ({ overflowY: 'auto' }); }
    if (variant === 'disabled') h.disable();
    const x = variant === 'edge' ? 10 : 100;
    h.touch('touchstart', x, 100);
    const prevented = h.touch('touchmove', variant === 'horizontal' ? 200 : x, 200, variant === 'multi' ? { touches: [{}, {}] } : variant === 'uncancelable' ? { cancelable: false } : {});
    h.touch('touchend'); assert.equal(prevented, false, variant); assert.equal(h.calls, 0, variant);
  }
});

test('pull, fallback button and rerender cannot duplicate an in-flight refresh; cancel and navigation disarm', async () => {
  const h = harness(); h.mount.update('today');
  h.touch('touchstart', 100, 100); assert.equal(h.touch('touchmove', 100, 190), true);
  h.touch('touchend'); assert.equal(h.calls, 1); assert.equal(h.bar.dataset.phase, 'refreshing');
  h.handlers.get('click')({ target: { closest: () => ({}) } });
  h.touch('touchstart', 100, 100); h.touch('touchmove', 100, 200); h.touch('touchend'); h.mount.update('today'); assert.equal(h.calls, 1);
  h.finish(); await Promise.resolve(); assert.equal(h.bar.dataset.phase, '');
  h.touch('touchstart', 100, 100); h.touch('touchmove', 100, 200); h.touch('touchcancel'); h.touch('touchend'); assert.equal(h.calls, 1);
  h.touch('touchstart', 100, 100); h.touch('touchmove', 100, 200); h.mount.update('calendar'); h.touch('touchend'); assert.equal(h.calls, 1);
  assert.match(String(refreshControls()), /aria-live="polite"/);
  h.mount.destroy(); assert.equal(h.handlers.size, 0);
});
