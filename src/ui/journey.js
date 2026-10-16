// Journey view: one rotation drawn as one continuous vertical line (the Duty Horizon motif
// turned vertical). Sectors are stops on the line; the ground between them carries meaning by
// line style AND text, never colour alone:
//   flight            solid line, node at departure
//   turnaround        thin solid line, "55m on the ground"
//   layover inferred  dotted line, "Layover · inferred"
//   layover roster    double line, "Layover · from roster"
//   return not listed dashed line fading out, "Return not yet listed"
// Flown sectors recede and say "Flown"; the selected sector is marked with aria-current.
// Each sector is a card (flight-parts.sectorCard) on the rail: route blue line and node, copper ring when selected.

import { html } from '../lib/html.js';
import { opDate } from '../lib/op-time.js';
import { hrefFor } from '../router.js';
import { clock } from './duty.js';
import { sectorCard } from './flight-parts.js';
import { destinationTeaser, stayLabel, stayText } from './destination.js';

function sectorLeg(e, { selectedId }) {
  const s = e.sector;
  const selected = s.id === selectedId;
  return html`
    <li class="jr-leg jr-sector is-${e.status} ${s.provenance === 'history' ? 'is-remembered' : ''} ${selected ? 'is-selected' : ''}">
      ${sectorCard({ sector: s, entry: e, selected, href: hrefFor('flights', s.id) })}
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
  // The date pairs with the times beside it, so it follows the display mode (opDate): the origin's
  // local date in Local mode (UTC when its zone is unknown), the UTC date in UTC mode.
  const date = opDate(leg.duty.sectors[0].dep, leg.originTz);
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
