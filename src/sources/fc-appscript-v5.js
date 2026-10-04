// Roster source adapter: Flight Control Apps Script v5 (`?action=getStats`).
// The ONLY module that knows the v5 payload shape. It validates defensively, keeps v5
// display strings as `legacy` (for parity tests only), and derives everything shown in
// V2 from instants + IANA zones. It never invents data the payload does not contain.

import { airport } from '../data/airports.js';
import { addDays, diffDays, localDateKey, startOfLocalDay } from '../lib/time.js';

export const V5_CAPABILITIES = Object.freeze({
  sectors: true,
  pickup: true,
  offDaysByAbsence: true,  // daysOff = days on which no DE/SB/RE/ORT event starts
  explicitOff: false,
  standbyWindows: false,   // v5 exposes monthly SB/RE counts only
  reserveWindows: false,
  pastSectors: false,      // upcoming starts at today 00:00
  reportTime: false,
  hotels: false,
  history: true,
  actions: Object.freeze(['sync', 'dashboard', 'dashboardPrev']),
});

const IATA = /^[A-Z]{3}$/;
const MAX_PICKUP_LEAD_MS = 8 * 3600 * 1000;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function sectorFrom(raw, index, warnings) {
  const where = `upcoming[${index}]`;
  if (!raw || typeof raw !== 'object') { warnings.push({ code: 'malformed-sector', message: `${where} is not an object` }); return null; }
  const { flightNumber, origin, destination, depTimestamp, endTimestamp } = raw;
  if (typeof flightNumber !== 'string' || !flightNumber.trim()) { warnings.push({ code: 'malformed-sector', message: `${where} has no flight number` }); return null; }
  if (!IATA.test(origin ?? '') || !IATA.test(destination ?? '')) { warnings.push({ code: 'malformed-sector', message: `${where} has an invalid route` }); return null; }
  if (!finite(depTimestamp) || !finite(endTimestamp) || endTimestamp <= depTimestamp) {
    warnings.push({ code: 'malformed-sector', message: `${where} (${flightNumber}) has invalid times` });
    return null;
  }
  const from = airport(origin);
  const to = airport(destination);
  for (const [code, entry] of [[origin, from], [destination, to]]) {
    if (!entry) warnings.push({ code: 'unknown-airport', message: `${code} is not in the airport table; its times are shown in UTC` });
  }
  return {
    id: `${flightNumber.trim()}-${depTimestamp}-${endTimestamp}`,
    flightNumber: flightNumber.trim(),
    origin,
    destination,
    dep: depTimestamp,
    arr: endTimestamp,
    blockMin: Math.round((endTimestamp - depTimestamp) / 60000),
    originTz: from?.tz ?? null,
    destTz: to?.tz ?? null,
    pickup: finite(raw.pickupTimestamp) ? raw.pickupTimestamp : null,
    provenance: 'source',
    legacy: {
      date: raw.date ?? null,
      time: raw.time ?? null,
      arrivalLocal: raw.arrivalLocal ?? null,
      arrivalNextDay: raw.arrivalNextDay ?? null,
      fraDep: raw.fraDep ?? null,
      fraArr: raw.fraArr ?? null,
      daysUntil: raw.daysUntil ?? null,
      duration: raw.duration ?? null,
      pickup: raw.pickup ?? null,
      wakeup: raw.wakeup ?? null,
      originTz: raw.originTz ?? null,
      destTz: raw.destTz ?? null,
    },
  };
}

/**
 * v5 attaches one pickup to every flight departing on the same calendar day. A pickup
 * belongs to the first of those flights only (v5 UI showed it once per day too).
 * Implausible pickups (after departure, or more than 8 h before it) are dropped with a warning.
 */
function assignPickups(sectors, warnings) {
  const claimed = new Set();
  for (const sector of sectors) {
    const pickup = sector.pickup;
    if (pickup === null) continue;
    if (claimed.has(pickup)) { sector.pickup = null; continue; }
    if (pickup >= sector.dep || sector.dep - pickup > MAX_PICKUP_LEAD_MS) {
      warnings.push({ code: 'implausible-pickup', message: `Pickup for ${sector.flightNumber} does not precede its departure plausibly; ignored` });
      sector.pickup = null;
      continue;
    }
    claimed.add(pickup);
  }
}

