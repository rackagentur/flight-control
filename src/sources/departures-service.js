// Departures loader: validates the request, serves a short device cache, otherwise asks the
// backend (fc.roster v2 `departures`). Failures are thrown and never cached; nothing is mocked.
// Cache: store key `departures.v2` = {entries:{[requestKey]:{fetchedAt, storedAt, payload}}},
// 5 min by storedAt, at most 8 entries (oldest storedAt evicted). Removed on token change/removal.

import { postContract, ApiError } from '../api/appscript.js';
import { store as defaultStore } from '../store.js';
import { departuresRequest, validateDepartures, adaptDepartures } from './departures-v2.js';

export const DEPARTURES_CACHE_KEY = 'departures.v2';
export const DEPARTURES_TTL_MS = 5 * 60000;
export const DEPARTURES_MAX_ENTRIES = 8;
export const DEPARTURES_MAX_RANGE_MS = 24 * 3600000;

const IATA = /^[A-Z]{3}$/;
const CARRIER = /^[A-Z0-9]{2}$/;

/** `code` is a backend error code (e.g. 'provider-rate-limited'), a local refusal ('bad-range', ...) or 'invalid-response'. */
export class DeparturesError extends Error {
  constructor(code, message = code, detail = null) {
    super(message);
    this.name = 'DeparturesError';
    this.code = code;
    this.detail = detail;
  }
}

/** Sorted, de-duplicated carrier list, or null for no filter; throws bad-request on a bad shape. */
function normalizeCarriers(carriers) {
  if (carriers === null || carriers === undefined) return null;
  if (!Array.isArray(carriers) || carriers.length < 1 || carriers.length > 10 || !carriers.every((c) => typeof c === 'string' && CARRIER.test(c))) {
    throw new DeparturesError('bad-request', 'Carriers must be 1 to 10 two-character airline codes.');
  }
  return [...new Set(carriers)].sort();
}

function checkInput({ endpoint, token, airport, from, to, carriers }) {
  if (typeof airport !== 'string' || !IATA.test(airport)) throw new DeparturesError('unknown-airport', 'The airport must be a three-letter IATA code.');
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) throw new DeparturesError('bad-range', 'The time range must be whole milliseconds with an end after its start.');
  if (to - from > DEPARTURES_MAX_RANGE_MS) throw new DeparturesError('range-too-long', 'The time range is longer than 24 hours.');
  const list = normalizeCarriers(carriers);
  if (typeof token !== 'string' || token === '') throw new DeparturesError('bad-request', 'Departures need the access token.');
  if (typeof endpoint !== 'string' || endpoint === '') throw new DeparturesError('bad-request', 'No roster source is configured.');
  return list;
}

const requestKey = (airport, from, to, carriers) => `${airport}|${from}|${to}|${carriers?.join(',') ?? '*'}`;

function readEntries(store) {
  const data = store?.getJSON(DEPARTURES_CACHE_KEY, null);
  return data && typeof data === 'object' && data.entries && typeof data.entries === 'object' && !Array.isArray(data.entries) ? data.entries : {};
}

function writeEntry(store, key, entry) {
  if (!store) return;
  const entries = { ...readEntries(store), [key]: entry };
  const keys = Object.keys(entries).sort((a, b) => (entries[a]?.storedAt ?? 0) - (entries[b]?.storedAt ?? 0));
  while (keys.length > DEPARTURES_MAX_ENTRIES) delete entries[keys.shift()];
  store.setJSON(DEPARTURES_CACHE_KEY, { entries });
}

/** Removes the departures cache (token changed or removed). */
export function purgeDeparturesCache(store = defaultStore) {
  store?.remove(DEPARTURES_CACHE_KEY);
}

/** A cached payload only counts when it still validates and still answers this exact request. */
function usable(payload, airport, from, to, carriers) {
  if (!validateDepartures(payload).ok) return false;
  return payload.airport === airport && payload.from === from && payload.to === to && (payload.carriers?.join(',') ?? '*') === (carriers?.join(',') ?? '*');
}

/**
 * @param {{endpoint:string, token:string, airport:string, from:number, to:number, carriers?:string[]|null}} query
 * @param {{api?:{postContract:Function}, store?:object|null, now?:()=>number, ttlMs?:number}} [deps]
 * @returns {Promise<import('../model/types.js').DeparturesResult>}
 * @throws {DeparturesError|ApiError}
 */
export async function loadDepartures(query, { api = { postContract }, store = defaultStore, now = Date.now, ttlMs = DEPARTURES_TTL_MS } = {}) {
  const carriers = checkInput(query);
  const { endpoint, token, airport, from, to } = query;
  const key = requestKey(airport, from, to, carriers);
  const at = now();

  const hit = readEntries(store)[key];
  if (hit && Number.isFinite(hit.storedAt) && at - hit.storedAt >= 0 && at - hit.storedAt < ttlMs && usable(hit.payload, airport, from, to, carriers)) {
    return Object.freeze({ ...adaptDepartures(hit.payload), fromCache: true });
  }

  let data;
  try {
    ({ data } = await api.postContract(endpoint, departuresRequest({ airport, from, to, carriers }, token)));
  } catch (error) {
    if (error instanceof ApiError || error instanceof DeparturesError) throw error;
    throw new ApiError('network', 'The departures request could not be completed.', error?.message ?? null);
  }
  const check = validateDepartures(data);
  if (!check.ok) {
    // A backend refusal ({ok:false, error}) keeps its own code; anything else is an unusable response.
    const refused = data && typeof data === 'object' && data.ok !== true;
    throw new DeparturesError(refused ? check.reason : 'invalid-response', refused ? `The backend refused the departures request (${check.reason}).` : `The departures response was not usable (${check.reason}).`, check.reason);
  }
  if (!usable(data, airport, from, to, carriers)) throw new DeparturesError('invalid-response', 'The departures response does not match the request.', 'request-mismatch');

  writeEntry(store, key, { fetchedAt: data.fetchedAt, storedAt: at, payload: data });
  return Object.freeze({ ...adaptDepartures(data), fromCache: false });
}
