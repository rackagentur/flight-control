// Aviation components: pure template functions (no state, no model access beyond what is passed in).
//   routeHero      the route as identity: bold airport codes, copper arrows, optional city line
//   sectorCard     one flight as a card: copper aircraft mark, codes + times, flight number, status
//   milestoneRow   one timing milestone (wake-up, pickup, departure, arrival): icon, time, label
//   statusChip     operational status, shown only when the model actually holds that status
//   sectorStatus   the only mapping from a sector's state to a chip (never On time / gate / delay)
// Colour roles: copper = identity and emphasis (aircraft mark, arrows, milestone glyphs);
// aviation blue = routes and flight progression (the rail, drawn by the journey); status colour = state only.

import { html } from '../lib/html.js';
import { formatDate, formatDuration } from '../lib/time.js';
import { icon } from './icons.js';
import { clock } from './duty.js';

const SIZES = new Set(['hero', 'title', 'inline']);

/** "+1" marker for a sector that lands on another local date. */
export function shiftMark(shift) {
  if (!shift) return '';
  return html`<sup class="pass-shift" aria-label="${shift > 0 ? `plus ${shift} day` : `minus ${-shift} day`}">${shift > 0 ? `+${shift}` : shift}</sup>`;
}

/**
 * Route as identity: AAA → BBB → CCC → BBB. Arrows are decorative; a visually hidden " to " keeps the
 * accessible name readable ("AAA to BBB"). Cities appear under their code only when provided.
 * `as: 'span'` renders the root as a span so it can sit inside a heading.
 * @param {{codes: string[], cities?: (string|null)[]|null, size?: 'hero'|'title'|'inline', id?: string|null, label?: string|null, as?: 'div'|'span'}} options
 */
export function routeHero({ codes, cities = null, size = 'title', id = null, label = null, as = 'div' }) {
  const tag = as === 'span' ? 'span' : 'div';
  const sized = SIZES.has(size) ? size : 'title';
  const stop = (code, i) => html`<span class="rh-stop"><span class="rh-code t-airport">${code}</span>${cities?.[i] ? html`<span class="rh-city" aria-hidden="true">${cities[i]}</span>` : ''}</span>`;
  const attrs = html`${id ? html` id="${id}"` : ''}${label ? html` role="img" aria-label="${label}"` : ''}`;
  return html`<${tag} class="route-hero rh-${sized}"${attrs}>${codes.map((code, i) => (i === 0
    ? stop(code, i)
    : html`<span class="rh-leg"><span class="rh-arrow" aria-hidden="true">→</span><span class="visually-hidden"> to </span>${stop(code, i)}</span>`))}</${tag}>`;
}

/** Operational status chip. Neutral carries no data-status (the dot stays secondary ink). */
export function statusChip({ tone = 'neutral', label }) {
  const t = ['positive', 'caution', 'critical'].includes(tone) ? tone : null;
  return html`<span class="chip-status" ${t ? html`data-status="${t}"` : ''}>${label}</span>`;
}

/**
 * The status a sector can truthfully show. Derived only from time against `now` (entry.status):
 * in the air, flown, or nothing. Roster sectors carry no punctuality, gate, stand or delay data,
 * so none is ever produced here.
 * @returns {{tone: 'positive'|'neutral', label: string}|null}
 */
export function sectorStatus(entry, sector = entry?.sector) {
  if (!entry || !sector) return null;
  if (entry.status === 'active') return { tone: 'positive', label: 'In the air' };
  if (entry.status === 'past') return { tone: 'neutral', label: 'Flown' };
  return null;
}

/** Accessible name of a sector link (read as one phrase; the visual children are aria-hidden). */
export function sectorLabel(e, s = e.sector) {
  const status = sectorStatus(e, s);
  return `${s.flightNumber}, ${s.origin} ${clock(s.dep, s.originTz)} to ${s.destination} ${clock(s.arr, s.destTz)}${e.shift ? ` (${e.shift > 0 ? '+' : ''}${e.shift} day)` : ''}, ${formatDate(s.dep, s.originTz ?? 'UTC')}${status ? `, ${status.label.toLowerCase()}` : ''}${s.provenance === 'history' ? ', remembered on this device' : ''}`;
}

