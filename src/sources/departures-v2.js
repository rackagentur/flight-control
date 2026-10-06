// `departures` action of the fc.roster v2 contract (browser side): request, strict response
// check and adapter to ScheduledFlight. A ScheduledFlight is an external schedule entry; it is
// never a roster sector and is never converted into one. The browser never talks to the schedule
// provider: the backend does, and `provider` here is only an opaque label.

import { request, CONTRACT, VERSION } from './contract-v2.js';
import { airport as airportEntry } from '../data/airports.js';

export const DEPARTURE_STATUSES = Object.freeze(['scheduled', 'delayed', 'boarding', 'departed', 'cancelled', 'unknown']);
const STATUS = new Set(DEPARTURE_STATUSES);
const IATA = /^[A-Z]{3}$/;
const CARRIER = /^[A-Z0-9]{2}$/;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const fail = (reason) => ({ ok: false, reason });

/**
 * Request body for `departures`. The token travels only in the body. `carriers` is sent only
 * when given (absent = no carrier filter).
 * @param {{airport:string, from:number, to:number, carriers?:string[]|null}} range
 * @param {string} token
 */
export function departuresRequest({ airport, from, to, carriers = null }, token) {
  const extra = { airport, from, to };
  if (carriers !== null && carriers !== undefined) extra.carriers = [...carriers];
  return request('departures', token, extra);
}

function badFlight(f) {
  if (!f || typeof f !== 'object') return 'bad-flight';
  if (typeof f.id !== 'string' || typeof f.flightNumber !== 'string') return 'bad-flight';
  if (!IATA.test(f.origin ?? '')) return 'bad-flight';
  if (!(f.carrier === null || (typeof f.carrier === 'string' && CARRIER.test(f.carrier)))) return 'bad-flight';
  if (!(f.destination === null || (typeof f.destination === 'string' && IATA.test(f.destination)))) return 'bad-flight';
  if (!(f.destinationName === null || typeof f.destinationName === 'string')) return 'bad-flight';
  if (!finite(f.scheduledDep) || !(f.revisedDep === null || finite(f.revisedDep))) return 'bad-flight';
  if (!STATUS.has(f.status)) return 'bad-status';
  const a = f.aircraft;
  if (a !== null && (typeof a !== 'object' || !(a.model === null || typeof a.model === 'string') || !(a.registration === null || typeof a.registration === 'string'))) return 'bad-flight';
  if (f.provenance !== 'provider') return 'bad-provenance';
  return null;
}

/** Strict shape check. Backend error payloads pass their `error` code through as the reason. @returns {{ok:true}|{ok:false, reason:string}} */
export function validateDepartures(p) {
  if (!p || typeof p !== 'object') return fail('not-an-object');
  if (p.ok !== true) return fail(typeof p.error === 'string' ? p.error : 'backend-refused');
  if (p.contract !== CONTRACT || p.version !== VERSION) return fail('contract-mismatch');
  if (p.action !== 'departures') return fail('wrong-action');
  if (!IATA.test(p.airport ?? '')) return fail('bad-airport');
  if (!finite(p.from) || !finite(p.to) || p.to <= p.from) return fail('bad-range');
  if (typeof p.airportTz !== 'string' || p.airportTz === '' || typeof p.provider !== 'string' || p.provider === '') return fail('bad-meta');
  if (!finite(p.fetchedAt) || !finite(p.generatedAt) || !Number.isInteger(p.dropped) || p.dropped < 0) return fail('bad-meta');
  if (!(p.carriers === null || (Array.isArray(p.carriers) && p.carriers.every((c) => typeof c === 'string' && CARRIER.test(c))))) return fail('bad-carriers');
  if (!Array.isArray(p.flights)) return fail('missing-flights');
  for (const f of p.flights) {
    const reason = badFlight(f);
    if (reason) return fail(reason);
  }
  return { ok: true };
}

const tzOf = (code) => (code === null ? null : airportEntry(code)?.tz ?? null);

/**
 * Wire payload (already validated) to a DeparturesResult without `fromCache` (the service adds it).
 * Only known fields are copied; time zones come from the V2 airport table, never from the payload.
 */
export function adaptDepartures(p) {
  const flights = p.flights.map((f) => Object.freeze({
    id: f.id,
    flightNumber: f.flightNumber,
    carrier: f.carrier,
    origin: f.origin,
    destination: f.destination,
    destinationName: f.destinationName,
    scheduledDep: f.scheduledDep,
    revisedDep: f.revisedDep,
    status: f.status,
    aircraft: f.aircraft ? Object.freeze({ model: f.aircraft.model, registration: f.aircraft.registration }) : null,
    originTz: tzOf(f.origin),
    destTz: tzOf(f.destination),
    provenance: 'provider',
  }));
  return Object.freeze({
    airport: p.airport,
    airportTz: p.airportTz,
    from: p.from,
    to: p.to,
    carriers: p.carriers === null ? null : Object.freeze([...p.carriers]),
    provider: p.provider,
    fetchedAt: p.fetchedAt,
    generatedAt: p.generatedAt,
    dropped: p.dropped,
    flights: Object.freeze(flights),
  });
}
