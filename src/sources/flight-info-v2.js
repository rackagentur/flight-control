// `flight` action of the fc.roster v2 contract (browser side): flight-number normalisation,
// request body, strict response check and a pure adapter to a live-flight view model.
//
// The view model is provider data only. It contains no roster fields and never reads or writes a
// roster time: a roster sector stays authoritative, this is what the provider says about the same
// flight. Nothing is ever invented: a gate that is not in the response is never shown, and the
// "not assigned yet" reading (gateState 'pending') needs live provider quality plus an open status.

import { request, CONTRACT, VERSION } from './contract-v2.js';
import { readAttribution } from './attribution.js';

export const FLIGHT_STATUSES = Object.freeze(['scheduled', 'delayed', 'boarding', 'departed', 'arrived', 'diverted', 'cancelled', 'unknown']);
export const FLIGHT_QUALITIES = Object.freeze(['basic', 'live', 'approximate']);
export const GATE_STATE = Object.freeze({ AVAILABLE: 'available', PENDING: 'pending', UNAVAILABLE: 'unavailable' });

/** Statuses in which a missing departure gate may still be published ("not assigned yet"). Boarding/gate
 * closed, unknown and finished statuses never qualify: a gate missing then is simply unavailable. */
export const DEPARTURE_GATE_OPEN = Object.freeze(['scheduled', 'delayed']);
/** Statuses in which a missing arrival gate may still be published. */
export const ARRIVAL_GATE_OPEN = Object.freeze(['scheduled', 'delayed', 'boarding', 'departed']);

export const STALE_FETCH_MS = 15 * 60000;
/** Fetch age after which a flight departing more than STALE_FAR_FROM_MS from now counts as stale (gates change little that far out; the server caches such lookups for 30 min). */
export const STALE_FETCH_FAR_MS = 3 * 3600000;
export const STALE_FAR_FROM_MS = 24 * 3600000;
export const STALE_UPDATE_MS = 6 * 3600000;
export const STALE_NEAR_DEPARTURE_MS = 12 * 3600000;

const STATUS = new Set(FLIGHT_STATUSES);
const IATA = /^[A-Z]{3}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ID = /^g_[0-9a-f]{16}$/;
const TEXT = /^[A-Za-z0-9][A-Za-z0-9 .\/,+-]*$/;
const FLIGHT_NUMBER_RAW = /^[A-Za-z0-9]{2}\d+[A-Za-z]?$/;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const fail = (reason) => ({ ok: false, reason });

/**
 * Canonical flight number: carrier + number without leading zeros (at least one digit) + optional
 * suffix letter, upper case, no spaces. Returns null when the input is not a flight number.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeFlightNumber(value) {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/\s+/g, '');
  // Checked before upper-casing so that characters which fold to ASCII (e.g. the sharp s) cannot slip in.
  if (!FLIGHT_NUMBER_RAW.test(compact)) return null;
  const upper = compact.toUpperCase();
  const m = /^([A-Z0-9]{2})(\d+)([A-Z]?)$/.exec(upper);
  if (!m) return null;
  const digits = m[2].replace(/^0+(?=\d)/, '');
  if (digits.length > 4) return null;
  return `${m[1]}${digits}${m[3]}`;
}

/** True for a real calendar date written YYYY-MM-DD. */
export function isRealDateKey(value) {
  if (typeof value !== 'string') return false;
  const m = DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/**
 * Request body for `flight`. The token travels only in the body.
 * @param {{flightNumber:string, date:string, origin:string}} query
 * @param {string} token
 */
export function flightRequest({ flightNumber, date, origin }, token) {
  return request('flight', token, { flightNumber, date, origin });
}

const sameKeys = (obj, keys) => {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const have = Object.keys(obj);
  return have.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k));
};
const nullOrFinite = (v) => v === null || finite(v);
const textOrNull = (v) => v === null || (typeof v === 'string' && v.length >= 1 && v.length <= 16 && TEXT.test(v) && v === v.trim().replace(/\s+/g, ' '));

const LEG_KEYS = ['airport', 'scheduled', 'revised', 'runway', 'terminal', 'gate', 'desk', 'belt', 'quality'];
const FLIGHT_KEYS = ['id', 'flightNumber', 'status', 'lastUpdated', 'departure', 'arrival', 'provenance'];
const ROOT_KEYS = ['ok', 'contract', 'version', 'action', 'provider', 'generatedAt', 'fetchedAt', 'query', 'found', 'flight'];
const QUERY_KEYS = ['flightNumber', 'date', 'origin'];

function badQuality(q) {
  if (!Array.isArray(q)) return true;
  let last = -1;
  for (const item of q) {
    const index = FLIGHT_QUALITIES.indexOf(item);
    if (index <= last) return true; // unknown, duplicate or out of order
    last = index;
  }
  return false;
}

function badLeg(leg, side) {
  if (!sameKeys(leg, LEG_KEYS)) return 'bad-leg';
  if (!(leg.airport === null || (typeof leg.airport === 'string' && IATA.test(leg.airport)))) return 'bad-leg';
  if (!nullOrFinite(leg.scheduled) || !nullOrFinite(leg.revised) || !nullOrFinite(leg.runway)) return 'bad-leg';
  for (const key of ['terminal', 'gate', 'desk', 'belt']) if (!textOrNull(leg[key])) return 'bad-text';
  if (side === 'departure' && leg.belt !== null) return 'bad-leg';
  if (side === 'arrival' && leg.desk !== null) return 'bad-leg';
  if (badQuality(leg.quality)) return 'bad-quality';
  return null;
}

