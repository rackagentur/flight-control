// Pure helpers around ScheduledFlight (external schedule entries; see model/types.js).
// No I/O. Instants (epoch ms) only: no minute-of-day arithmetic, no "today" derived from UTC.
// This module decides nothing about any crew member: it only picks which listed flights fall in
// a time span.

import { airlineOf } from '../airlines/index.js';

const HOUR_MS = 3600000;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Where and for whom to list departures: the profile's base airport, filtered to the airline
 * pack's designators (null = no carrier filter, e.g. the generic pack).
 * @returns {{airport:string|null, carriers:string[]|null}}
 */
export function departuresContext(profile) {
  const designators = airlineOf(profile).flightDesignators;
  return Object.freeze({
    airport: profile?.base ?? null,
    carriers: Array.isArray(designators) && designators.length > 0 ? Object.freeze([...designators]) : null,
  });
}

/**
 * The instant range a window spans, or null when the window is invalid or longer than maxHours.
 * Overnight windows and DST nights work because only instants are compared.
 * @param {{start:number,end:number}} window
 */
export function rangeForWindow(window, { maxHours = 24 } = {}) {
  if (!window || !finite(window.start) || !finite(window.end) || window.end <= window.start) return null;
  if (!finite(maxHours) || maxHours <= 0 || window.end - window.start > maxHours * HOUR_MS) return null;
  return { from: window.start, to: window.end };
}

/**
 * Flights whose scheduledDep lies in [start, end) (half-open), ordered by scheduledDep then
 * flightNumber. revisedDep is deliberately NOT used for membership: it is a provider estimate
 * that moves, so a flight would hop in and out of a window between refreshes, whereas the
 * scheduled instant is stable and is what the provider's range query was filtered on.
 * @param {ReadonlyArray<import('./types.js').ScheduledFlight>} flights
 * @param {{start:number,end:number}} span
 */
export function inWindow(flights, { start, end } = {}) {
  if (!Array.isArray(flights) || !finite(start) || !finite(end) || end <= start) return [];
  return flights
    .filter((f) => finite(f?.scheduledDep) && f.scheduledDep >= start && f.scheduledDep < end)
    .sort((a, b) => (a.scheduledDep - b.scheduledDep) || (a.flightNumber < b.flightNumber ? -1 : a.flightNumber > b.flightNumber ? 1 : 0));
}
