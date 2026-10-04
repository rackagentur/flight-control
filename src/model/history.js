// Sector history: "Seen on this device". Remembers sectors from earlier payloads, locally only.
// v5 lists flights from today 00:00 onwards and has no per-flight history, so a flight that
// has been flown disappears from the source. Remembering it serves two purposes:
//   1. the state engine sees "previous completed flight ended away from base" (the evidence an
//      inferred layover needs);
//   2. Flights can show recently flown sectors, labelled as seen on this device: never a
//      complete roster, employment or career history.
// Remembered sectors carry provenance 'history' and are never presented as current roster data.
//
// Identity and corrections:
//   * a sector's stable identity is flight number + route + local departure date, so a retimed
//     flight replaces its earlier copy instead of appearing twice;
//   * inside the window the current payload speaks for, the source is authoritative: remembered
//     sectors there that the source no longer lists (changed or cancelled) are dropped.

import { addDays, isValidTimeZone, localDateKey, startOfLocalDay } from '../lib/time.js';

/** Approved retention (Phase 6 decision D2). */
export const KEEP_DAYS = 120;
export const MAX_SECTORS = 300;
const DAY = 86400000;
const MAX_BLOCK_MS = 24 * 3600000;
/** The same flight number on the same route within this span is one (retimed) flight. */
const RETIME_MS = 12 * 3600000;
const IATA = /^[A-Z]{3}$/;

const sameFlight = (a, b) => a.flightNumber === b.flightNumber && a.origin === b.origin && a.destination === b.destination
  && (Math.abs(a.dep - b.dep) < RETIME_MS || sectorIdentity(a) === sectorIdentity(b));

/**
 * Stored copies of one flight (same identity, or retimed within RETIME_MS, e.g. written by an
 * earlier build) collapse to the most recently seen copy.
 */
export function collapseRetimes(list) {
  const out = [];
  for (const s of [...list].sort((a, b) => (b.seenAt ?? 0) - (a.seenAt ?? 0))) {
    if (!out.some((o) => sameFlight(o, s))) out.push(s);
  }
  return out;
}

/** Content identity (exact times); kept for callers that need an exact match. */
export const sectorKey = (s) => `${s.flightNumber}|${s.origin}|${s.destination}|${s.dep}|${s.arr}`;

/** Stable identity: flight number + route + departure date in the origin's local time. */
export function sectorIdentity(s) {
  const tz = s.originTz && isValidTimeZone(s.originTz) ? s.originTz : 'UTC';
  return `${s.flightNumber}|${s.origin}|${s.destination}|${localDateKey(s.dep, tz)}`;
}

const zoneOrNull = (tz) => (typeof tz === 'string' && isValidTimeZone(tz) ? tz : null);

/** A stored entry is used only if every field is plausible (storage may be stale or corrupted). */
export function validEntry(s) {
  return Boolean(s) && typeof s === 'object'
    && typeof s.flightNumber === 'string' && s.flightNumber.trim() !== '' && s.flightNumber.length <= 16
    && IATA.test(s.origin ?? '') && IATA.test(s.destination ?? '')
    && Number.isFinite(s.dep) && Number.isFinite(s.arr) && s.arr > s.dep && s.arr - s.dep <= MAX_BLOCK_MS;
}

const minimal = (s, seenAt) => ({
  id: s.id, flightNumber: s.flightNumber, origin: s.origin, destination: s.destination,
  dep: s.dep, arr: s.arr, blockMin: Math.round((s.arr - s.dep) / 60000),
  originTz: zoneOrNull(s.originTz), destTz: zoneOrNull(s.destTz),
  seenAt: Number.isFinite(seenAt) ? seenAt : null,
});

/**
 * The departure window the payload is authoritative for: [coverage start, last departure it
 * can speak for]. Null when the payload cannot vouch for anything (e.g. its flight list is missing).
 */
export function authoritativeWindow(snapshot, tz = 'UTC') {
  if (snapshot.warnings?.some((w) => w.code === 'missing-field')) return null;
  const fresh = snapshot.sectors.filter((s) => s.provenance === 'source');
  const start = Number.isFinite(snapshot.coverageStart) ? snapshot.coverageStart : fresh[0]?.dep;
  if (!Number.isFinite(start)) return null;
  const truncated = snapshot.warnings?.some((w) => w.code === 'upcoming-truncated');
  let end;
  if (truncated) end = fresh.at(-1)?.dep ?? start;
  else if (snapshot.flightCoverageEnd && isValidTimeZone(tz)) end = startOfLocalDay(addDays(snapshot.flightCoverageEnd, 1), tz) - 1;
  else end = fresh.at(-1)?.dep ?? start;
  return { start, end };
}

/** Returns the history list to store after seeing `snapshot` (pure). */
export function rememberSectors(history, snapshot, now, tz = 'UTC') {
  const stored = (Array.isArray(history) ? history : []).filter(validEntry);
  const window = authoritativeWindow(snapshot, tz);
  // Inside the source's window only the source speaks: drop remembered copies it no longer lists.
  const kept = window ? stored.filter((s) => s.dep < window.start || s.dep > window.end) : stored;
  const byId = new Map();
  for (const s of collapseRetimes(kept)) byId.set(sectorIdentity(s), minimal(s, s.seenAt));
  for (const s of snapshot.sectors) {
    if (s.provenance !== 'source' || !validEntry(s)) continue;
    // A retimed copy of the same flight may have moved across local midnight (new identity):
    // the same flight number on the same route within RETIME_MS is the same flight.
    for (const [id, old] of byId) {
      if (old.flightNumber === s.flightNumber && old.origin === s.origin && old.destination === s.destination
        && Math.abs(old.dep - s.dep) < RETIME_MS) byId.delete(id);
    }
    byId.set(sectorIdentity(s), minimal(s, snapshot.source?.fetchedAt));
  }
  return [...byId.values()]
    .filter((s) => s.arr > now - KEEP_DAYS * DAY)
    .sort((a, b) => a.dep - b.dep)
    .slice(-MAX_SECTORS);
}

/**
 * Adds remembered sectors that departed before the window the current payload covers (the
 * source cannot speak for them). A flight inside the window that the source no longer lists
 * (cancelled/changed) is never resurrected.
 */
export function withHistory(snapshot, history, now) {
  if (!Array.isArray(history) || !history.length) return snapshot;
  const windowStart = snapshot.coverageStart ?? Math.min(now, ...snapshot.sectors.map((s) => s.dep));
  const listed = snapshot.sectors.filter((s) => s.provenance !== 'history');
  const past = collapseRetimes(history.filter(validEntry))
    .filter((s) => {
      // The source's own copy wins, including a copy retimed across local midnight.
      if (listed.some((x) => sameFlight(x, s))) return false;
      return s.dep < windowStart && s.dep <= now && s.arr > now - KEEP_DAYS * DAY;
    })
    // Ids are rebuilt from content: stored ids are not trusted (corrupt copies could collide).
    .map((s) => ({ ...minimal(s, s.seenAt), id: `${s.flightNumber}-${s.dep}-${s.arr}`, pickup: null, provenance: 'history', legacy: null }));
  if (!past.length) return snapshot;
  return { ...snapshot, sectors: [...past, ...snapshot.sectors].sort((a, b) => a.dep - b.dep) };
}
