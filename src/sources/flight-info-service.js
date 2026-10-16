// Live flight information loader (fc.roster v2 `flight`). Builds the query from a roster sector,
// de-duplicates identical requests, keeps a short in-memory cache and returns the adapted view
// model. Failures are thrown and never cached; nothing is mocked or guessed.
//
// Cache: module-level Map in memory only (nothing is written to the device, so it is gone on
// reload and needs no consent about provider caching terms). Key = accessKey|flightNumber|date|origin,
// 5 min by storedAt, at most 16 entries (oldest storedAt evicted). A "not found" answer is cached
// like any other; an error never is. There is no polling: a request happens only when asked for.

import { postContract, ApiError } from '../api/appscript.js';
import { localDateKey, isValidTimeZone } from '../lib/time.js';
import { flightRequest, validateFlightInfo, adaptFlightInfo, normalizeFlightNumber } from './flight-info-v2.js';

export const FLIGHT_TTL_MS = 5 * 60000;
export const FLIGHT_MAX_ENTRIES = 16;
export const FLIGHT_TIMEOUT_MS = 30000;

const IATA = /^[A-Z]{3}$/;
const ERROR_CODE = /^[a-z][a-z0-9-]{0,47}$/;

/** `code` is a backend error code (e.g. 'provider-rate-limited'), a transport code, a local refusal ('bad-request', ...) or 'invalid-response'. */
export class FlightInfoError extends Error {
  constructor(code, message = code, detail = null) {
    super(message);
    this.name = 'FlightInfoError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The provider query for a roster sector, or null when any part is missing or invalid.
 * The date is the departure date in the ORIGIN airport's time zone; a zone is never guessed.
 * @param {{flightNumber?:string, origin?:string, dep?:number, originTz?:string|null}|null} sector
 * @returns {{flightNumber:string, date:string, origin:string}|null}
 */
export function flightQueryFor(sector) {
  if (!sector || typeof sector !== 'object') return null;
  const flightNumber = normalizeFlightNumber(sector.flightNumber);
  if (flightNumber === null) return null;
  if (typeof sector.origin !== 'string' || !IATA.test(sector.origin)) return null;
  if (typeof sector.dep !== 'number' || !Number.isFinite(sector.dep)) return null;
  if (typeof sector.originTz !== 'string' || !isValidTimeZone(sector.originTz)) return null;
  const date = localDateKey(sector.dep, sector.originTz);
  if (date === null) return null;
  return { flightNumber, date, origin: sector.origin };
}

/** key -> {storedAt, payload (validated wire response)} */
const cache = new Map();
/** key -> Promise<{payload, storedAt}> for requests still running */
const inFlight = new Map();
let generation = 0;

/** Clears the cache and forgets running requests (token changed or removed). Their answers are discarded. */
export function purgeFlightInfoCache() {
  cache.clear();
  inFlight.clear();
  generation += 1;
}

function remember(key, storedAt, payload) {
  cache.delete(key);
  cache.set(key, { storedAt, payload });
  while (cache.size > FLIGHT_MAX_ENTRIES) {
    let oldest = null;
    for (const [k, v] of cache) if (oldest === null || v.storedAt < cache.get(oldest).storedAt) oldest = k;
    cache.delete(oldest);
  }
}

function matchesQuery(payload, query) {
  const q = payload.query;
  return q.flightNumber === query.flightNumber && q.date === query.date && q.origin === query.origin;
}

async function fetchValidated(endpoint, token, query, { fetchImpl, timeoutMs }) {
  let data;
  try {
    ({ data } = await postContract(endpoint, flightRequest(query, token), { timeoutMs, fetchImpl }));
  } catch (error) {
    if (error instanceof ApiError) throw new FlightInfoError(error.code, error.message, error.detail);
    if (error instanceof FlightInfoError) throw error;
    throw new FlightInfoError('network', 'The flight information request could not be completed.', error?.message ?? null);
  }
  const check = validateFlightInfo(data);
  if (!check.ok) {
    // A backend refusal ({ok:false, error}) keeps its own code; anything else is an unusable response.
    const refused = data && typeof data === 'object' && data.ok !== true;
    if (refused && ERROR_CODE.test(check.reason)) throw new FlightInfoError(check.reason, `The backend refused the flight request (${check.reason}).`, check.reason);
    throw new FlightInfoError('invalid-response', `The flight response was not usable (${check.reason}).`, check.reason);
  }
  if (!matchesQuery(data, query)) throw new FlightInfoError('invalid-response', 'The flight response does not match the request.', 'request-mismatch');
  return data;
}

/**
 * @param {{endpoint:string, token:string, sector:object}} input
 * @param {{force?:boolean, now?:()=>number, fetchImpl?:Function, accessKey?:string, shouldStore?:()=>boolean, timeoutMs?:number}} [options]
 *   `force` skips the cache READ only (a manual refresh); an identical request already running is
 *   still joined, and the fresh answer is cached. `accessKey` separates entries per access token
 *   without keeping the token itself. `shouldStore` is asked after the answer arrived: if it
 *   returns false (e.g. the token changed while the request ran) nothing is cached and the call
 *   rejects with FlightInfoError 'access-changed', like the departures loader.
 * @returns {Promise<object>} the adapted view model (see adaptFlightInfo), recomputed against `now()` on every return
 * @throws {FlightInfoError}
 */
export async function loadFlightInfo({ endpoint, token, sector }, { force = false, now = Date.now, fetchImpl, accessKey = '', shouldStore = () => true, timeoutMs = FLIGHT_TIMEOUT_MS } = {}) {
  if (typeof endpoint !== 'string' || endpoint === '') throw new FlightInfoError('not-configured', 'No roster source is configured.');
  if (typeof token !== 'string' || token === '') throw new FlightInfoError('auth-required', 'Live flight information needs the access token.');
  const query = flightQueryFor(sector);
  if (query === null) throw new FlightInfoError('bad-request', 'This flight cannot be looked up (flight number, origin, departure time or origin time zone missing).');

  const key = `${accessKey}|${query.flightNumber}|${query.date}|${query.origin}`;
  const at = now();

  if (!force) {
    const hit = cache.get(key);
    if (hit && at - hit.storedAt >= 0 && at - hit.storedAt < FLIGHT_TTL_MS) return adaptFlightInfo(hit.payload, { now: now() });
  }

  // Everything from here to the in-flight registration is synchronous, so a concurrent call sees it.
  const born = generation;
  let running = inFlight.get(key);
  if (!running) {
    running = fetchValidated(endpoint, token, query, { fetchImpl, timeoutMs }).then((payload) => ({ payload, storedAt: at }));
    inFlight.set(key, running);
    const release = () => { if (inFlight.get(key) === running) inFlight.delete(key); };
    running.then(release, release);
  }

  const { payload, storedAt } = await running;
  if (born !== generation || (typeof shouldStore === 'function' && !shouldStore())) {
    throw new FlightInfoError('access-changed', 'The access changed while the flight request was running; the answer was discarded.');
  }
  remember(key, storedAt, payload);
  return adaptFlightInfo(payload, { now: now() });
}
