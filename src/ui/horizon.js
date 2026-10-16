// Duty Horizon view. A thin luminous line through the rotation: phases are spans, milestones
// are small stops, and "now" is a soft point of light. Past phases recede, the current phase
// carries the state accent, upcoming phases are drawn as a faint dotted continuation.
// Not a progress bar: positions follow the sequence of the duty, not a percentage.

import { html } from '../lib/html.js';
import { opTime, opTimeSpoken, tzModeChip } from '../lib/op-time.js';
import { getTimeDisplay } from '../time-display.js';

const pct = (x) => `${(x * 100).toFixed(2)}%`;
// Compact stop time: the stop's own zone (or UTC in UTC mode); an unknown zone is marked "Z".
const time = (stop, mode) => opTime(stop.at, stop.tz, mode, { compact: true });

const STOP_LABEL = { wakeup: 'Wake-up', pickup: 'Pickup', briefing: 'Briefing' };

function summary(h, mode) {
  const parts = h.stops.map((s) => {
    const what = STOP_LABEL[s.kind] ?? `${s.kind === 'departure' ? 'Depart' : 'Arrive'} ${s.code}`;
    return `${what} ${opTimeSpoken(s.at, s.tz, mode, { compact: true })}${s.status === 'past' ? ' (done)' : s.next ? ' (next)' : ''}`;
  });
  const current = h.spans.find((s) => s.status === 'current');
  return `Duty Horizon. ${current?.label ? `Now: ${current.label}. ` : ''}${parts.join(', ')}.`;
}

/**
 * Greedy label placement: keep the most important labels first and mark any label closer than
 * `gap` (fraction of the width) to an already kept one as minor (hidden on narrow screens).
 */
function markMinor(items, x, priority, gap) {
  const minor = new Set();
  const kept = [];
  for (const item of [...items].sort((a, b) => priority(a) - priority(b))) {
    if (kept.some((k) => Math.abs(x(k) - x(item)) < gap)) minor.add(item);
    else kept.push(item);
  }
  return minor;
}

/**
 * @param {ReturnType<import('../model/horizon.js').buildHorizon>} h
 * @param {{variant?: 'full'|'compact'}} [options]
 */
export function horizonView(h, { variant = 'full', mode = getTimeDisplay() } = {}) {
  if (!h) return '';
  const labelled = h.spans.filter((s) => s.label && s.kind !== 'before');
  const mid = (s) => (s.x0 + s.x1) / 2;
  const phaseMinor = markMinor(labelled, mid, (s) => (s.status === 'current' ? 0 : s.status === 'upcoming' ? 1 : 2), 0.26);
  const stopRank = (s) => (s.next ? 0 : s === h.stops.at(-1) ? 1 : s.kind === 'departure' ? 2 : s.kind === 'arrival' ? 3 : 4);
  const timeMinor = markMinor(h.stops, (s) => s.x, stopRank, 0.24);
  return html`
    <figure class="horizon horizon-${variant} horizon-${h.mode}" role="img" aria-label="${summary(h, mode)}">
      ${tzModeChip()}
      <div class="hz-labels" aria-hidden="true">
        ${labelled.map((s) => html`
          <span class="hz-phase is-${s.status} ${phaseMinor.has(s) ? 'is-minor' : ''}" data-label-priority="${s.status === 'current' ? 0 : s.status === 'upcoming' ? 1 : 2}" style="left:${pct((s.x0 + s.x1) / 2)}">${s.label}</span>`)}
      </div>
      <div class="hz-track" aria-hidden="true">
        ${h.spans.map((s) => html`
          <span class="hz-span hz-${s.kind} is-${s.status}" style="left:${pct(s.x0)};width:${pct(s.x1 - s.x0)}"></span>`)}
        ${h.stops.map((s) => html`
          <span class="hz-stop hz-stop-${s.kind} is-${s.status} ${s.next ? 'is-next' : ''}" style="left:${pct(s.x)}"></span>`)}
        ${h.mode === 'upcoming' || h.mode === 'past' ? '' : html`<span class="hz-now" style="left:${pct(h.now.x)}"></span>`}
      </div>
      <div class="hz-times" aria-hidden="true">
        ${h.stops.map((s) => html`
          <span class="hz-time hz-time-${s.kind} is-${s.status} ${s.next ? 'is-next' : ''} ${timeMinor.has(s) ? 'is-minor' : ''}" data-label-priority="${stopRank(s)}" style="left:${pct(s.x)}">
            <span class="hz-time-label">${STOP_LABEL[s.kind] ?? s.code}</span>
            <span class="hz-time-value">${time(s, mode)}</span>
          </span>`)}
      </div>
    </figure>`;
}

/** Pixel bounds, not fractional distances: next stop wins, then final arrival.
 * Labels may move inward at the edges; the underlying stops and times never move. */
export function fitHorizonLabels(boxes, left, right, gap = 8) {
  const kept = [];
  const result = boxes.map((box) => {
    const shift = Math.max(left - box.left, Math.min(0, right - box.right));
    return { shift, visible: false, left: box.left + shift, right: box.right + shift };
  });
  const order = boxes.map((box, i) => ({ ...box, i })).sort((a, b) => a.priority - b.priority || a.i - b.i);
  for (const { i } of order) {
    const candidate = result[i];
    if (candidate.right > right || candidate.left < left) continue;
    if (kept.some((box) => candidate.left < box.right + gap && candidate.right + gap > box.left)) continue;
    candidate.visible = true; kept.push(candidate);
  }
  return result;
}

/** Refit on container/font changes; dispose with the screen. No operational/model changes. */
export function mountHorizonLabels(root, { win = globalThis.window, doc = globalThis.document } = {}) {
  const rows = [...root.querySelectorAll('.hz-labels, .hz-times')];
  if (!rows.length) return () => {};
  let alive = true, frame = null;
  const layout = () => {
    frame = null;
    if (!alive) return;
    for (const row of rows) {
      const bounds = row.getBoundingClientRect();
      if (!bounds.width) continue;
      const labels = [...row.children];
      for (const label of labels) label.style.translate = '0px';
      const boxes = labels.map((label) => {
        const { left, right, height } = label.getBoundingClientRect();
        return { left, right, height, priority: Number(label.dataset.labelPriority) };
      });
      const fit = fitHorizonLabels(boxes, bounds.left, bounds.right);
      let height = 0;
      labels.forEach((label, i) => {
        label.style.translate = `${fit[i].shift}px`;
        label.style.visibility = fit[i].visible ? 'visible' : 'hidden';
        if (fit[i].visible) height = Math.max(height, boxes[i].height);
      });
      row.style.height = `${Math.ceil(height)}px`;
    }
  };
  const schedule = () => { if (alive && frame === null) frame = win.requestAnimationFrame(layout); };
  const observer = win.ResizeObserver ? new win.ResizeObserver(schedule) : null;
  for (const row of rows) { observer?.observe(row); for (const label of row.children) observer?.observe(label); }
  win.addEventListener('resize', schedule);
  doc.fonts?.addEventListener('loadingdone', schedule);
  doc.fonts?.ready.then(schedule);
  layout();
  return () => {
    alive = false; observer?.disconnect();
    if (frame !== null) win.cancelAnimationFrame(frame);
    win.removeEventListener('resize', schedule);
    doc.fonts?.removeEventListener('loadingdone', schedule);
  };
}