function badFlight(f, query) {
  if (!sameKeys(f, FLIGHT_KEYS)) return 'bad-flight';
  if (typeof f.id !== 'string' || !ID.test(f.id)) return 'bad-id';
  if (typeof f.flightNumber !== 'string' || normalizeFlightNumber(f.flightNumber) !== f.flightNumber || f.flightNumber !== query.flightNumber) return 'bad-flight';
  if (!STATUS.has(f.status)) return 'bad-status';
  if (!nullOrFinite(f.lastUpdated)) return 'bad-flight';
  if (f.provenance !== 'provider') return 'bad-provenance';
  const dep = badLeg(f.departure, 'departure');
  if (dep) return dep;
  const arr = badLeg(f.arrival, 'arrival');
  if (arr) return arr;
  if (f.departure.airport !== query.origin) return 'bad-flight'; // the backend only matches flights leaving the queried origin
  return null;
}

/**
 * Strict shape check of the whole `flight` response (exact keys everywhere). A backend error
 * payload passes its `error` code through as the reason. Whether the echoed query is the query
 * that was asked is the service's job; here it only has to be well-formed.
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function validateFlightInfo(p) {
  if (!p || typeof p !== 'object') return fail('not-an-object');
  if (p.ok !== true) return fail(typeof p.error === 'string' ? p.error : 'backend-refused');
  if (p.contract !== CONTRACT || p.version !== VERSION) return fail('contract-mismatch');
  if (p.action !== 'flight') return fail('wrong-action');
  // `attribution` is the one optional top-level key (the backend adds it to success responses).
  if (!sameKeys(p, 'attribution' in p ? [...ROOT_KEYS, 'attribution'] : ROOT_KEYS)) return fail('bad-keys');
  if ('attribution' in p && readAttribution(p.attribution) === null) return fail('bad-attribution');
  // The provider is an opaque label here (see departures-v2.js); the browser never names or calls it.
  if (typeof p.provider !== 'string' || p.provider === '' || p.provider.length > 32) return fail('bad-meta');
  if (!finite(p.fetchedAt) || !finite(p.generatedAt)) return fail('bad-meta');
  const q = p.query;
  if (!sameKeys(q, QUERY_KEYS)) return fail('bad-query');
  if (typeof q.flightNumber !== 'string' || normalizeFlightNumber(q.flightNumber) !== q.flightNumber) return fail('bad-query');
  if (!isRealDateKey(q.date) || typeof q.origin !== 'string' || !IATA.test(q.origin)) return fail('bad-query');
  if (typeof p.found !== 'boolean') return fail('bad-found');
  if (p.found !== (p.flight !== null)) return fail('bad-found');
  if (p.found) {
    const reason = badFlight(p.flight, q);
    if (reason) return fail(reason);
  }
  return { ok: true };
}

function gateStateOf(leg, status, open) {
  if (leg.gate !== null) return GATE_STATE.AVAILABLE;
  if (leg.quality.includes('live') && open.includes(status)) return GATE_STATE.PENDING;
  return GATE_STATE.UNAVAILABLE;
}

function adaptLeg(leg, status, side) {
  const out = {
    airport: leg.airport,
    scheduled: leg.scheduled,
    revised: leg.revised,
    runway: leg.runway,
    terminal: leg.terminal,
    gate: leg.gate,
  };
  if (side === 'departure') out.desk = leg.desk;
  else out.belt = leg.belt;
  out.quality = Object.freeze([...leg.quality]);
  out.gateState = gateStateOf(leg, status, side === 'departure' ? DEPARTURE_GATE_OPEN : ARRIVAL_GATE_OPEN);
  return Object.freeze(out);
}

/**
 * Whether a view model (or its parts) is stale at `now`. Used by the adapter and again at render
 * time, so information kept on screen ages instead of keeping the answer from load time.
 * @param {{found:boolean, fetchedAt:number, lastUpdated?:number|null, departure?:{scheduled:number|null}}} info
 */
export function staleAt(info, now) {
  if (!info.found) return now - info.fetchedAt > STALE_FETCH_MS;
  const scheduled = info.departure?.scheduled ?? null;
  const far = scheduled !== null && Math.abs(scheduled - now) > STALE_FAR_FROM_MS;
  const fetchStale = now - info.fetchedAt > (far ? STALE_FETCH_FAR_MS : STALE_FETCH_MS);
  const updateStale = info.lastUpdated != null && now - info.lastUpdated > STALE_UPDATE_MS
    && scheduled !== null && Math.abs(scheduled - now) <= STALE_NEAR_DEPARTURE_MS;
  return fetchStale || updateStale;
}

/**
 * Pure: validated wire payload to the live-flight view model. `now` is only used for `stale`.
 * Provider times stay provider data; no roster time is read or changed here.
 * @param {object} p  a payload that passed validateFlightInfo
 * @param {{now?:number}} [options]
 */
export function adaptFlightInfo(p, { now = Date.now() } = {}) {
  if (!p.found) return Object.freeze({ found: false, fetchedAt: p.fetchedAt, stale: staleAt({ found: false, fetchedAt: p.fetchedAt }, now), attribution: readAttribution(p.attribution) });
  const f = p.flight;
  const dep = adaptLeg(f.departure, f.status, 'departure');
  const arr = adaptLeg(f.arrival, f.status, 'arrival');
  return Object.freeze({
    found: true,
    fetchedAt: p.fetchedAt,
    lastUpdated: f.lastUpdated,
    stale: staleAt({ found: true, fetchedAt: p.fetchedAt, lastUpdated: f.lastUpdated, departure: dep }, now),
    flightNumber: f.flightNumber,
    status: f.status,
    provenance: 'provider',
    departure: dep,
    arrival: arr,
    attribution: readAttribution(p.attribution),
  });
}
