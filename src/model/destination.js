// Destination intelligence (Phase 6, decision D5): what a crew member needs to know about the
// place a sector arrives at. One pure model shared by Flights (and Today where it replaces a
// placeholder). It reveals only what applies and what the data supports:
//   * home-base arrivals get no destination layer at all;
//   * local time and difference from home only with a known time zone;
//   * the stay (turnaround, layover confirmed/inferred, return not yet listed) from the roster;
//   * weather as a query the UI resolves through a provider (Open-Meteo or review samples);
//   * hotel: never an invented or inferred assignment (D4); only legitimate actions.
// No airport table, time-zone code or classifier of its own: airports.js, lib/time.js and
// the roster model are the single sources.

import { airport } from '../data/airports.js';
import { addDays, diffDays, localDateKey, offsetMinutes } from '../lib/time.js';
import { layoverCalendarDays } from './roster.js';

/** Days of forecast the weather provider can answer (Open-Meteo daily forecast). */
export const FORECAST_DAYS = 10;

/**
 * @typedef {Object} Stay
 * @property {'turn'|'layover'|'open'|'gap'} kind   turn: next sector of the same duty departs from here;
 *   layover: the rotation continues from here after the duty ends; open: the return is not listed yet;
 *   gap: no departure from here is known although later flights are (or a remembered sector has no
 *   continuation): nothing is inferred about the time there
 * @property {'confirmed'|'inferred'|null} confidence
 * @property {number} from
 * @property {number|null} to
 */

const mapsSearch = (query) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;

/** Weather request for the stay: the local date that matters (today while there), or why not. */
export function weatherQuery(dest, now) {
  if (!dest.tz) return { status: 'unavailable', reason: 'no-timezone' };
  const there = dest.stay && dest.stay.kind !== 'gap' && dest.stay.from <= now && (dest.stay.to === null || now < dest.stay.to);
  const date = localDateKey(there ? now : dest.arrival, dest.tz);
  const todayLocal = localDateKey(now, dest.tz);
  const ref = airport(dest.iata);
  if (!ref || !Number.isFinite(ref.lat) || !Number.isFinite(ref.lon)) return { status: 'unavailable', reason: 'no-coordinates', iata: dest.iata, tz: dest.tz, date, todayLocal };
  const ahead = diffDays(todayLocal, date);
  if (ahead < 0) return { status: 'unavailable', reason: 'past' };
  if (ahead >= FORECAST_DAYS) return { status: 'later', availableFrom: addDays(date, -(FORECAST_DAYS - 1)), date };
  return { status: 'query', iata: dest.iata, lat: ref.lat, lon: ref.lon, tz: dest.tz, date, todayLocal };
}

/**
 * @param {{iata: string, tz: string|null, arrival: number, stay: Stay|null}} at
 * @param {object} profile
 * @param {number} now
 * @returns {null | object} null for a home-base arrival (no destination layer)
 */
export function buildDestination({ iata, tz, arrival, stay }, profile, now) {
  if (profile.homeBases.includes(iata)) return null;
  const ref = airport(iata);
  const zone = tz ?? ref?.tz ?? null;
  const diffAt = (ms) => (zone ? offsetMinutes(ms, zone) - offsetMinutes(ms, profile.homeTz) : null);
  const minutes = stay && stay.to !== null ? Math.round((stay.to - stay.from) / 60000) : null;
  // Hotel actions apply to an overnight stay that has not ended yet.
  const overnight = stay && (stay.kind === 'layover' || stay.kind === 'open') && (stay.to === null || stay.to > now);
  const dest = {
    iata,
    city: ref?.city ?? iata,
    country: ref?.country ?? null,
    known: Boolean(ref),
    tone: ref?.tone ?? null,
    tz: zone,
    arrival,
    // Difference from home, in minutes: at arrival, and now (DST can differ between the two).
    diffAtArrival: diffAt(arrival),
    diffNow: diffAt(now),
    stay: stay ? {
      ...stay,
      minutes,
      nights: stay.to !== null && stay.kind !== 'turn' ? layoverCalendarDays(stay.from, stay.to, zone ?? profile.homeTz) : null,
      current: stay.kind !== 'gap' && stay.from <= now && (stay.to === null || now < stay.to),
      remainingMin: stay.kind !== 'gap' && stay.to !== null && stay.from <= now && now < stay.to ? Math.round((stay.to - now) / 60000) : null,
    } : null,
    // D4: an assigned hotel only ever comes from a source record; v5 has none.
    hotel: overnight && !profile.noHotelAirports.includes(iata) ? {
      record: null,
      search: ref ? mapsSearch(`hotels in ${ref.city}`) : null,
      savedList: profile.hotelListUrl || null,
    } : null,
    maps: ref ? mapsSearch(`${iata} airport ${ref.city}`) : null,
  };
  dest.weather = weatherQuery(dest, now);
  return dest;
}
