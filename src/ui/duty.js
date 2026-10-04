// Shared duty rendering: one presentation of flights, times and fields for Today and Calendar.
// All times are derived from instants + IANA zones; missing data is omitted, never invented.

import { html } from '../lib/html.js';
import { formatTime, formatUtcOffset, offsetMinutes, dayShift, formatDuration } from '../lib/time.js';
import { airport } from '../data/airports.js';

/** Local time with an explicit marker when the zone is unknown (never a guessed local time). */
export function clock(ms, tz) {
  return tz ? formatTime(ms, tz) : `${formatTime(ms, 'UTC')} UTC`;
}

export const city = (iata) => airport(iata)?.city ?? iata;

export function alarmLink(profile, ms, tz, label) {
  const value = clock(ms, tz);
  const href = `shortcuts://run-shortcut?name=${encodeURIComponent(profile.alarmShortcutName)}&input=text&text=${encodeURIComponent(value)}`;
  return html`<a class="pass-alarm" href="${href}" title="Set an alarm for ${label} ${value} with the ${profile.alarmShortcutName} shortcut">${value}</a>`;
}

export function field(label, value, note = null) {
  return html`
    <div class="pass-field">
      <dt class="t-eyebrow">${label}</dt>
      <dd>${value}${note ? html`<span class="pass-note">${note}</span>` : ''}</dd>
    </div>`;
}

export function zoneNote(ms, tz, profile) {
  if (!tz) return 'Time zone unknown (UTC shown)';
  if (offsetMinutes(ms, tz) === offsetMinutes(ms, profile.homeTz)) return null;
  return `${formatUtcOffset(ms, tz)} · ${formatTime(ms, profile.homeTz)} at home`;
}

/** Fields describing a duty: wake-up, pickup, departure, arrival (+N), block, flight. */
export function dutyFields(duty, profile) {
  const first = duty.sectors[0];
  const last = duty.sectors.at(-1);
  const shift = first.originTz && last.destTz ? dayShift(first.dep, first.originTz, last.arr, last.destTz) : null;
  const block = duty.sectors.reduce((sum, s) => sum + s.blockMin, 0);
  return html`
    ${duty.wakeup !== null ? field('Wake-up', alarmLink(profile, duty.wakeup, first.originTz, 'wake-up')) : ''}
    ${duty.pickup !== null ? field('Pickup', alarmLink(profile, duty.pickup, first.originTz, 'pickup')) : ''}
    ${field('Departure', html`${clock(first.dep, first.originTz)}`, html`${city(first.origin)}${zoneNote(first.dep, first.originTz, profile) ? html` · ${zoneNote(first.dep, first.originTz, profile)}` : ''}`)}
    ${field('Arrival', html`${clock(last.arr, last.destTz)}${shift ? html`<sup class="pass-shift" aria-label="${shift > 0 ? `plus ${shift} day` : `minus ${-shift} day`}">${shift > 0 ? `+${shift}` : shift}</sup>` : ''}`,
      html`${city(last.destination)}${zoneNote(last.arr, last.destTz, profile) ? html` · ${zoneNote(last.arr, last.destTz, profile)}` : ''}`)}
    ${field('Block', formatDuration(block), duty.sectors.length > 1 ? `${duty.sectors.length} sectors` : null)}
    ${field('Flight', duty.sectors.map((s) => s.flightNumber).join(' · '))}`;
}

export function sectorList(duty) {
  if (duty.sectors.length < 2) return '';
  return html`
    <ol class="pass-sectors" role="list">
      ${duty.sectors.map((s) => html`
        <li><span class="t-code">${s.flightNumber}</span> ${s.origin} ${clock(s.dep, s.originTz)} → ${s.destination} ${clock(s.arr, s.destTz)}</li>`)}
    </ol>`;
}

export function routeTitle(duty) {
  return [duty.sectors[0].origin, ...duty.sectors.map((s) => s.destination)].join(' → ');
}
