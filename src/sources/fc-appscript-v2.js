// Roster source adapter: fc.roster v2 (Phase 7). Maps the backend contract onto the same
// RosterSnapshot every engine and screen already consumes, adding what v2 states:
//   explicit day codes (OFF, free, leave, ORT = protected free day), standby/reserve windows,
//   report times, outstation pickups, roster-stated stays with hotel records, aircraft,
//   and per-day coverage (rostered / empty / unpublished).
// Provenance is carried through; nothing is upgraded. An empty day stays UNKNOWN.

import { startOfLocalDay } from '../lib/time.js';

export const V2_CAPABILITIES = Object.freeze({
  sectors: true,
  pickup: true,
  offDaysByAbsence: false,
  explicitOff: true,
  protectedOff: true,
  standbyWindows: true,
  reserveWindows: true,
  pastSectors: true,
  reportTime: true,
  hotels: true,
  aircraft: true,
  history: true,
  actions: Object.freeze(['capabilities', 'roster', 'history']),
});

const IATA = /^[A-Z]{3}$/;
const PROVENANCE = ['source', 'derived', 'inferred', 'unknown'];
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Optional aircraft metadata: only well-formed source values, otherwise none. */
function aircraftOf(a) {
  if (!a || typeof a !== 'object' || typeof a.typeCode !== 'string' || !/^[0-9A-Z]{3}$/.test(a.typeCode)) return null;
  const registration = typeof a.registration === 'string' && /^[A-Z0-9-]{4,8}$/.test(a.registration) ? a.registration : null;
  return { typeCode: a.typeCode, registration, provenance: 'source' };
}

/**
 * Second, airline-independent privacy check on hotel text from the backend (defence in
 * depth): employee-number tokens, crew-base suffixes, slash/comma name lists and codes
 * mixing letters and digits are never displayed.
 */
const HOTEL_WORDS = /(hotel|inn|resort|suite|lodge|resid|collection|plaza|airport|house|palace|apart|tower|centre|center|park|garden|beach)/i;
export function suspiciousHotelText(t) {
  return typeof t !== 'string' || t.length > 200
    || /\d{6}[A-Za-z]?\b/.test(t)
    || /\([A-Za-z]{3}\s*\)/.test(t)
    || /[\p{L}.]\s*\/\s*\p{L}/u.test(t)
    || /\b(?=[A-Za-z]*\d)(?=\d*[A-Za-z])[A-Za-z0-9]{5,}\b/.test(t)
    || /(code|buchung|booking|confirmation|reservation|crew)/i.test(t);
}

