// Radar (read-only, slice 1): pure helpers. No I/O, no clock, instants (epoch ms) only.
//   selectStandbyWindow  which roster window the screen is about, or why there is none
//   buildRadarView       the provider's scheduled departures, shaped for the screen
// This module only lists scheduled flights during a stated window. It says nothing about the
// crew member and makes no judgement about any flight.

import { rangeForWindow, inWindow } from './scheduled-flights.js';
import { zonedParts, formatTime, formatDate, formatUtcOffset, isValidTimeZone, localDateKey } from '../lib/time.js';
import { airport as airportEntry } from '../data/airports.js';

/** Window kinds the Radar lists flights for. One constant, so another kind can be added later in one place. */
export const RADAR_WINDOW_KINDS = Object.freeze(['standby']);
/** Schedules are only offered this far ahead. */
export const RADAR_HORIZON_MS = 14 * 86400000;
export const RADAR_MAX_WINDOW_HOURS = 24;

const MINUS = '−';
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Whether a chosen window can be listed at `now`; see selectStandbyWindow for the reasons. */
export function checkWindow(window, now) {
  if (window.end <= now) return { window, reason: 'ended', availableFrom: null };
  if (window.start > now + RADAR_HORIZON_MS) return { window, reason: 'too-far', availableFrom: window.start - RADAR_HORIZON_MS };
  if (!rangeForWindow(window, { maxHours: RADAR_MAX_WINDOW_HOURS })) return { window, reason: 'too-long', availableFrom: null };
  return { window, reason: null, availableFrom: null };
}

/**
 * The window the Radar is about.
 *  1. `param` (digits) equal to the start of a window of an allowed kind → that window;
 *  2. else the allowed window containing `now`;
 *  3. else the next allowed window starting within 14 days.
 * A chosen window can still be unusable; `reason` says why:
 *   'ended'    end ≤ now (no request is made for it)
 *   'too-far'  start is more than 14 days ahead; `availableFrom` = start − 14 days
 *   'too-long' longer than 24 h (or invalid), so it cannot be requested
 * With no window at all: {window:null, reason:'none'}.
 * @param {{windows?:Array<{kind:string,start:number,end:number,label?:string|null}>}|null} snapshot
 * @param {number} now
 * @param {string|null} [param]
 * @returns {{window:object|null, reason:null|'none'|'ended'|'too-far'|'too-long', availableFrom:number|null}}
 */
export function selectStandbyWindow(snapshot, now, param = null) {
  const windows = (Array.isArray(snapshot?.windows) ? snapshot.windows : [])
    .filter((w) => RADAR_WINDOW_KINDS.includes(w?.kind) && finite(w.start) && finite(w.end))
    .sort((a, b) => a.start - b.start);
  const verdict = (window) => checkWindow(window, now);

  if (typeof param === 'string' && /^\d{1,16}$/.test(param)) {
    const start = Number(param);
    const match = windows.find((w) => w.start === start);
    if (match) return verdict(match);
  }
  const current = windows.find((w) => w.start <= now && now < w.end);
  if (current) return verdict(current);
  const next = windows.find((w) => w.start > now && w.start <= now + RADAR_HORIZON_MS);
  if (next) return verdict(next);
  return { window: null, reason: 'none', availableFrom: null };
}

/** Whether a roster window deserves an entry link: standby, not ended, starting within 14 days. */
export function radarLinkable(window, now) {
  return Boolean(window) && RADAR_WINDOW_KINDS.includes(window.kind) && finite(window.start) && finite(window.end) && window.end > now && window.start <= now + RADAR_HORIZON_MS;
}

/** The whole-minute difference as text: '+25 min', '−5 min'. */
export function delayText(minutes) {
  return `${minutes < 0 ? MINUS : '+'}${Math.abs(minutes)} min`;
}

