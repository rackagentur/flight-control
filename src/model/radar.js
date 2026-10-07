// Radar (read-only, slice 1): pure helpers. No I/O, no clock, instants (epoch ms) only.
//   selectStandbyWindow  which roster window the screen is about, or why there is none
//   radarAirport         which airport the standby is served from (roster, adjacent duty, or base)
//   radarCarriers        which carriers the list is filtered to (the active airline pack's designators)
//   buildRadarView       the provider's scheduled departures, shaped for the screen
// This module only lists scheduled flights during a stated window. It says nothing about the
// crew member and makes no judgement about any flight.

import { rangeForWindow, inWindow } from './scheduled-flights.js';
import { buildDuties } from './roster.js';
import { zonedParts, formatTime, formatDate, formatUtcOffset, isValidTimeZone, localDateKey } from '../lib/time.js';
import { airport as airportEntry } from '../data/airports.js';

/** Window kinds the Radar lists flights for. One constant, so another kind can be added later in one place. */
export const RADAR_WINDOW_KINDS = Object.freeze(['standby']);
/** Schedules are only offered this far ahead. */
export const RADAR_HORIZON_MS = 14 * 86400000;
export const RADAR_MAX_WINDOW_HOURS = 24;

/**
 * Reliability horizon for inferring the standby airport from an adjacent flight: the next duty must
 * depart no later than this after the window ends, and the previous sector must have arrived no earlier
 * than this before the window starts. Beyond it the neighbour says nothing reliable about where the
 * standby is served, so the next rule (finally the profile base) applies.
 */
export const RADAR_INFER_HORIZON_MS = 48 * 3600000;
/** The backend accepts at most this many carrier codes per departures request. */
export const RADAR_MAX_CARRIERS = 10;

const MINUS = '−';
const IATA = /^[A-Z]{3}$/;
const DESIGNATOR = /^[A-Z0-9]{2}$/;
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

/**
 * Where the standby is served from, first reliable rule wins. Instants only; pure (no clock, no I/O).
 *  1. 'roster'             the window's own roster event states an airport (window.location, IATA);
 *  2. 'inferred-next'      the origin of the first sector of the NEXT duty (first sector departing at or after
 *                          the window's end), when no other flight sector departs between the window's start
 *                          and that sector, and the sector departs within RADAR_INFER_HORIZON_MS of the end;
 *  3. 'inferred-previous'  else the destination of the last sector that departed before the window's start,
 *                          when it had arrived by the start and no more than RADAR_INFER_HORIZON_MS before it;
 *  4. 'base'               else the profile's base: a fallback, not a finding.
 * Only the snapshot's sectors are read (the roster model's own duty grouping decides what a duty is).
 * @param {{start:number,end:number,location?:string|null}} window
 * @param {{sectors?:Array<import('./types.js').Sector>}|null} snapshot
 * @param {{base?:string|null}} profile
 * @returns {{airport:string|null, basis:'roster'|'inferred-next'|'inferred-previous'|'base'}}
 */
export function radarAirport(window, snapshot, profile) {
  if (typeof window?.location === 'string' && IATA.test(window.location)) return { airport: window.location, basis: 'roster' };
  const sectors = (Array.isArray(snapshot?.sectors) ? snapshot.sectors : [])
    .filter((s) => finite(s?.dep) && finite(s?.arr) && IATA.test(s.origin ?? '') && IATA.test(s.destination ?? ''))
    .sort((a, b) => a.dep - b.dep);
  if (finite(window?.start) && finite(window?.end) && sectors.length) {
    const next = buildDuties(sectors, profile ?? {}).find((d) => d.sectors[0].dep >= window.end);
    if (next) {
      const first = next.sectors[0];
      const own = new Set(next.sectors);
      const between = sectors.some((s) => !own.has(s) && s.dep >= window.start && s.dep < first.dep);
      const start = finite(next.start) ? Math.min(next.start, first.dep) : first.dep;
      if (!between && start - window.end <= RADAR_INFER_HORIZON_MS) return { airport: first.origin, basis: 'inferred-next' };
    }
    const before = sectors.filter((s) => s.dep < window.start);
    const prev = before.at(-1);
    if (prev && prev.arr <= window.start && window.start - prev.arr <= RADAR_INFER_HORIZON_MS) return { airport: prev.destination, basis: 'inferred-previous' };
  }
  return { airport: profile?.base ?? null, basis: 'base' };
}

/**
 * The carrier filter for a pack: its flight designators (deduplicated, pack order, at most
 * RADAR_MAX_CARRIERS), or null when the pack has none (no filter: all carriers).
 * @param {{flightDesignators?:ReadonlyArray<string>}|null|undefined} pack
 * @returns {string[]|null}
 */
export function radarCarriers(pack) {
  const list = Array.isArray(pack?.flightDesignators) ? [...new Set(pack.flightDesignators.filter((c) => typeof c === 'string' && DESIGNATOR.test(c)))] : [];
  return list.length ? list.slice(0, RADAR_MAX_CARRIERS) : null;
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
 * `carriers` (non-empty array) is the list the request asked for. The backend filters server-side; this is the
 * defensive client-side twin: a row whose carrier is not in the list (or unknown) is never shown.
 * @param {{now:number, window:{start:number,end:number}, emphasisCarriers?:ReadonlyArray<string>|null, carriers?:ReadonlyArray<string>|null, homeTz:string}} ctx
 */
export function buildRadarView(result, { now, window, emphasisCarriers = null, carriers = null, homeTz }) {
  const tz = isValidTimeZone(result.airportTz) ? result.airportTz : homeTz;
  const emphasis = Array.isArray(emphasisCarriers) ? emphasisCarriers : [];
  const active = window.start <= now && now < window.end;

  const only = Array.isArray(carriers) && carriers.length ? carriers : null;

  const rows = inWindow(result.flights, window).filter((f) => !only || (typeof f.carrier === 'string' && only.includes(f.carrier))).map((f) => {
    // The delay is computed from the whole-minute clock times the row displays (seconds dropped, as
    // formatTime does), so the text always equals revised minus scheduled as shown.
    const diff = finite(f.revisedDep) ? Math.floor(f.revisedDep / 60000) - Math.floor(f.scheduledDep / 60000) : 0;
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
      date,
      label: `${String(p.hour).padStart(2, '0')}:00`,
      dayLabel: spansDays && date !== lastDate ? formatDate(row.scheduledDep, tz) : null,
      rows: [row],
    });
    lastDate = date;
  }

  // A repeated hour (clocks going back) would give two identical headings on the same day: each
  // such heading also states its UTC offset. A label repeating on another day is told apart by the day line.
  const repeated = groups.filter((g) => groups.filter((o) => o.date === g.date && o.label === g.label).length > 1);
  for (const g of repeated) g.label = `${g.label} · ${formatUtcOffset(g.key, tz)}`;

  return Object.freeze({
    airport: result.airport,
    airportTz: result.airportTz,
    tz,
    tzLabel: result.airportTz !== homeTz ? `Times are local at ${result.airport} (${formatUtcOffset(now, tz)})` : null,
    active,
    now,
    total: rows.length,
    earlier: Object.freeze(earlier),
    groups: Object.freeze(groups.map(({ date, ...g }) => Object.freeze({ ...g, rows: Object.freeze(g.rows) }))),
    upcomingCount: upcoming.length,
    fetchedAt: result.fetchedAt,
    fromCache: Boolean(result.fromCache),
  });
}
