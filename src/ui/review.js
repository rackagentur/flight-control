// Design review dock: a development/review control, never production content.
// Enabled per browser tab by opening the app with ?review (e.g. /?review#/today).
// It applies an operational environment to the whole app so the atmosphere can be judged;
// every surface it affects says "Design review · not roster data".

import { html, render } from '../lib/html.js';
import { ENVIRONMENTS, TONES } from './environments.js';

const KEY = 'fc.v2.review';

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
      <span class="t-eyebrow">Design review · not roster data</span>
      <button type="button" class="btn btn-quiet" data-review-exit>Exit review</button>
    </div>
    <div class="chip-row" role="radiogroup" aria-label="Review environment">
      ${ENVIRONMENTS.map((env) => html`
        <button type="button" class="chip" role="radio" data-state="${env.state}" data-review-state="${env.state}"
          aria-checked="${env.state === review.state ? 'true' : 'false'}"
          tabindex="${env.state === review.state ? '0' : '-1'}">
          <span class="chip-swatch" aria-hidden="true"></span>${env.name}
        </button>`)}
    </div>
    ${review.state === 'layover' ? html`
      <div class="segmented segmented-compact" role="radiogroup" aria-label="Layover tone">
        ${TONES.map((t) => html`
          <button type="button" role="radio" data-review-tone="${t.tone}"
            aria-checked="${t.tone === review.tone ? 'true' : 'false'}"
            tabindex="${t.tone === review.tone ? '0' : '-1'}">${t.name}</button>`)}
      </div>` : ''}`;
}

/**
 * Mounts the dock if review mode is requested (?review) or already active in this tab.
 * onChange(review | null) is called whenever the reviewed environment changes or review ends.
 */
export function mountReviewDock(dock, onChange) {
  const requested = new URLSearchParams(location.search).has('review');
  let review = readSession() ?? (requested ? { state: 'unknown', tone: 'ocean' } : null);

  const paint = () => {
    if (!review) { dock.hidden = true; dock.replaceChildren(); return; }
    render(dock, dockMarkup(review));
    dock.hidden = false;
  };

  const update = (next) => {
    const focused = dock.contains(document.activeElement) ? document.activeElement : null;
    const group = focused?.dataset.reviewState ? 'state' : focused?.dataset.reviewTone ? 'tone' : null;
    review = next;
    writeSession(review);
    paint();
    onChange(review);
    // Keep keyboard focus on the selected option after the dock re-renders.
    if (group) dock.querySelector(`[data-review-${group}][aria-checked="true"]`)?.focus();
  };

  dock.addEventListener('click', (event) => {
    const state = event.target.closest('[data-review-state]');
    if (state) { update({ ...review, state: state.dataset.reviewState }); return; }
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