function destinationOf(f) {
  const code = typeof f.destination === 'string' && f.destination ? f.destination : null;
  const city = code ? airportEntry(code)?.city ?? null : null;
  const name = typeof f.destinationName === 'string' && f.destinationName.trim() ? f.destinationName.trim() : null;
  return { label: city ?? name ?? code ?? '—', code };
}

/**
 * A state is shown only when the data supports it as a fact: a cancelled flight, or a departed
 * flight whose time (revised, else scheduled) has passed. Every other provider status yields no state.
 */
function stateOf(f, effective, now) {
  if (f.status === 'cancelled') return 'cancelled';
  if (f.status === 'departed' && effective <= now) return 'departed';
  return null;
}

/**
 * @param {import('./types.js').DeparturesResult} result
 * @param {{now:number, window:{start:number,end:number}, emphasisCarriers?:ReadonlyArray<string>|null, homeTz:string}} ctx
 */
export function buildRadarView(result, { now, window, emphasisCarriers = null, homeTz }) {
  const tz = isValidTimeZone(result.airportTz) ? result.airportTz : homeTz;
  const emphasis = Array.isArray(emphasisCarriers) ? emphasisCarriers : [];
  const active = window.start <= now && now < window.end;

  const rows = inWindow(result.flights, window).map((f) => {
    const diff = finite(f.revisedDep) ? Math.round((f.revisedDep - f.scheduledDep) / 60000) : 0;
    const revisedDep = diff !== 0 ? f.revisedDep : null;
    const effective = revisedDep ?? f.scheduledDep;
    const dest = destinationOf(f);
    return Object.freeze({
      id: f.id,
      scheduledDep: f.scheduledDep,
      revisedDep,
      delayMin: revisedDep === null ? null : diff,
      timeText: formatTime(f.scheduledDep, tz),
      revisedText: revisedDep === null ? null : formatTime(revisedDep, tz),
      delayText: revisedDep === null ? null : delayText(diff),
      flightNumber: f.flightNumber,
      carrier: f.carrier ?? null,
      emphasized: Boolean(f.carrier && emphasis.includes(f.carrier)),
      destinationLabel: dest.label,
      destinationCode: dest.code,
      aircraft: f.aircraft?.model || null,
      state: stateOf(f, effective, now),
      effectiveDep: effective,
    });
  });

  const earlier = active ? rows.filter((r) => r.effectiveDep < now) : [];
  const upcoming = active ? rows.filter((r) => r.effectiveDep >= now) : rows;

  // One group per local clock hour at the airport. Keyed by the instant the hour began, so a
  // repeated hour (clocks going back) stays two groups and the order is always by instant.
  const spansDays = localDateKey(window.start, tz) !== localDateKey(window.end - 1, tz);
  const groups = [];
  let lastDate = null;
  for (const row of upcoming) {
    const p = zonedParts(row.scheduledDep, tz);
    const key = row.scheduledDep - (row.scheduledDep % 60000) - p.minute * 60000;
    const last = groups.at(-1);
    if (last && last.key === key) { last.rows.push(row); continue; }
    const date = localDateKey(row.scheduledDep, tz);
    groups.push({
      key,
      hour: p.hour,
      label: `${String(p.hour).padStart(2, '0')}:00`,
      dayLabel: spansDays && date !== lastDate ? formatDate(row.scheduledDep, tz) : null,
      rows: [row],
    });
    lastDate = date;
  }

  return Object.freeze({
    airport: result.airport,
    airportTz: result.airportTz,
    tz,
    tzLabel: result.airportTz !== homeTz ? `Times are local at ${result.airport} (${formatUtcOffset(now, tz)})` : null,
    active,
    now,
    total: rows.length,
    earlier: Object.freeze(earlier),
    groups: Object.freeze(groups.map((g) => Object.freeze({ ...g, rows: Object.freeze(g.rows) }))),
    upcomingCount: upcoming.length,
    fetchedAt: result.fetchedAt,
    fromCache: Boolean(result.fromCache),
  });
}
