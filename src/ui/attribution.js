// The one place provider attribution is rendered: a short "Data: <name>" link inside an existing
// caption. rel is "noopener" only on purpose: referral data must not be suppressed.

import { html } from '../lib/html.js';

/** @param {{name:string, url:string}|null|undefined} a  a value from readAttribution() */
export function attributionText(a) {
  if (!a) return '';
  return html`<span class="attr">Data: <a class="attr-link" href="${a.url}" target="_blank" rel="noopener">${a.name}<span class="visually-hidden"> (opens in a new tab)</span></a></span>`;
}
