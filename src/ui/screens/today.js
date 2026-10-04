// Today: operational-state-first.
// Phase 3: no roster source exists yet, so the honest state is UNKNOWN. The environment
// preview below is design documentation, labelled PREVIEW, and contains no roster data.

import { html, render } from '../../lib/html.js';
import { pageHeader, previewBadge, slot } from '../components.js';
import { ENVIRONMENTS, TONES, environment } from '../environments.js';

// Design-preview selection (UI state only). Defaults to Flight, never Off, so the preview
// cannot be read as a claim about today. Whether it is applied app-wide is owned by main.js.
const preview = { state: 'flight', tone: 'ocean' };

function greeting(now) {
  const hour = now.getHours();
  if (hour < 5) return 'Good night';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function statusHero() {
  return html`
    <section class="hero" data-state="unknown" aria-labelledby="status-title">
      <div class="hero-top">
        <div class="hero-kicker">
          <span class="t-eyebrow">Operational status</span>
          <span class="status-pill" data-confidence="unknown">Unknown</span>
        </div>
        <h2 class="hero-state t-display" id="status-title">Not yet known</h2>
        <p class="hero-lede t-body">Connect a roster source to see whether you are off, on duty, on standby or away.
          Flight Control never guesses a state it cannot prove.</p>
      </div>
      <div class="hero-foot slot-list" aria-label="Arriving with the roster source">
        ${slot('Next operational event and countdown', 'Phase 4')}
        ${slot('Duty Horizon', 'Phase 4')}
      </div>
    </section>`;
}

function previewHero() {
  const env = environment(preview.state);
  const tone = preview.state === 'layover' ? TONES.find((t) => t.tone === preview.tone) : null;
  return html`
    <div class="hero" data-state="${env.state}" ${tone ? html`data-tone="${tone.tone}"` : ''} id="preview-hero">
      <div class="hero-top">
        <div class="hero-kicker">
          <span class="t-eyebrow">${env.family}${tone ? html` · ${tone.name}` : ''}</span>
          ${previewBadge('Preview')}
        </div>
        <p class="hero-state t-display">${env.name}</p>
        <p class="hero-lede t-body">${env.intent}</p>
      </div>
      <div class="hero-foot">
        <div class="palette-strip" aria-hidden="true">
          <span style="background: var(--st-atmos-1)"></span>
          <span style="background: var(--st-atmos-2)"></span>
          <span style="background: var(--st-atmos-3)"></span>
          <span style="background: var(--st-accent)"></span>
          <span style="background: var(--st-ink)"></span>
        </div>
        <p class="t-caption t-secondary">Design preview of the ${env.name.toLowerCase()} environment. No roster data.</p>
      </div>
    </div>`;
}

function previewSection(ctx) {
  return html`
    <section class="section" aria-labelledby="env-title">
      <div class="section-head">
        <h2 class="t-eyebrow" id="env-title">Environments</h2>
        ${previewBadge('Preview · not roster data')}
      </div>
      <div class="preview-controls">
        <div class="chip-row" role="group" aria-label="Preview environment">
          ${ENVIRONMENTS.map((env) => html`
            <button type="button" class="chip" data-state="${env.state}" data-preview-state="${env.state}"
              aria-pressed="${env.state === preview.state ? 'true' : 'false'}">
              <span class="chip-swatch" aria-hidden="true"></span>${env.name}
            </button>`)}
        </div>
        <div class="tone-row" ${preview.state === 'layover' ? '' : html`hidden`}>
          <div class="segmented segmented-compact" role="radiogroup" aria-label="Layover tone">
            ${TONES.map((t) => html`
              <button type="button" role="radio" data-preview-tone="${t.tone}"
                aria-checked="${t.tone === preview.tone ? 'true' : 'false'}"
                tabindex="${t.tone === preview.tone ? '0' : '-1'}">${t.name}</button>`)}
          </div>
        </div>
        <div id="preview-hero-slot" aria-live="polite">${previewHero()}</div>
        <div class="preview-apply">
          <div>
            <p class="t-callout">Preview across the app</p>
            <p class="preview-note">Temporarily tints the whole app with this environment. A banner stays visible until you exit.</p>
          </div>
          <button type="button" class="switch" role="switch" id="preview-app-switch"
            aria-checked="${ctx.isAppPreviewActive() ? 'true' : 'false'}" aria-label="Preview across the app"></button>
        </div>
      </div>
    </section>`;
}

function contextPane() {
  return html`
    <aside class="today-context" aria-label="Context">
      <section class="section">
        <div class="section-head"><h2 class="t-eyebrow">This week</h2></div>
        ${slot('7-day roster', 'Phase 4')}
      </section>
      <section class="section">
        <div class="section-head"><h2 class="t-eyebrow">Destination</h2></div>
        <div class="slot-list">${slot('Weather at next destination', 'Phase 6')}${slot('Local times', 'Phase 4')}</div>
      </section>
      <section class="section">
        <div class="section-head"><h2 class="t-eyebrow">Rest</h2></div>
        <div class="slot-list">${slot('Next days off', 'Phase 4')}${slot('Duty block', 'Phase 4')}</div>
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
          <div class="today-main">
            ${statusHero()}
            ${previewSection(ctx)}
          </div>
          ${contextPane()}
        </div>
      </div>`;
  },

  mount(root, ctx) {
    const refreshPreview = () => {
      render(root.querySelector('#preview-hero-slot'), previewHero());
      for (const chip of root.querySelectorAll('[data-preview-state]')) {
        chip.setAttribute('aria-pressed', String(chip.dataset.previewState === preview.state));
      }
      for (const button of root.querySelectorAll('[data-preview-tone]')) {
        const on = button.dataset.previewTone === preview.tone;
        button.setAttribute('aria-checked', String(on));
        button.tabIndex = on ? 0 : -1;
      }
      root.querySelector('.tone-row').hidden = preview.state !== 'layover';
      if (ctx.isAppPreviewActive()) ctx.setAppPreview(preview.state, preview.tone);
    };

    const onClick = (event) => {
      const chip = event.target.closest('[data-preview-state]');
      if (chip) { preview.state = chip.dataset.previewState; refreshPreview(); return; }
      const tone = event.target.closest('[data-preview-tone]');
      if (tone) { preview.tone = tone.dataset.previewTone; refreshPreview(); return; }
      const toggle = event.target.closest('#preview-app-switch');
      if (toggle) {
        if (ctx.isAppPreviewActive()) ctx.clearAppPreview();
        else ctx.setAppPreview(preview.state, preview.tone);
        toggle.setAttribute('aria-checked', String(ctx.isAppPreviewActive()));
      }
    };

    const onPreviewCleared = () => {
      root.querySelector('#preview-app-switch')?.setAttribute('aria-checked', 'false');
    };

    root.addEventListener('click', onClick);
    document.addEventListener('fc:preview-cleared', onPreviewCleared);
    return () => {
      root.removeEventListener('click', onClick);
      document.removeEventListener('fc:preview-cleared', onPreviewCleared);
    };
  },
};

