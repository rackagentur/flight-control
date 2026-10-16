// Step 6.6: one atomic, source-bound roster record. Never used by the service worker.
import { validateRoster } from './sources/contract-v2.js';
import { adaptV2 } from './sources/fc-appscript-v2.js';
import { adaptV5, AdapterError } from './sources/fc-appscript-v5.js';
import { startOfLocalDay, addDays } from './lib/time.js';
import { validEntry, MAX_SECTORS } from './model/history.js';

export const ROSTER_KEY = 'roster.v1';
export const LEGACY_KEYS = ['cache.v5', 'cache.v2', 'history.v5', 'history.v2'];
export const SIGNED_OUT_KEY = 'signedOut';
export const MAX_SERVER_SECTORS = 2000;
const DAY = 86400000;
const finite = Number.isFinite;
const date = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && finite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const invalid = (reason) => { throw new AdapterError('invalid-roster', `Roster not saved: ${reason}. Your previously saved roster is unchanged.`); };

// A digest binds the record to endpoint AND credential without another stored token copy.
export async function sourceIdentity(endpoint, token) {
  if (!globalThis.crypto?.subtle) throw new AdapterError('secure-context', 'Roster storage requires HTTPS or localhost. Open the secure preview on your phone.');
  const bytes = new TextEncoder().encode(JSON.stringify([endpoint, token ?? null]));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stricter acceptance boundary than display adapters: partial responses must not erase data. */
export function acceptedSnapshot(contract, payload, profile, fetchedAt, kind = 'cache') {
  if (!finite(fetchedAt) || fetchedAt <= 0) invalid('invalid synchronization time');
  if (contract === 'v2') {
    const check = validateRoster(payload);
    if (!check.ok) invalid(check.reason);
    const c = payload.coverage;
    const span = (Date.parse(c.to) - Date.parse(c.from)) / DAY + 1;
    if (!date(c.from) || !date(c.to) || span < 1 || span > 100 || c.days.length !== span) invalid('incomplete coverage');
    const days = new Set(c.days.map((d) => d.date));
    if (days.size !== span || c.days.some((d) => !date(d.date) || d.date < c.from || d.date > c.to)) invalid('invalid coverage days');
    if (c.lastRosteredDate != null && (!date(c.lastRosteredDate) || c.lastRosteredDate < c.from || c.lastRosteredDate > c.to)) invalid('invalid roster boundary');
    if (!payload.events.length && !payload.sectors.length && !payload.windows.length) invalid('empty roster');
    if (payload.events.some((e) => e.end < e.start) || payload.windows.some((w) => w.end < w.start)) invalid('invalid duty interval');
    if (payload.stays.some((s) => s.to !== null && s.to <= s.from)) invalid('invalid stay interval');
    const ids = new Set(payload.sectors.map((s) => s.id));
    if (ids.size !== payload.sectors.length || new Set(payload.events.map((e) => e.id)).size !== payload.events.length) invalid('duplicate identifiers');
    for (const d of payload.duties) {
      if (!d || !Array.isArray(d.sectorIds) || !d.sectorIds.length || d.sectorIds.some((id) => !ids.has(id))) invalid('incomplete duty');
      for (const k of ['report', 'pickup']) if (d[k] != null && !finite(d[k].at)) invalid('invalid duty time');
    }
    const assigned = payload.duties.flatMap((d) => d.sectorIds);
    if (assigned.length !== ids.size || new Set(assigned).size !== ids.size) invalid('incomplete sector duties');
    if (payload.events.filter((e) => e.kind === 'flight').length !== payload.sectors.length) invalid('incomplete flight events');
    if (payload.sectors.some((s) => !payload.events.some((e) => e.id === s.eventId && e.kind === 'flight' && e.start === s.dep && e.end === s.arr))) invalid('inconsistent flight events');
    const windowEvents = payload.events.filter((e) => ['standby', 'reserve'].includes(e.kind));
    if (windowEvents.length !== payload.windows.length || payload.windows.some((w) => !windowEvents.some((e) => e.id === w.eventId && e.kind === w.kind && e.start === w.start && e.end === w.end))) invalid('incomplete duty windows');
    for (const d of c.days) {
      const tz = payload.source?.baseTimeZone ?? profile.homeTz;
      const start = startOfLocalDay(d.date, tz), end = startOfLocalDay(addDays(d.date, 1), tz);
      if (!finite(start) || !finite(end)) invalid('invalid coverage zone');
      const events = payload.events.filter((e) => e.start < end && (e.end > start || (e.start === e.end && e.start >= start)));
      if ((d.state === 'rostered') !== (events.length > 0)) invalid('inconsistent day coverage');
      if (d.codes.some((code) => !events.some((e) => e.id === code?.eventId && e.kind === code.kind))) invalid('incomplete day codes');
    }
    return adaptV2(payload, { profile, fetchedAt, kind });
  }
  if (contract !== 'v5') invalid('unsupported storage contract');
  if (!Array.isArray(payload?.upcoming) || !Array.isArray(payload?.daysOff)) invalid('incomplete legacy roster');
  const snapshot = adaptV5(payload, { profile, fetchedAt, kind });
  if (snapshot.warnings.some((w) => ['missing-field', 'malformed-sector', 'malformed-days-off'].includes(w.code))) invalid('malformed legacy roster');
  // Legacy daysOff is absence evidence, never explicit OFF. Preserve that distinction.
  if (!snapshot.sectors.length && !snapshot.offBlocks.length) invalid('empty legacy roster');
  return snapshot;
}

export function validRecord(record, source, profile) {
  try {
    if (record?.version !== 1 || record.source !== source || !Array.isArray(record.history) || record.history.length > MAX_SECTORS || !record.history.every(validEntry)) return false;
    if (record.historyCheckedAt != null && (!finite(record.historyCheckedAt) || record.historyCheckedAt <= 0)) return false;
    const server = record.serverHistory;
    if (server !== null && (!server || !finite(server.fetchedAt) || !Array.isArray(server.sectors) || server.sectors.length > MAX_SERVER_SECTORS || !server.sectors.every(validEntry))) return false;
    acceptedSnapshot(record.contract, record.payload, profile, record.fetchedAt);
    return true;
  } catch { return false; }
}

export function saveRecord(store, record) {
  // localStorage.setItem is a single replacement. Do not remove the previous value first.
  const ok = store.setJSON(ROSTER_KEY, record);
  if (ok) for (const key of LEGACY_KEYS) store.remove(key);
  return ok;
}

export function restoreRecord(store, source, profile, allowMigration) {
  const current = store.getJSON(ROSTER_KEY);
  if (validRecord(current, source, profile)) return { record: current, saved: true };
  // Never reinterpret a corrupt, future-version, or differently bound record as legacy data.
  if (store.get(ROSTER_KEY) !== null || !allowMigration) return { record: null, saved: false };
  const candidates = ['v2', 'v5'].map((contract) => ({ ...store.getJSON(`cache.${contract}`), contract }))
    .filter((r) => finite(r.fetchedAt)).sort((a, b) => b.fetchedAt - a.fetchedAt);
  for (const candidate of candidates) {
    try {
      acceptedSnapshot(candidate.contract, candidate.payload, profile, candidate.fetchedAt);
      const history = store.getJSON('history.v5', []);
      const server = store.getJSON('history.v2');
      const record = { version: 1, source, contract: candidate.contract, payload: candidate.payload, fetchedAt: candidate.fetchedAt,
        history: Array.isArray(history) ? history.filter(validEntry).slice(-MAX_SECTORS) : [],
        serverHistory: server && finite(server.fetchedAt) && Array.isArray(server.sectors)
          ? { fetchedAt: server.fetchedAt, sectors: server.sectors.filter(validEntry).slice(-MAX_SERVER_SECTORS) } : null };
      return { record, saved: saveRecord(store, record) };
    } catch { /* Try the next valid legacy candidate. Never delete an unreadable original. */ }
  }
  return { record: null, saved: false };
}

export function purgeRecords(store) {
  return [ROSTER_KEY, ...LEGACY_KEYS].map((key) => store.remove(key)).every(Boolean);
}
