// Journey view: one rotation drawn as one continuous vertical line (the Duty Horizon motif
// turned vertical). Sectors are stops on the line; the ground between them carries meaning by
// line style AND text, never colour alone:
//   flight            solid line, node at departure
//   turnaround        thin solid line, "55m on the ground"
//   layover inferred  dotted line, "Layover · inferred"
//   layover roster    double line, "Layover · from roster"
//   return not listed dashed line fading out, "Return not yet listed"
// Flown sectors recede and say "Flown"; the selected sector is marked with aria-current.

import { html } from '../lib/html.js';
import { formatDate, formatDuration } from '../lib/time.js';
import { hrefFor } from '../router.js';
import { clock } from './duty.js';
import { destinationTeaser, stayLabel, stayText } from './destination.js';

const STATUS_TEXT = { past: 'Flown', active: 'In the air' };

function shiftMark(shift) {
  if (!shift) return '';
  return html`<sup class="pass-shift" aria-label="${shift > 0 ? `plus ${shift} day` : `minus ${-shift} day`}">${shift > 0 ? `+${shift}` : shift}</sup>`;
}

function sectorLeg(e, { selectedId, homeTz }) {
  const s = e.sector;
  const selected = s.id === selectedId;
  const status = STATUS_TEXT[e.status];
  const label = `${s.flightNumber}, ${s.origin} ${clock(s.dep, s.originTz)} to ${s.destination} ${clock(s.arr, s.destTz)}${e.shift ? ` (${e.shift > 0 ? '+' : ''}${e.shift} day)` : ''}, ${formatDate(s.dep, s.originTz ?? 'UTC')}${status ? `, ${status.toLowerCase()}` : ''}${s.provenance === 'history' ? ', remembered on this device' : ''}`;
  return html`
    <li class="jr-leg jr-sector is-${e.status} ${s.provenance === 'history' ? 'is-remembered' : ''} ${selected ? 'is-selected' : ''}">
      <a class="jr-link" href="${hrefFor('flights', s.id)}" data-sector="${s.id}" aria-label="${label}" ${selected ? html`aria-current="true"` : ''}>
        <span class="jr-node" aria-hidden="true"></span>
        <span class="jr-main" aria-hidden="true">
          <span class="jr-route t-tabular"><span class="jr-end"><b>${s.origin}</b> ${clock(s.dep, s.originTz)}</span><span class="jr-end"><span class="jr-arrow">→</span> <b>${s.destination}</b> ${clock(s.arr, s.destTz)}${shiftMark(e.shift)}</span></span>
          <span class="jr-sub"><span class="t-code">${s.flightNumber}</span> · ${formatDuration(s.blockMin)}${status ? html` · <span class="jr-status">${status}</span>` : ''}${s.provenance === 'history' ? html` · <span class="fl-tag tag-remembered jr-tag">Remembered</span>` : ''}</span>
        </span>
        <span class="jr-chev" aria-hidden="true">›</span>
      </a>
    </li>`;
}

function stayLeg(leg, weatherFor) {
  const { stay, entry } = leg;
  const kindClass = stay.kind === 'layover' ? `kind-layover is-${stay.confidence}` : `kind-${stay.kind}`;
  const teaser = stay.kind === 'turn' || stay.kind === 'gap' ? '' : destinationTeaser(entry.destination, weatherFor(entry.destination));
  return html`
    <li class="jr-leg jr-stay ${kindClass}">
      <span class="jr-stay-text">${stay.kind === 'open'
        ? html`<span class="jr-stay-label">Return not yet listed</span>`
        : stay.kind === 'gap'
        ? html`<span class="jr-stay-label">${stayLabel(stay)}</span> ${stayText(stay)}`
        : html`<span class="jr-stay-label">${stayLabel(stay)}</span> ${stayText(stay)}`}</span>
      ${teaser ? html`<span class="jr-teaser">${teaser}</span>` : ''}
    </li>`;
}

function dutyLeg(leg, homeTz) {
  // Dates follow the clock shown: local time, or UTC when the airport's zone is unknown.
  const date = formatDate(leg.duty.sectors[0].dep, leg.originTz ?? 'UTC');
  const times = [
    leg.wakeup !== null ? html`Wake-up <b>${clock(leg.wakeup, leg.originTz)}</b>` : null,
    leg.pickup !== null ? html`Pickup <b>${clock(leg.pickup, leg.originTz)}</b>` : null,
  ].filter(Boolean);
  return html`
    <li class="jr-leg jr-day">
      <span class="jr-day-date">${date}</span>
      ${times.length ? html`<span class="jr-day-times t-tabular">${times.map((t, i) => html`${i ? ' · ' : ''}${t}`)}</span>` : ''}
    </li>`;
}

/**
 * @param {object} journey  one entry of buildFlights().upcoming / recent rotations
 * @param {{selectedId?: string|null, homeTz: string, weatherFor: (dest) => object|null}} options
 */
export function journeyView(journey, { selectedId = null, homeTz, weatherFor }) {
  const last = journey.sectors.at(-1)?.sector;
  return html`
    <ol class="jr ${journey.openStart ? 'open-start' : ''} ${journey.openEnd ? 'open-end' : ''}" role="list">
      ${journey.openStart ? html`<li class="jr-leg jr-note">Started before the data this device has</li>` : ''}
      ${journey.legs.map((leg) => {
        if (leg.type === 'duty') return dutyLeg(leg, homeTz);
        if (leg.type === 'sector') return sectorLeg(leg.entry, { selectedId, homeTz });
        return stayLeg(leg, weatherFor);
      })}
      ${journey.rotation.closed && last ? html`<li class="jr-leg jr-finish"><span class="jr-node" aria-hidden="true"></span><span>Back at <b>${last.destination}</b></span></li>` : ''}
    </ol>`;
}
