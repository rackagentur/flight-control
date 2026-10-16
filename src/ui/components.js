// Shared presentational components (markup only; behaviour is wired by the screen or main.js).

import { html } from '../lib/html.js';
import { icon } from './icons.js';
import { getThemePreference } from '../theme.js';
import { getTimeDisplay } from '../time-display.js';

const THEME_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

/** Light / Dark / System radio group. Every instance stays in sync via data-theme-control. */
export function themeControl({ compact = false, label = 'Appearance' } = {}) {
  const current = getThemePreference();
  return html`
    <div class="segmented ${compact ? 'segmented-compact' : ''}" role="radiogroup" aria-label="${label}" data-theme-control>
      ${THEME_OPTIONS.map((option) => html`
        <button type="button" role="radio" data-theme-value="${option.value}"
          aria-checked="${option.value === current ? 'true' : 'false'}"
          tabindex="${option.value === current ? '0' : '-1'}">${option.label}</button>
      `)}
    </div>`;
}

const TIME_DISPLAY_OPTIONS = [
  { value: 'local', label: 'Local' },
  { value: 'utc', label: 'UTC' },
];

/**
 * Local / UTC radio group for the Time Display preference (a separate setting from the theme, same
 * segmented design). Buttons carry data-time-display-value; main.js wires clicks and keeps it in sync.
 */
export function timeDisplayControl({ compact = false, label = 'Time display' } = {}) {
  const current = getTimeDisplay();
  return html`
    <div class="segmented ${compact ? 'segmented-compact' : ''}" role="radiogroup" aria-label="${label}" data-time-display-control>
      ${TIME_DISPLAY_OPTIONS.map((option) => html`
        <button type="button" role="radio" data-time-display-value="${option.value}"
          aria-checked="${option.value === current ? 'true' : 'false'}"
          tabindex="${option.value === current ? '0' : '-1'}">${option.label}</button>
      `)}
    </div>`;
}

export function pageHeader({ eyebrow, title, subtitle }) {
  return html`
    <header class="page-header">
      ${eyebrow ? html`<p class="t-eyebrow">${eyebrow}</p>` : ''}
      <h1 class="page-title t-title-1" tabindex="-1">${title}</h1>
      ${subtitle ? html`<p class="t-callout t-secondary">${subtitle}</p>` : ''}
    </header>`;
}

export function previewBadge(text = 'Preview') {
  return html`<span class="preview-badge">${text}</span>`;
}

/** Placeholder for a screen whose content arrives in a later phase. Says so plainly. */
export function upcomingScreen({ route, phase, summary, items }) {
  return html`
    <div class="placeholder">
      <div class="empty">
        <div class="empty-icon">${icon(route.icon)}</div>
        <p class="t-headline">${route.title} arrives in ${phase}</p>
        <p class="empty-text t-callout">${summary}</p>
        <ul class="empty-list">${items.map((item) => html`<li>${item}</li>`)}</ul>
      </div>
    </div>`;
}

export function listRow({ href = null, iconName, label, detail = null, trail = null, disabled = false, attrs = '' }) {
  const inner = html`
    <span class="list-icon">${icon(iconName)}</span>
    <span class="list-text"><span class="list-label">${label}</span>${detail ? html`<span class="list-detail">${detail}</span>` : ''}</span>
    <span class="list-trail">${trail ?? ''}${href && !disabled ? icon('chevron') : ''}</span>`;
  if (href && !disabled) return html`<a class="list-row" href="${href}">${inner}</a>`;
  return html`<div class="list-row" role="group" aria-disabled="${disabled ? 'true' : 'false'}" ${attrs}>${inner}</div>`;
}
