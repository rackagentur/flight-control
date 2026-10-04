// Sector history: remembers sectors from earlier payloads (on this device only).
// v5 lists flights from today 00:00 onwards, so yesterday's inbound flight to an outstation
// disappears. Remembering it lets the state engine see "previous completed flight ended
// away from base", the evidence an inferred layover needs. Remembered sectors carry
// provenance 'history' and are never presented as current roster data.

const KEEP_DAYS = 21;
const MAX_SECTORS = 60;
const DAY = 86400000;

/** Identity by content, not id, so id-format changes or duplicate entries never double up. */
export const sectorKey = (s) => `${s.flightNumber}|${s.origin}|${s.destination}|${s.dep}|${s.arr}`;

const minimal = (s) => ({
  id: s.id, flightNumber: s.flightNumber, origin: s.origin, destination: s.destination,
  dep: s.dep, arr: s.arr, blockMin: s.blockMin, originTz: s.originTz, destTz: s.destTz,
});

/** Returns the history list to store after seeing `snapshot` (pure). */
export function rememberSectors(history, snapshot, now) {
  const byKey = new Map((Array.isArray(history) ? history : []).map((s) => [sectorKey(s), s]));
  for (const sector of snapshot.sectors) {
    if (sector.provenance === 'source') byKey.set(sectorKey(sector), minimal(sector));
  }
  return [...byKey.values()]
    .filter((s) => Number.isFinite(s.dep) && Number.isFinite(s.arr) && s.arr > now - KEEP_DAYS * DAY)
    .sort((a, b) => a.dep - b.dep)
    .slice(-MAX_SECTORS);
}

/**
 * Adds remembered sectors that completed before the first sector of the current payload.
 * Only sectors strictly earlier than the payload window are merged, so a flight removed from
 * the roster (cancelled/changed) is never resurrected inside the window the source covers.
 */
export function withHistory(snapshot, history, now) {
  if (!Array.isArray(history) || !history.length) return snapshot;
  const windowStart = snapshot.coverageStart ?? Math.min(now, ...snapshot.sectors.map((s) => s.dep));
  const known = new Set(snapshot.sectors.map(sectorKey));
  const seen = new Set();
  const past = history
    .filter((s) => {
      const key = sectorKey(s);
      if (known.has(key) || seen.has(key)) return false;
      seen.add(key);
      return s.arr <= windowStart && s.arr <= now;
    })
    .map((s) => ({ ...s, pickup: null, provenance: 'history', legacy: null }));
  if (!past.length) return snapshot;
  return { ...snapshot, sectors: [...past, ...snapshot.sectors].sort((a, b) => a.dep - b.dep) };
}