/**
 * One flight as a card. With an `href` it is the journey link: <a class="jr-link" href data-sector aria-label aria-current>.
 * With `href: null` it is a static card (<div class="jr-link is-static">): same inner structure, no link, no
 * aria-current, no chevron, and the visual text stays readable (the aria-label/aria-hidden pair exists only to
 * give a link one accessible name). `compact` is the smaller tile and type for day lists (no rail node).
 * @param {{sector: object, entry: object, selected?: boolean, href: string|null, compact?: boolean}} options
 */
export function sectorCard({ sector: s, entry: e, selected = false, href, compact = false }) {
  const status = sectorStatus(e, s);
  const isLink = typeof href === 'string';
  const cls = `jr-link${compact ? ' sc-compact' : ''}${isLink ? '' : ' is-static'}`;
  const inner = html`${compact ? '' : html`<span class="jr-node" aria-hidden="true"></span>`}
        <span class="sc-mark" aria-hidden="true">${icon('aircraft')}</span>
        <span class="jr-main"${isLink ? html` aria-hidden="true"` : ''}>
          <span class="jr-route t-tabular"><span class="jr-end"><b>${s.origin}</b> ${clock(s.dep, s.originTz)}</span><span class="jr-end"><span class="jr-arrow"${isLink ? '' : html` aria-hidden="true"`}>→</span> <b>${s.destination}</b> ${clock(s.arr, s.destTz)}${shiftMark(e.shift)}</span></span>
          <span class="jr-sub"><span class="t-code">${s.flightNumber}</span><span class="jr-dot">·</span><span>${formatDuration(s.blockMin)}</span>${status ? html`<span class="jr-status">${statusChip(status)}</span>` : ''}${s.provenance === 'history' ? html`<span class="fl-tag tag-remembered jr-tag">Remembered</span>` : ''}</span>
        </span>
        ${isLink ? html`<span class="jr-chev" aria-hidden="true">›</span>` : ''}`;
  if (!isLink) return html`<div class="${cls}" data-sector="${s.id}">${inner}</div>`;
  return html`<a class="${cls}" href="${href}" data-sector="${s.id}" aria-label="${sectorLabel(e, s)}" ${selected ? html`aria-current="true"` : ''}>${inner}</a>`;
}

/**
 * "in 4h 20m": how far away an event is. Null unless the event is still ahead of `nowMs`,
 * so a milestone that has passed never claims a countdown.
 */
export function relativeIn(nowMs, targetMs) {
  if (typeof nowMs !== 'number' || typeof targetMs !== 'number' || !Number.isFinite(nowMs) || !Number.isFinite(targetMs)) return null;
  const ms = targetMs - nowMs;
  if (ms <= 0) return null;
  if (ms < 60000) return 'in <1m';
  const total = Math.floor(ms / 60000);
  if (total < 60) return `in ${total}m`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h < 24) return m ? `in ${h}h ${m}m` : `in ${h}h`;
  const d = Math.floor(h / 24);
  const rest = h % 24;
  return rest ? `in ${d}d ${rest}h` : `in ${d}d`;
}

/**
 * One timing milestone. `time` may be text or html (an alarm link, a time with a +1 mark).
 * `relative` is shown only when given, i.e. only for events still ahead.
 */
export function milestoneRow({ icon: iconName, time, label, relative = null, note = null, emphasis = false }) {
  return html`<li class="ms-row${emphasis ? ' is-emphasis' : ''}">
      <span class="ms-icon" aria-hidden="true">${icon(iconName)}</span>
      <span class="ms-time t-tabular">${time}</span>
      <span class="ms-text"><span class="ms-label">${label}</span>${note ? html`<span class="ms-note">${note}</span>` : ''}</span>
      ${relative ? html`<span class="ms-rel t-tabular">${relative}</span>` : ''}
    </li>`;
}

/** @param {object[]} rows  milestoneRow() results */
export function milestoneList(rows) {
  return html`<ol class="ms-list" role="list">${rows}</ol>`;
}
