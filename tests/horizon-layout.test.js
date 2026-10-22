import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitHorizonLabels, horizonView, mountHorizonLabels } from '../src/ui/horizon.js';
import { fixtureSnapshot, pipeline } from './helpers.js';

test('pixel collision fitting prioritizes next and final labels over intermediate stops', () => {
  const boxes = [
    { left: 0, right: 90, priority: 0 },
    { left: 75, right: 110, priority: 2 },
    { left: 140, right: 200, priority: 3 },
    { left: 180, right: 270, priority: 1 },
  ];
  assert.deepEqual(fitHorizonLabels(boxes, 0, 280).map((b) => b.visible), [true, false, false, true]);
});
test('edge fitting and enlarged text never overlap retained labels or change input geometry', () => {
  for (const width of [200, 280, 300, 600]) for (const scale of [1, 1.25, 2]) {
    const boxes = Array.from({ length: 8 }, (_, i) => ({ left: i * width / 7 - 30 * scale, right: i * width / 7 + 30 * scale, priority: i === 2 ? 0 : i === 7 ? 1 : 2 }));
    const before = structuredClone(boxes);
    const fit = fitHorizonLabels(boxes, 0, width);
    assert.equal(fit[2].visible, true);
    const visible = fit.filter((b) => b.visible).sort((a, b) => a.left - b.left);
    assert.ok(visible.every((b) => b.left >= 0 && b.right <= width));
    assert.ok(visible.every((b, i) => !i || b.left - visible[i - 1].right >= 8));
    assert.deepEqual(boxes, before);
  }
});
test('timeline retains every stop and complete accessible summary while annotating display priorities', () => {
  const { horizon } = pipeline(fixtureSnapshot(), '2026-10-10T05:00:00Z');
  const before = structuredClone(horizon);
  const markup = String(horizonView(horizon));
  assert.equal((markup.match(/class="hz-stop /g) ?? []).length, horizon.stops.length);
  assert.equal((markup.match(/class="hz-time /g) ?? []).length, horizon.stops.length);
  assert.match(markup, /aria-label="Duty Horizon\./);
  assert.match(markup, /data-label-priority="0"/);
  assert.deepEqual(horizon, before);
});

test('mounted labels refit on resize and font changes, and stop observing after screen disposal', async () => {
  const win = new EventTarget(), fonts = new EventTarget(), frames = new Map(), observed = [];
  let width = 200, fontWidth = 80, nextFrame = 0, disconnected = false, notifyResize;
  fonts.ready = Promise.resolve();
  win.requestAnimationFrame = (fn) => { frames.set(++nextFrame, fn); return nextFrame; };
  win.cancelAnimationFrame = (id) => frames.delete(id);
  win.ResizeObserver = class {
    constructor(fn) { notifyResize = fn; }
    observe(el) { observed.push(el); }
    disconnect() { disconnected = true; }
  };
  const labels = [0, 1].map((priority) => ({ style: {}, dataset: { labelPriority: String(priority) },
    getBoundingClientRect: () => ({ left: priority * width / 2, right: priority * width / 2 + fontWidth, height: 40 }) }));
  const row = { style: {}, children: labels, getBoundingClientRect: () => ({ left: 0, right: width, width }) };
  const stop = mountHorizonLabels({ querySelectorAll: () => [row] }, { win, doc: { fonts } });
  const flush = () => { const work = [...frames.values()]; frames.clear(); work.forEach((fn) => fn()); };
  assert.deepEqual(labels.map((l) => l.style.visibility), ['visible', 'visible']);
  assert.equal(row.style.height, '40px');
  assert.equal(observed.length, 3);
  await fonts.ready;
  flush();
  width = 100; notifyResize(); win.dispatchEvent(new Event('resize'));
  assert.equal(frames.size, 1, 'resize work is coalesced'); flush();
  assert.deepEqual(labels.map((l) => l.style.visibility), ['visible', 'hidden']);
  width = 400; fontWidth = 100; fonts.dispatchEvent(new Event('loadingdone')); flush();
  assert.deepEqual(labels.map((l) => l.style.visibility), ['visible', 'visible']);
  notifyResize(); stop();
  assert.equal(disconnected, true); assert.equal(frames.size, 0);
  notifyResize(); win.dispatchEvent(new Event('resize')); fonts.dispatchEvent(new Event('loadingdone'));
  assert.equal(frames.size, 0, 'disposed screen cannot schedule work');
});
