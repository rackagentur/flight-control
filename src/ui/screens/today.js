// Today: operational-state-first.
// Production order: status → next operational event → countdown → Duty Horizon → intelligence.
// Phase 3.x: no roster source exists, so the honest state is UNKNOWN. When design review
// mode is active (?review), the pass shows the reviewed environment, labelled as such.

import { html } from '../../lib/html.js';
import { pageHeader, previewBadge } from '../components.js';
import { environment, TONES } from '../environments.js';

function greeting(now) {
  const hour = now.getHours();
  if (hour < 5) return 'Good night';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function passHead(review) {
  if (!review) {
    return html`
      <div class="pass-head">
        <div class="pass-kicker">
          <span class="t-eyebrow">Operational status</span>
          <span class="status-pill" data-confidence="unknown">Unknown</span>
        </div>
        <h2 class="pass-state t-display" id="status-title">Not yet known</h2>
        <p class="pass-lede t-body">Connect a roster source to see whether you are off, on duty, on standby or away.
          Flight Control never guesses a state it cannot prove.</p>
      </div>`;
  }
  const env = environment(review.state);
  const tone = review.state === 'layover' ? TONES.find((t) => t.tone === review.tone) : null;
  return html`
    <div class="pass-head">
      <div class="pass-kicker">
        <span class="t-eyebrow">${env.family}${tone ? html` · ${tone.name}` : ''}</span>
        ${previewBadge('Review · not roster data')}
      </div>
      <h2 class="pass-state t-display" id="status-title">${env.name}</h2>
      <p class="pass-lede t-body">${env.intent}</p>
    </div>`;
}

function statusPass(review) {
  return html`
    <section class="pass" aria-labelledby="status-title">
      ${passHead(review)}
      <dl class="pass-fields">
        <div class="pass-field">
          <dt class="t-eyebrow">Next event</dt>
          <dd>—<span class="pass-note">Shown once roster data is connected</span></dd>
        </div>
        <div class="pass-field">
          <dt class="t-eyebrow">Countdown</dt>
          <dd>—<span class="pass-note">Live once roster data is connected</span></dd>
        </div>
      </dl>
      <div class="pass-horizon">
        <div class="pass-horizon-label"><span class="t-eyebrow">Duty Horizon</span><span class="t-caption">Phase 4</span></div>
        <div class="pass-horizon-track" aria-hidden="true"></div>
      </div>
    </section>`;
}

function intelligence() {
  const row = (label, value) => html`<div class="intel-row"><span class="intel-label">${label}</span><span class="intel-value">${value}</span></div>`;
  return html`
    <aside class="today-context" aria-label="Intelligence">
      <section class="section">
        <div class="section-head"><h2 class="t-eyebrow">This week</h2></div>
        <div class="intel">${row('7-day roster', 'Phase 4')}</div>
      </section>
      <section class="section">
        <div class="section-head"><h2 class="t-eyebrow">Destination</h2></div>
        <div class="intel">${row('Weather at next destination', 'Phase 6')}${row('Local times', 'Phase 4')}</div>
      </section>
      <section class="section">
        <div class="section-head"><h2 class="t-eyebrow">Rest</h2></div>
        <div class="intel">${row('Next days off', 'Phase 4')}${row('Duty block', 'Phase 4')}</div>
      </section>
    </aside>`;
}

export const today = {
  title: 'Today',

  render(ctx) {
    const now = new Date();
    const date = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
    return html`
      <div class="page">
        ${pageHeader({ eyebrow: date, title: greeting(now) })}
        <div class="today">
          <div class="today-main">${statusPass(ctx.review())}</div>
          ${intelligence()}
        </div>
      </div>`;
  },
};