function hotelOf(h) {
  if (!h || typeof h.name !== 'string' || !h.name.trim()) return null;
  if (suspiciousHotelText(h.name) || (/,/.test(h.name) && !/\d/.test(h.name) && !HOTEL_WORDS.test(h.name))) return null;
  const addressOk = typeof h.address === 'string' && !h.address.split(/,\s*/).some(suspiciousHotelText);
  const loc = h.location;
  const location = loc && finite(loc.lat) && finite(loc.lon) && loc.status === 'verified'
    ? { lat: loc.lat, lon: loc.lon, mapsUrl: typeof loc.mapsUrl === 'string' && /^https:\/\//.test(loc.mapsUrl) ? loc.mapsUrl : null, provenance: 'derived' }
    : null;
  return {
    name: h.name.trim(),
    address: addressOk ? h.address : null,
    phone: addressOk && typeof h.phone === 'string' && /^\+\d[\d\s()\/.-]{5,}$/.test(h.phone) ? h.phone : null,
    provenance: 'source',
    location,
  };
}

/**
 * @param {object} p  validated fc.roster v2 roster payload
 * @param {{profile: object, fetchedAt: number, kind?: string}} options
 * @returns {import('../model/types.js').RosterSnapshot}
 */
export function adaptV2(p, { profile, fetchedAt, kind = 'live' }) {
  const tz = profile.homeTz;
  const warnings = Array.isArray(p.warnings) ? p.warnings.filter((w) => typeof w?.code === 'string').map((w) => ({ code: w.code, message: String(w.message ?? w.code) })) : [];
  const dutyByFirst = new Map(p.duties.filter((d) => Array.isArray(d.sectorIds) && d.sectorIds.length).map((d) => [d.sectorIds[0], d]));

  const sectors = p.sectors.map((s) => {
    const duty = dutyByFirst.get(s.id);
    return {
      id: s.id,
      flightNumber: s.flightNumber,
      origin: s.origin,
      destination: s.destination,
      dep: s.dep,
      arr: s.arr,
      blockMin: finite(s.blockMin) ? s.blockMin : Math.round((s.arr - s.dep) / 60000),
      originTz: s.originTz ?? null,
      destTz: s.destTz ?? null,
      pickup: duty && finite(duty.pickup?.at) ? duty.pickup.at : null,
      report: duty && finite(duty.report?.at) ? duty.report.at : null,
      aircraft: aircraftOf(s.aircraft),
      provenance: 'source',
      basis: s.basis ?? null,
      legacy: null,
    };
  }).sort((a, b) => a.dep - b.dep);

  const windows = [];
  for (const w of p.windows) {
    windows.push({ kind: w.kind, start: w.start, end: w.end, label: typeof w.code === 'string' ? w.code : null, provenance: 'source' });
  }
  for (const e of p.events) {
    if (e.kind !== 'off') continue;
    windows.push({
      kind: 'off', subtype: ['off', 'free', 'leave', 'ort'].includes(e.subtype) ? e.subtype : 'off',
      protected: e.protected === true, start: e.start, end: e.end, label: e.code ?? 'OFF', provenance: 'source',
    });
  }
  const stays = p.stays.map((h) => ({
    airport: IATA.test(h.airport ?? '') ? h.airport : null,
    airportProvenance: PROVENANCE.includes(h.airportProvenance) ? h.airportProvenance : 'unknown',
    from: h.from,
    to: h.to ?? null,
    endProvenance: PROVENANCE.includes(h.endProvenance) ? h.endProvenance : 'unknown',
    provenance: 'source',
    basis: 'hotel-block',
    hotel: hotelOf(h.hotel),
  }));
  // A stay whose airport is stated by the source (a hotel block on the inbound flight) and
  // whose end is known is a roster-stated layover window: the stay itself is a source fact
  // (D-HOTEL: it lifts the inferred-layover cap); its end is derived (the next listed
  // departure) and is kept as such. Stays with a derived or unknown airport, or an open end,
  // stay stays only: no layover is confirmed from them.
  for (const s of stays) {
    if (s.airport && s.airportProvenance === 'source' && finite(s.to) && !profile.homeBases.includes(s.airport)) windows.push({ kind: 'layover', start: s.from, end: s.to, label: s.airport, hotel: s.hotel, provenance: 'source', endProvenance: s.endProvenance, basis: 'hotel-block' });
  }

  const dayStates = {};
  for (const d of p.coverage.days) dayStates[d.date] = d.state;

  return {
    source: { id: 'fc-roster-v2', label: 'Flight Control roster (contract v2)', kind, fetchedAt },
    contract: 'v2',
    capabilities: V2_CAPABILITIES,
    sectors,
    coverageStart: startOfLocalDay(p.coverage.from, tz),
    flightCoverageEnd: p.coverage.lastRosteredDate ?? null,
    coverageEnd: p.coverage.to,
    dayStates,
    windows,
    stays,
    // Unknown roster codes: kept with their original code and title, shown as unknown.
    unknownEvents: p.events.filter((e) => e.kind === 'unknown').map((e) => ({
      code: typeof e.code === 'string' ? e.code : '?', title: typeof e.title === 'string' ? e.title : '', start: e.start, end: e.end, provenance: 'source',
    })),
    offBlocks: [],
    offCoverageEnd: null,
    dutyBlock: null,
    stats: null,
    map: null,
    achievements: [],
    warnings,
  };
}

/** Server history (synced copy) → remembered sectors in the history.js shape. */
export function adaptHistoryV2(p, fetchedAt) {
  return p.sectors
    .filter((s) => typeof s?.flightNumber === 'string' && IATA.test(s.origin ?? '') && IATA.test(s.destination ?? '') && finite(s.dep) && finite(s.arr) && s.arr > s.dep)
    .map((s) => ({
      id: s.id, flightNumber: s.flightNumber, origin: s.origin, destination: s.destination, dep: s.dep, arr: s.arr,
      blockMin: Math.round((s.arr - s.dep) / 60000), originTz: s.originTz ?? null, destTz: s.destTz ?? null,
      seenAt: fetchedAt, historySource: 'roster-calendar',
    }));
}
