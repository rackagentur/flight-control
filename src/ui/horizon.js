// Duty Horizon view. A thin luminous line through the rotation: phases are spans, milestones
// are small stops, and "now" is a soft point of light. Past phases recede, the current phase
// carries the state accent, upcoming phases are drawn as a faint dotted continuation.
// Not a progress bar: positions follow the sequence of the duty, not a percentage.

import { html } from '../lib/html.js';
import { formatTime } from '../lib/time.js';

const pct = (x) => `${(x * 100).toFixed(2)}%`;
const time = (stop) => (stop.tz ? formatTime(stop.at, stop.tz) : `${formatTime(stop.at, 'UTC')}Z`);

const STOP_LABEL = { wakeup: 'Wake-up', pickup: 'Pickup', briefing: 'Briefing' };

function summary(h) {
  const parts = h.stops.map((s) => {
    const what = STOP_LABEL[s.kind] ?? `${s.kind === 'departure' ? 'Depart' : 'Arrive'} ${s.code}`;
    return `${what} ${time(s)}${s.status === 'past' ? ' (done)' : s.next ? ' (next)' : ''}`;
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
export function horizonView(h, { variant = 'full' } = {}) {
  if (!h) return '';
  const labelled = h.spans.filter((s) => s.label && s.kind !== 'before');
  const mid = (s) => (s.x0 + s.x1) / 2;
  const phaseMinor = markMinor(labelled, mid, (s) => (s.status === 'current' ? 0 : s.status === 'upcoming' ? 1 : 2), 0.26);
  const stopRank = (s) => (s.next ? 0 : s === h.stops.at(-1) ? 1 : s.kind === 'departure' ? 2 : s.kind === 'arrival' ? 3 : 4);
  const timeMinor = markMinor(h.stops, (s) => s.x, stopRank, 0.24);
  return html`
    <figure class="horizon horizon-${variant} horizon-${h.mode}" role="img" aria-label="${summary(h)}">
      <div class="hz-labels" aria-hidden="true">
        ${labelled.map((s) => html`
          <span class="hz-phase is-${s.status} ${phaseMinor.has(s) ? 'is-minor' : ''}" style="left:${pct((s.x0 + s.x1) / 2)}">${s.label}</span>`)}
      </div>
      <div class="hz-track" aria-hidden="true">
        ${h.spans.map((s) => html`
          <span class="hz-span hz-${s.kind} is-${s.status}" style="left:${pct(s.x0)};width:${pct(s.x1 - s.x0)}"></span>`)}
        ${h.stops.map((s) => html`
          <span class="hz-stop hz-stop-${s.kind} is-${s.status} ${s.next ? 'is-next' : ''}" style="left:${pct(s.x)}"></span>`)}
        ${h.mode === 'upcoming' ? '' : html`<span class="hz-now" style="left:${pct(h.now.x)}"></span>`}
      </div>
      <div class="hz-times" aria-hidden="true">
        ${h.stops.map((s) => html`
          <span class="hz-time hz-time-${s.kind} is-${s.status} ${s.next ? 'is-next' : ''} ${timeMinor.has(s) ? 'is-minor' : ''}" style="left:${pct(s.x)}">
            <span class="hz-time-label">${STOP_LABEL[s.kind] ?? s.code}</span>
            <span class="hz-time-value">${time(s)}</span>
          </span>`)}
      </div>
    </figure>`;
}