function offBlocksFrom(raw, todayKey, warnings) {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) warnings.push({ code: 'malformed-days-off', message: 'daysOff is not a list' });
    return [];
  }
  const blocks = [];
  for (const block of raw) {
    // Built from daysUntil + count; v5's display strings carry no year and are not parsed.
    if (!Number.isInteger(block?.daysUntil) || !Number.isInteger(block?.count) || block.count < 1 || block.daysUntil < 0) {
      warnings.push({ code: 'malformed-days-off', message: 'A days-off block has invalid numbers; ignored' });
      continue;
    }
    blocks.push({ start: addDays(todayKey, block.daysUntil), days: block.count });
  }
  return blocks;
}

/**
 * @param {unknown} payload  parsed getStats JSON
 * @param {{profile: object, fetchedAt: number, kind?: 'live'|'fixture'|'cache'}} options
 *   fetchedAt is the moment the payload was produced: v5's relative fields (daysUntil) count
 *   from that day, so cached payloads stay correct on later days.
 * @returns {import('../model/types.js').RosterSnapshot}
 */
export function adaptV5(payload, { profile, fetchedAt, kind = 'live' }) {
  if (!Number.isFinite(fetchedAt)) throw new AdapterError('invalid-payload', 'Missing fetch time for the roster payload.');
  if (!payload || typeof payload !== 'object') throw new AdapterError('invalid-payload', 'The roster response is not an object.');
  if (payload.success !== true) {
    throw new AdapterError('backend-error', typeof payload.message === 'string' ? payload.message : 'The roster backend reported an error.');
  }
  const warnings = [];
  const todayKey = localDateKey(fetchedAt, profile.homeTz);

  let upcoming = payload.upcoming;
  if (!Array.isArray(upcoming)) {
    warnings.push({ code: 'missing-field', message: 'upcoming flights are missing' });
    upcoming = [];
  }
  const seen = new Map();
  const duplicates = [];
  const departures = new Map();
  const sectors = upcoming.map((raw, i) => sectorFrom(raw, i, warnings)).filter(Boolean).filter((s) => {
    // The joint calendar can contain the same flight twice; identical entries are one sector.
    const key = `${s.flightNumber}|${s.origin}|${s.destination}|${s.dep}|${s.arr}`;
    if (seen.has(key)) {
      const kept = seen.get(key);
      if (kept.pickup === null && s.pickup !== null) kept.pickup = s.pickup;
      duplicates.push(s);
      warnings.push({ code: 'duplicate-sector', message: `${s.flightNumber} appears twice in the roster source with identical times; shown once.` });
      return false;
    }
    seen.set(key, s);
    const depKey = `${s.flightNumber}|${s.dep}`;
    if (departures.has(depKey)) {
      warnings.push({ code: 'conflicting-sectors', message: `${s.flightNumber} is listed twice with the same departure but different arrival times; both are shown.` });
    }
    departures.set(depKey, s);
    return true;
  }).sort((a, b) => a.dep - b.dep);
  assignPickups(sectors, warnings);
  if (upcoming.length >= 5) {
    warnings.push({ code: 'upcoming-truncated', message: 'The source lists only the next 5 flights; later days may be incomplete.' });
  }

  const offBlocks = offBlocksFrom(payload.daysOff, todayKey, warnings);
  // v5 scans 30 days and returns at most 3 blocks: it speaks for days up to the end of the
  // 3rd block, or the whole 30-day scan when fewer blocks were found.
  let offCoverageEnd = null;
  if (Array.isArray(payload.daysOff)) {
    offCoverageEnd = offBlocks.length >= 3
      ? addDays(offBlocks[2].start, offBlocks[2].days - 1)
      : addDays(todayKey, 29);
  }

  const db = payload.dutyBlock;
  const dutyBlock = db && [db.current, db.nextOffInDays, db.maxThisMonth].every(Number.isInteger)
    ? { current: db.current, nextOffInDays: db.nextOffInDays, maxThisMonth: db.maxThisMonth }
    : null;

  return {
    source: { id: 'fc-appscript-v5', label: 'Flight Control calendar', kind, fetchedAt },
    capabilities: V5_CAPABILITIES,
    sectors,
    // v5 lists flights from 00:00 of the fetch day (script time zone) onwards.
    coverageStart: startOfLocalDay(todayKey, profile.homeTz),
    windows: [],
    offBlocks,
    offCoverageEnd,
    dutyBlock,
    stats: correctStatsForDuplicates(payload, duplicates, fetchedAt, profile.homeTz),
    map: payload.map ?? null,
    achievements: Array.isArray(payload.achievements) ? payload.achievements : [],
    warnings,
  };
}

