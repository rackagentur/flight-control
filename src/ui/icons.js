// Inline SVG icon set: 24px grid, 1.6 stroke, round joins, currentColor.
// Drawn for Flight Control (no icon-font or CDN dependency). Static, trusted markup.

import { raw, escapeHtml } from '../lib/html.js';

const PATHS = {
  today: '<path d="M3 16.5h18"/><path d="M7 16.5a5 5 0 0 1 10 0"/><path d="M12 6.5V4.5M5.9 9.4 4.5 8M18.1 9.4 19.5 8"/><path d="M8 20h8"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M8 14h2M14 14h2M8 17h2"/>',
  flights: '<path d="M12 3c.8 0 1.4.7 1.4 1.5v5l7.1 4.1v1.9l-7.1-2.2v4.4l2.1 1.6V21L12 20.1 8.5 21v-1.7l2.1-1.6v-4.4l-7.1 2.2v-1.9l7.1-4.1v-5C10.6 3.7 11.2 3 12 3z"/>',
  map: '<path d="M9 4.5 3.5 6.5v13l5.5-2 6 2 5.5-2v-13l-5.5 2-6-2z"/><path d="M9 4.5v13M15 6.5v13"/>',
  more: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12h.01M12 12h.01M16 12h.01" stroke-width="2.4"/>',
  weather: '<path d="M8.5 5.5V4M4.6 7.1l-1-1M12.4 7.1l1-1"/><path d="M5.2 11.2A3.6 3.6 0 0 1 11.8 9"/><path d="M8 19.5h9a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.6 1.2A2.9 2.9 0 0 0 8 19.5z"/>',
  statistics: '<path d="M4 20h16"/><rect x="5.5" y="11" width="3" height="6.5" rx="1"/><rect x="10.5" y="6.5" width="3" height="11" rx="1"/><rect x="15.5" y="13.5" width="3" height="4" rx="1"/>',
  controls: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  settings: '<circle cx="12" cy="12" r="2.8"/><circle cx="12" cy="12" r="6.2"/><path d="M12 3.5v2.3M12 18.2v2.3M3.5 12h2.3M18.2 12h2.3M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6"/>',
  chevron: '<path d="m9.5 6 6 6-6 6"/>',
  source: '<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6"/><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
  appearance: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor" stroke="none"/>',
  profile: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  sync: '<path d="M19.5 12a7.5 7.5 0 0 1-12.8 5.3M4.5 12a7.5 7.5 0 0 1 12.8-5.3"/><path d="M17.5 3.5v3.3h-3.3M6.5 20.5v-3.3h3.3"/>',
  report: '<path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4M10 12h5M10 15.5h5"/>',
  hotel: '<path d="M3.5 18.5v-11M3.5 14h17v4.5M20.5 14v-2.5a3 3 0 0 0-3-3H11V14"/><circle cx="7.5" cy="11" r="1.8"/>',
  reset: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  horizon: '<path d="M3 15h18" stroke-dasharray="1.5 3"/><circle cx="8" cy="15" r="1.6"/><circle cx="16" cy="15" r="1.6"/><path d="M8 15h8"/>',
};

export function icon(name, label = null) {
  const body = PATHS[name] ?? PATHS.info;
  const a11y = label ? `role="img" aria-label="${escapeHtml(label)}"` : 'aria-hidden="true" focusable="false"';
  return raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${body}</svg>`);
}

/** Brand mark: an earth-tone horizon with the duty arc. */
export function brandMark() {
  return raw(`<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <defs><linearGradient id="fc-brand-g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#EDE3D6"/><stop offset=".58" stop-color="#C9B193"/><stop offset="1" stop-color="#3A5B7C"/>
    </linearGradient></defs>
    <rect width="32" height="32" rx="9" fill="url(#fc-brand-g)"/>
    <path d="M6 20.5h20" stroke="#1B232C" stroke-width="1.4" stroke-linecap="round"/>
    <path d="M10.5 20.5a5.5 5.5 0 0 1 11 0" fill="none" stroke="#1B232C" stroke-width="1.4"/>
    <circle cx="20.4" cy="17.6" r="1.7" fill="#1B232C"/>
  </svg>`);
}
