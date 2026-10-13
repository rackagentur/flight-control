// A gesture observer scoped to roster screens. Only a deliberate, top-edge vertical
// pull is claimed; native scrolling, edge navigation and interactive controls stay native.
import { html } from '../lib/html.js';
export const PULL_THRESHOLD = 80;
export function createPullGesture() {
  let origin = null, claimed = false, distance = 0;
  const cancel = () => { origin = null; claimed = false; distance = 0; };
  return {
    start(x, y, eligible) { cancel(); if (eligible) origin = { x, y }; },
    move(x, y) {
      if (!origin) return null;
      const dx = Math.abs(x - origin.x), dy = y - origin.y;
      if (dy < -8 || (dx > 12 && dx >= Math.max(0, dy) / 1.4)) { cancel(); return null; }
      if (!claimed && dy > 12 && dy > dx * 1.4) claimed = true;
      distance = Math.max(0, dy);
      return claimed ? (distance >= PULL_THRESHOLD ? 'armed' : 'pulling') : null;
    },
    end() { const refresh = claimed && distance >= PULL_THRESHOLD; cancel(); return refresh; },
    cancel,
  };
}
export const refreshControls = () => html`<div class="roster-refresh" data-refresh-controls>
  <span class="t-caption" data-pull-status role="status" aria-live="polite" aria-atomic="true"></span>
  <button type="button" class="btn btn-quiet" data-roster-manual-refresh aria-label="Refresh roster">
    <span class="refresh-mark" aria-hidden="true"></span><span data-refresh-label>Refresh</span>
  </button>
</div>`;

export function mountPullRefresh({ root, enabled, refresh, view, win = window }) {
  const gesture = createPullGesture();
  let busy = false, phase = '', revision = 0;
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  const paint = () => {
    const bar = root.querySelector('[data-refresh-controls]');
    if (!bar) return;
    const loading = busy || view().loading;
    bar.dataset.phase = loading ? 'refreshing' : phase;
    bar.querySelector('[data-roster-manual-refresh]').setAttribute('aria-disabled', String(loading));
    text(bar.querySelector('[data-refresh-label]'), loading ? 'Refreshing…' : 'Refresh');
    text(bar.querySelector('[data-pull-status]'), loading ? 'Refreshing roster' : phase === 'armed' ? 'Release to refresh' : phase === 'pulling' ? 'Pull to refresh' : '');
  };
  const reset = () => { gesture.cancel(); phase = ''; paint(); };
  const run = async () => {
    if (!enabled() || busy || view().loading) return;
    busy = true; phase = ''; paint();
    try { await refresh(); } finally { busy = false; paint(); }
  };
  const start = (event) => {
    const touch = event.touches[0];
    const interactive = event.target.closest('a, button, input, textarea, select, [contenteditable], [role="slider"], [data-no-pull-refresh]');
    let nestedScroll = false;
    for (let el = event.target; el && el !== root; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight && /auto|scroll/.test(win.getComputedStyle(el).overflowY)) nestedScroll = true;
    }
    gesture.start(touch?.clientX, touch?.clientY, enabled() && !busy && !view().loading && event.touches.length === 1
      && win.scrollY >= -1 && win.scrollY <= 1 && !interactive && !nestedScroll
      && touch.clientX > 24 && touch.clientX < win.innerWidth - 24);
    phase = ''; paint();
  };
  const move = (event) => {
    if (!enabled() || win.scrollY > 1 || event.touches.length !== 1) { reset(); return; }
    const next = gesture.move(event.touches[0].clientX, event.touches[0].clientY);
    if (next && !event.cancelable) { reset(); return; }
    // Suppress browser page-refresh only for the gesture this control has claimed.
    // No global overscroll/touch-action override; all other gestures remain untouched.
    if (next) event.preventDefault();
    phase = next ?? ''; paint();
  };
  const end = () => { const triggered = gesture.end(); phase = ''; if (triggered) void run(); else paint(); };
  const click = (event) => { if (event.target.closest('[data-roster-manual-refresh]')) void run(); };
  root.addEventListener('touchstart', start, { passive: true });
  root.addEventListener('touchmove', move, { passive: false });
  root.addEventListener('touchend', end, { passive: true });
  root.addEventListener('touchcancel', reset, { passive: true });
  root.addEventListener('click', click);
  return {
    // Called after route rendering: cancel a gesture if navigation replaced its screen.
    update(route) { if (revision !== route) { revision = route; gesture.cancel(); phase = ''; } paint(); },
    destroy() {
      for (const [name, fn] of [['touchstart', start], ['touchmove', move], ['touchend', end], ['touchcancel', reset], ['click', click]]) root.removeEventListener(name, fn);
    },
  };
}