/**
 * v5 counts every calendar event, so a duplicated flight inflates its statistics. Where the
 * duplicate is visible (it is in `upcoming`), remove exactly its contribution and record the
 * correction. Duplicates outside the visible window cannot be detected (documented gap).
 */
function correctStatsForDuplicates(payload, duplicates, fetchedAt, tz) {
  const month = payload.month && typeof payload.month === 'object' ? { ...payload.month } : null;
  const year = payload.year && typeof payload.year === 'object' ? { ...payload.year } : null;
  const allTime = payload.allTime && typeof payload.allTime === 'object' ? { ...payload.allTime } : null;
  const adjustments = [];
  const fetchKey = localDateKey(fetchedAt, tz);
  const fetchMonth = fetchKey.slice(0, 7);
  const monthStart = startOfLocalDay(`${fetchMonth}-01`, tz);
  const nextMonth = fetchMonth.slice(5) === '12' ? `${Number(fetchMonth.slice(0, 4)) + 1}-01` : `${fetchMonth.slice(0, 4)}-${String(Number(fetchMonth.slice(5)) + 1).padStart(2, '0')}`;
  const monthEnd = startOfLocalDay(`${nextMonth}-01`, tz);
  const round1 = (x) => Math.round(x * 10) / 10;
  const adjust = (obj, scope, field, delta, sector) => {
    if (!obj || !Number.isFinite(obj[field])) return;
    obj[field] = round1(obj[field] + delta);
    adjustments.push({ field: `${scope}.${field}`, delta: round1(delta), reason: `duplicate ${sector.flightNumber} ${sector.origin}→${sector.destination}` });
  };
  for (const s of duplicates) {
    const hours = s.blockMin / 60;
    // v5's month query counts any event overlapping the month (e.g. an overnight arrival on the 1st).
    if (s.dep < monthEnd && s.arr > monthStart) {
      adjust(month, 'month', 'flights', -1, s);
      adjust(month, 'month', 'hours', -hours, s);
      if (s.dep > fetchedAt) adjust(month, 'month', 'flightsRemaining', -1, s);
    }
    if (s.dep <= fetchedAt) {
      // Already-started duplicates are also inside v5's year/all-time counts.
      adjust(year, 'year', 'flights', -1, s);
      adjust(year, 'year', 'hours', -hours, s);
      adjust(allTime, 'allTime', 'flights', -1, s);
      if (allTime && Number.isFinite(allTime.hours)) {
        adjust(allTime, 'allTime', 'hours', -hours, s);
        allTime.hours = Math.round(allTime.hours); // v5 reports whole hours
      }
    }
  }
  if (year && adjustments.some((a) => a.field === 'year.hours') && Number.isFinite(year.projectedHours)) {
    // v5: projectedHours = round(hours / dayOfYear × 365).
    const dayOfYear = diffDays(`${fetchKey.slice(0, 4)}-01-01`, fetchKey) + 1; // calendar days: DST-safe
    year.projectedHours = Math.round((year.hours / dayOfYear) * 365);
  }
  if (month && adjustments.some((a) => a.field === 'month.hours') && Number.isFinite(month.daysInMonth)) {
    // v5: projectedHours = hours / dayOfMonth × daysInMonth (linear), recomputed from the corrected hours.
    const dayOfMonth = Number(fetchKey.slice(8, 10));
    month.projectedHours = round1((month.hours / dayOfMonth) * month.daysInMonth);
  }
  // Not correctable from the payload: route/destination counts and achievements (see DATA-GAPS).
  return { month, year, allTime, adjustments };
}

export class AdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
  }
}
