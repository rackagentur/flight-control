// Shared presentational components (markup only; behaviour is wired by the screen or main.js).

import { html } from '../lib/html.js';
import { icon } from './icons.js';
import { getThemePreference } from '../theme.js';

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

export function slot(label, phase) {
  return html`<div class="slot"><span>${label}</span><span class="slot-phase">${phase}</span></div>`;
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
