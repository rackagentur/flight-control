// Shared duty rendering: one presentation of flights, times and fields for Today and Calendar.
// All times are derived from instants + IANA zones; missing data is omitted, never invented.

import { html } from '../lib/html.js';
import { formatDuration } from '../lib/time.js';
import { opTime, opShift, opZoneNote, eventLocalTime, tzTag } from '../lib/op-time.js';
import { getTimeDisplay } from '../time-display.js';
import { airport } from '../data/airports.js';
import { icon } from './icons.js';

/**
 * An operational time in the chosen Time Display mode: the event zone's local time, or UTC.
 * With an unknown zone, Local mode says "HH:MM UTC" (never a guessed local time).
 * A thin wrapper over the shared formatting layer (lib/op-time.js).
 */
export function clock(ms, tz, mode = getTimeDisplay()) {
  return opTime(ms, tz, mode);
}

export const city = (iata) => airport(iata)?.city ?? iata;

/**
 * A time that sets a phone alarm. The visible text follows the Time Display mode; the Shortcut
 * payload never does: a phone alarm fires on the phone's own clock, so it always receives the
 * event-zone wall-clock time the roster is written in (unknown zone: the same "HH:MM UTC" text as before).
 */
export function alarmLink(profile, ms, tz, label, mode = getTimeDisplay()) {
  const value = clock(ms, tz, mode);
  const payload = eventLocalTime(ms, tz) ?? clock(ms, null, 'local');
  const href = `shortcuts://run-shortcut?name=${encodeURIComponent(profile.alarmShortcutName)}&input=text&text=${encodeURIComponent(payload)}`;
  const title = value === payload
    ? `Set an alarm for ${label} ${value} with the ${profile.alarmShortcutName} shortcut`
    : `Set an alarm for ${label} at ${payload} local time with the ${profile.alarmShortcutName} shortcut`;
  return html`<a class="pass-alarm" href="${href}" title="${title}">${value}</a>`;
}

export function field(label, value, note = null) {
  return html`
    <div class="pass-field">
      <dt class="t-eyebrow">${label}</dt>
      <dd>${value}${note ? html`<span class="pass-note">${note}</span>` : ''}</dd>
    </div>`;
}

export function zoneNote(ms, tz, profile, mode = getTimeDisplay()) {
  return opZoneNote(ms, tz, profile, mode);
}

/** A field label with a small decorative glyph (the text still carries the meaning). */
const iconLabel = (name, text) => html`<span class="pf-icon" aria-hidden="true">${icon(name)}</span>${text}`;

/** Fields describing a duty: wake-up, pickup, departure, arrival (+N), block, flight. */
export function dutyFields(duty, profile) {
  const first = duty.sectors[0];
  const last = duty.sectors.at(-1);
  const shift = opShift(first.dep, first.originTz, last.arr, last.destTz);
  const block = duty.sectors.reduce((sum, s) => sum + s.blockMin, 0);
  return html`
    ${duty.wakeup !== null ? field(iconLabel('bell', 'Wake-up'), alarmLink(profile, duty.wakeup, first.originTz, 'wake-up')) : ''}
    ${duty.pickup !== null ? field(iconLabel('car', 'Pickup'), alarmLink(profile, duty.pickup, first.originTz, 'pickup')) : ''}
    ${field(iconLabel('takeoff', 'Departure'), html`${clock(first.dep, first.originTz)}`, html`${city(first.origin)}${zoneNote(first.dep, first.originTz, profile) ? html` · ${zoneNote(first.dep, first.originTz, profile)}` : ''}`)}
    ${field(iconLabel('landing', 'Arrival'), html`${clock(last.arr, last.destTz)}${shift ? html`<sup class="pass-shift" aria-label="${shift > 0 ? `plus ${shift} day` : `minus ${-shift} day`}">${shift > 0 ? `+${shift}` : shift}</sup>` : ''}`,
      html`${city(last.destination)}${zoneNote(last.arr, last.destTz, profile) ? html` · ${zoneNote(last.arr, last.destTz, profile)}` : ''}`)}
    ${field('Block', formatDuration(block), duty.sectors.length > 1 ? `${duty.sectors.length} sectors` : null)}
    ${field('Flight', duty.sectors.map((s) => s.flightNumber).join(' · '))}`;
}

/** Local mode, zones with different offsets: the arrival zone's offset after the arrival time. */
export function sectorTag(s) {
  const tag = tzTag(s.dep, s.originTz, s.arr, s.destTz);
  return tag ? html` <span class="tz-tag">${tag}</span>` : '';
}

/** The same context for the card sub-line, where it never widens the route line: "· arr. UTC−4". */
export function sectorTagSub(s) {
  const tag = tzTag(s.dep, s.originTz, s.arr, s.destTz);
  return tag ? html`<span class="jr-dot">·</span><span class="tz-tag">arr. ${tag}</span>` : '';
}

export function sectorList(duty) {
  if (duty.sectors.length < 2) return '';
  return html`
    <ol class="pass-sectors" role="list">
      ${duty.sectors.map((s) => html`
        <li><span class="t-code">${s.flightNumber}</span> ${s.origin} ${clock(s.dep, s.originTz)} → ${s.destination} ${clock(s.arr, s.destTz)}${sectorTag(s)}</li>`)}
    </ol>`;
}

/** The airports of a duty in order: origin, then every sector's destination. */
export function routeCodes(duty) {
  return [duty.sectors[0].origin, ...duty.sectors.map((s) => s.destination)];
}

export function routeTitle(duty) {
  return routeCodes(duty).join(' → ');
}
