// Review mode: a development/review control, never production content.
// Enabled per browser tab by opening the app with ?review (e.g. /?review#/today).
// Shows FICTIONAL sample data only (HOME/AWAY, SAMPLE flights), one scenario per state.
// While active, a banner stays at the top of every screen: SAMPLE DATA · NOT YOUR ROSTER.
// It never reads or writes production roster storage.

import { html, render } from '../lib/html.js';
import { ENVIRONMENTS, TONES } from './environments.js';

const KEY = 'fc.v2.review';

/** Calendar scenarios inside the fictional sample month (day offsets from today). */
export const CALENDAR_SCENARIOS = [
  { label: 'Mixed month', offset: null },
  { label: 'Long-haul rotation', offset: 5 },
  { label: 'Inferred layover', offset: 6 },
  { label: 'Roster layover', offset: 22 },
  { label: 'Duty', offset: 18 },
  { label: 'Standby / reserve week', offset: 12 },
  { label: 'Explicit OFF', offset: 16 },
  { label: 'UNKNOWN day', offset: 2 },
  { label: 'No data', offset: 27 },
];
export const REVIEW_LABEL = 'Sample data · not your roster';

function readSession() {
  try { return JSON.parse(sessionStorage.getItem(KEY) ?? 'null'); } catch { return null; }
}
function writeSession(value) {
  try {
    if (value) sessionStorage.setItem(KEY, JSON.stringify(value));
    else sessionStorage.removeItem(KEY);
  } catch { /* unavailable: review still works for this page view */ }
}

function dockMarkup(review) {
  return html`
    <div class="review-dock-head">
      <span class="t-eyebrow">Review mode · ${REVIEW_LABEL}</span>
      <button type="button" class="btn btn-quiet" data-review-exit>Exit review</button>
    </div>
    <div class="chip-row" role="radiogroup" aria-label="Sample scenario">
      ${ENVIRONMENTS.map((env) => {
        const on = env.state === review.state;
        return html`
          <button type="button" class="chip" role="radio" data-state="${env.state}" data-review-state="${env.state}"
            aria-checked="${on ? 'true' : 'false'}" tabindex="${on ? '0' : '-1'}">
            <span class="chip-swatch" aria-hidden="true"></span>${env.name}
          </button>`;
      })}
    </div>
    <div class="chip-row" role="group" aria-label="Calendar scenarios">
      ${CALENDAR_SCENARIOS.map((c) => html`<button type="button" class="chip" data-review-calendar="${c.offset ?? ''}">${c.label}</button>`)}
    </div>
    ${review.state === 'layover' ? html`
      <div class="segmented segmented-compact" role="radiogroup" aria-label="Layover destination tone">
        ${TONES.map((t) => html`
          <button type="button" role="radio" data-review-tone="${t.tone}"
            aria-checked="${t.tone === review.tone ? 'true' : 'false'}"
            tabindex="${t.tone === review.tone ? '0' : '-1'}">${t.name}</button>`)}
      </div>` : ''}`;
}

/** Converts the dock state into a controller mode. */
export function reviewMode(review) {
  return review ? { kind: 'sample', state: review.state, tone: review.tone } : { kind: 'production' };
}

/**
 * Mounts the dock and the top banner if review mode is requested (?review) or already active
 * in this tab. onChange(review | null) is called whenever the scenario changes or review ends.
 */
export function mountReviewDock(dock, banner, onChange, onCalendarScenario = () => {}) {
  const requested = new URLSearchParams(location.search).has('review');
  const initial = { state: 'flight', tone: 'ocean' };
  const stored = readSession();
  let review = stored ? { ...initial, state: stored.state ?? initial.state, tone: stored.tone ?? initial.tone } : (requested ? initial : null);
  if (review && !ENVIRONMENTS.some((e) => e.state === review.state)) review.state = initial.state;

  const paint = () => {
    banner.hidden = !review;
    document.documentElement.classList.toggle('is-review', Boolean(review));
    if (!review) { dock.hidden = true; dock.replaceChildren(); return; }
    render(dock, dockMarkup(review));
    dock.hidden = false;
  };

  const update = (next) => {
    const focused = dock.contains(document.activeElement) ? document.activeElement : null;
    const attr = focused ? ['reviewState', 'reviewTone'].find((k) => k in focused.dataset) : null;
    review = next;
    writeSession(review);
    paint();
    onChange(review);
    if (attr) dock.querySelector(`[data-${attr.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}][aria-checked="true"]`)?.focus();
  };

  dock.addEventListener('click', (event) => {
    const state = event.target.closest('[data-review-state]');
    if (state) { update({ ...review, state: state.dataset.reviewState }); return; }
    const scenario = event.target.closest('[data-review-calendar]');
    if (scenario) { onCalendarScenario(scenario.dataset.reviewCalendar === '' ? null : Number(scenario.dataset.reviewCalendar)); return; }
    const tone = event.target.closest('[data-review-tone]');
    if (tone) { update({ ...review, tone: tone.dataset.reviewTone }); return; }
    if (event.target.closest('[data-review-exit]')) {
      const url = new URL(location.href);
      url.searchParams.delete('review');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
      update(null);
    }
  });

  if (review) writeSession(review);
  paint();
  return { current: () => review };
}
