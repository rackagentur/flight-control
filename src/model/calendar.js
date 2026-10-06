// Month model for the roster Calendar. Pure geometry + summary on top of the SAME day
// classifier Today uses (roster.buildDays), so a day can never be classified differently
// in the two places. Weeks start on Monday.

import { addDays, diffDays, localDateKey, zonedParts } from '../lib/time.js';
import { buildDays } from './roster.js';

const MONTH = /^(\d{4})-(\d{2})$/;

export function monthKeyOf(dateKey) {
  return dateKey.slice(0, 7);
}

export function addMonths(monthKey, n) {
  const [, y, m] = monthKey.match(MONTH);
  const index = Number(y) * 12 + (Number(m) - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

export function daysInMonth(monthKey) {
  const first = `${monthKey}-01`;
  return diffDays(first, `${addMonths(monthKey, 1)}-01`);
}

export function monthLabel(monthKey, locale = 'en-GB') {
  const [, y, m] = monthKey.match(MONTH);
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(Number(y), Number(m) - 1, 15));
}

/** Monday-based weekday index (0 = Mon … 6 = Sun) of a date key. */
export function weekdayIndex(dateKey) {
  return (zonedParts(Date.parse(`${dateKey}T12:00:00Z`), 'UTC').weekday + 6) % 7;
}

/**
 * @returns {{monthKey: string, label: string, weeks: object[][], days: object[], summary: object, coverage: object}}
 */
export function buildMonth(snapshot, roster, profile, now, monthKey) {
  const first = `${monthKey}-01`;
  const lead = weekdayIndex(first);
  const length = daysInMonth(monthKey);
  const cells = Math.ceil((lead + length) / 7) * 7;
  const gridStart = addDays(first, -lead);
  const days = buildDays(snapshot, roster, profile, now, { from: gridStart, count: cells }).map((day, i) => ({
    ...day,
    inMonth: day.date.slice(0, 7) === monthKey,
    column: i % 7,
  }));
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

  const inMonth = days.filter((d) => d.inMonth);
  const count = (pred) => inMonth.filter(pred).length;
  const summary = {
    flightDays: count((d) => d.status === 'flight'),
    layoverDays: count((d) => d.status === 'layover'),
    standbyDays: count((d) => d.status === 'standby'),
    reserveDays: count((d) => d.status === 'reserve'),
    offDays: count((d) => d.status === 'off'),
    unassignedDays: count((d) => d.status === 'unassigned'),
    sectors: new Set(inMonth.flatMap((d) => d.sectors.filter((s) => localDateKey(s.dep, profile.homeTz).slice(0, 7) === monthKey).map((s) => s.id))).size,
    rotations: new Set(inMonth.map((d) => d.rotationId).filter(Boolean)).size,
    unknownDuty: count((d) => d.status === 'unknown' && d.evidence === 'duty-unspecified'),
    unknownFree: count((d) => d.status === 'unknown' && d.evidence === 'no-duty-reported'),
    unknownOther: count((d) => d.status === 'unknown' && d.evidence === 'no-flight-listed'),
    noData: count((d) => d.evidence === 'before-source' || d.evidence === 'outside-window'),
    days: length,
  };

  const tz = profile.homeTz;
  const historyDays = snapshot.sectors.filter((s) => s.provenance === 'history').map((s) => localDateKey(s.dep, tz)).sort();
  const coverage = {
    from: Number.isFinite(snapshot.coverageStart) ? localDateKey(snapshot.coverageStart, tz) : null,
    flightsTo: snapshot.flightCoverageEnd ?? null,
    freeListTo: snapshot.offCoverageEnd ?? null,
    rememberedFrom: historyDays[0] ?? null,
    complete: summary.noData === 0 && summary.unknownOther === 0,
  };

  return { monthKey, label: monthLabel(monthKey), weeks, days, summary, coverage, todayKey: localDateKey(now, tz) };
}

/** Months the source can say something about (for the UI's "no data" hint), as month keys. */
export function coveredMonths(snapshot, profile) {
  const tz = profile.homeTz;
  const keys = new Set();
  const from = Number.isFinite(snapshot.coverageStart) ? localDateKey(snapshot.coverageStart, tz) : null;
  const to = [snapshot.flightCoverageEnd, snapshot.offCoverageEnd].filter(Boolean).sort().at(-1) ?? from;
  if (from && to) for (let k = monthKeyOf(from); k <= monthKeyOf(to); k = addMonths(k, 1)) keys.add(k);
  for (const s of snapshot.sectors) keys.add(localDateKey(s.dep, tz).slice(0, 7));
  return [...keys].sort();
}

