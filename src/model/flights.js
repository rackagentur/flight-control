// Flights model (Phase 6): rotations as journeys, sectors inside them, the honest end of the
// listed flights, and recently flown sectors seen on this device.
// Built entirely on the roster model (duties, rotations, stated windows): no parser, no
// classifier, no rotation engine of its own. A sector is always shown inside its rotation.

import { dayShift, diffDays, localDateKey } from '../lib/time.js';
import { layoverCalendarDays, statedLayover } from './roster.js';
import { buildRotationHorizon } from './horizon.js';
import { buildDestination } from './destination.js';
import { KEEP_DAYS } from './history.js';

/** Calendar-day number of `ms` inside a rotation (1-based, home time zone). */
function dayNumber(rotation, ms, tz) {
  return diffDays(localDateKey(rotation.start, tz), localDateKey(ms, tz)) + 1;
}

function provenanceOf(sectors) {
  const kinds = new Set(sectors.map((s) => (s.provenance === 'history' ? 'history' : 'source')));
  return kinds.size > 1 ? 'mixed' : [...kinds][0] ?? 'source';
}

/**
 * The journey of one rotation: an ordered list of legs.
 *   duty     start of a duty day (wake-up/pickup when known)
 *   sector   a flight
 *   turn     ground time between sectors of the same duty
 *   layover  between duties at an outstation: confirmed (stated window) or inferred
 *   open     the rotation has not returned to base in the visible data
 * Each sector also carries the stay that follows it, which drives its destination layer.
 */
function journeyOf(rotation, snapshot, profile, now) {
  const tz = profile.homeTz;
  const home = new Set(profile.homeBases);
  const legs = [];
  const sectors = [];
  const all = rotation.duties.flatMap((d) => d.sectors);
  const days = dayNumber(rotation, rotation.end, tz);
  // The first sector anywhere in the data departing after `ms` (the itinerary continues there).
  const nextKnown = (ms) => snapshot.sectors.find((x) => x.dep > ms) ?? null;

  rotation.duties.forEach((duty, di) => {
    legs.push({ type: 'duty', duty, date: localDateKey(duty.sectors[0].dep, tz), wakeup: duty.wakeup, pickup: duty.pickup, origin: duty.sectors[0].origin, originTz: duty.sectors[0].originTz });
    duty.sectors.forEach((s, si) => {
      const next = duty.sectors[si + 1] ?? null;
      const nextDuty = next ? null : rotation.duties[di + 1] ?? null;
      let stay = null;
      // Stays carry their own length; nights are counted in the outstation's local dates.
      const sized = (x) => ({ ...x, minutes: x.to === null ? null : Math.round((x.to - x.from) / 60000),
        nights: x.to === null || x.kind === 'turn' || x.kind === 'gap' ? null : layoverCalendarDays(x.from, x.to, s.destTz ?? tz) });
      if (next) {
        stay = { kind: 'turn', confidence: null, from: s.arr, to: next.dep };
      } else if (nextDuty) {
        const stated = statedLayover(snapshot.windows, s.destination, s.arr, nextDuty.sectors[0].dep);
        stay = { kind: 'layover', confidence: stated ? 'confirmed' : 'inferred', from: s.arr, to: nextDuty.sectors[0].dep };
      } else if (!home.has(s.destination) && !rotation.closed) {
        const later = nextKnown(s.arr);
        // "Return not yet listed" only when the source lists nothing later and this sector is
        // current source data. A later flight from elsewhere, or a remembered sector with no
        // continuation, is an itinerary gap: never an ongoing stay, no hotel, no weather now.
        // Same airport but beyond the inferred-layover limit (6 calendar days): 'too-long'.
        if (later) stay = { kind: 'gap', confidence: null, from: s.arr, to: later.dep, nextOrigin: later.origin, reason: later.origin === s.destination ? 'too-long' : 'elsewhere' };
        else if (s.provenance === 'history') stay = { kind: 'gap', confidence: null, from: s.arr, to: null, nextOrigin: null, reason: 'not-seen' };
        else stay = { kind: 'open', confidence: null, from: s.arr, to: null };
      }
      if (stay) stay = sized(stay);
      const index = all.indexOf(s);
      const entry = {
        sector: s,
        rotationId: rotation.id,
        dutyId: duty.id,
        index,
        count: all.length,
        day: dayNumber(rotation, s.dep, tz),
        days,
        firstOfDuty: si === 0,
        wakeup: si === 0 ? duty.wakeup : null,
        pickup: si === 0 ? duty.pickup : null,
        shift: s.originTz && s.destTz ? dayShift(s.dep, s.originTz, s.arr, s.destTz) : null,
        status: s.arr <= now ? 'past' : s.dep <= now ? 'active' : 'upcoming',
        stay,
        destination: buildDestination({ iata: s.destination, tz: s.destTz, arrival: s.arr, stay }, profile, now),
      };
      sectors.push(entry);
      legs.push({ type: 'sector', entry });
      if (stay) legs.push({ type: stay.kind, stay, airport: s.destination, entry });
    });
  });
  return { legs, sectors };
}

function describeRotation(rotation, snapshot, state, profile, now) {
  const { legs, sectors } = journeyOf(rotation, snapshot, profile, now);
  const all = rotation.duties.flatMap((d) => d.sectors);
  const lastStay = sectors.at(-1)?.stay ?? null;
  // openEnd: the return is genuinely not listed yet (the source lists nothing later). A gap
  // (the itinerary continues elsewhere, or a remembered sector without continuation) is not.
  const openEnd = lastStay?.kind === 'open';
  // A trip still waiting for its (unlisted) return is not history yet.
  const status = rotation.end <= now && !openEnd ? 'past' : rotation.start <= now ? 'active' : 'upcoming';
  return {
    id: rotation.id,
    rotation,
    status,
    route: [all[0].origin, ...all.map((s) => s.destination)],
    destination: rotation.outstations[0] ?? all.at(-1).destination,
    start: rotation.start,
    end: rotation.end,
    firstDep: all[0].dep,
    days: dayNumber(rotation, rotation.end, profile.homeTz),
    blockMin: all.reduce((sum, s) => sum + s.blockMin, 0),
    sectorCount: all.length,
    openStart: rotation.openStart,
    openEnd,
    gapEnd: lastStay?.kind === 'gap',
    provenance: provenanceOf(all),
    legs,
    sectors,
    horizon: status !== 'past' ? buildRotationHorizon(rotation, state, profile, now) : null,
  };
}

/**
 * Where the list of upcoming flights ends, and why. With v5 the source shares at most 5
 * flights: that is stated calmly, never shown as an error.
 */
function listBoundary(snapshot, upcoming) {
  if (snapshot.warnings.some((w) => w.code === 'missing-field')) return { kind: 'missing', listed: 0, through: null };
  const truncated = snapshot.warnings.some((w) => w.code === 'upcoming-truncated');
  const listed = snapshot.sectors.filter((s) => s.provenance !== 'history').length;
  if (truncated) return { kind: 'truncated', listed, limit: snapshot.flightListLimit ?? null, through: snapshot.flightCoverageEnd ?? null };
  return { kind: 'window', listed, through: snapshot.flightCoverageEnd ?? null, empty: upcoming.length === 0 };
}

/**
 * @returns {{upcoming: object[], recent: object, boundary: object, sectors: Map<string, object>}}
 */
export function buildFlights(snapshot, roster, state, profile, now) {
  const rotations = roster.rotations.map((r) => describeRotation(r, snapshot, state, profile, now));
  const upcoming = rotations.filter((r) => r.status !== 'past');
  const pastRotations = rotations.filter((r) => r.status === 'past').reverse();
  const sectors = new Map(rotations.flatMap((r) => r.sectors.map((e) => [e.sector.id, { ...e, journey: r }])));

  // "Seen on this device": flown sectors, newest first, grouped by month of the rotation.
  const flown = pastRotations.flatMap((r) => r.sectors);
  const months = [];
  for (const r of pastRotations) {
    const key = localDateKey(r.start, profile.homeTz).slice(0, 7);
    let group = months.at(-1);
    if (!group || group.month !== key) { group = { month: key, rotations: [] }; months.push(group); }
    group.rotations.push(r);
  }
  const recent = {
    keepDays: KEEP_DAYS,
    count: flown.length,
    remembered: flown.filter((e) => e.sector.provenance === 'history').length,
    since: flown.length ? Math.min(...flown.map((e) => e.sector.dep)) : null,
    months,
  };

  return { upcoming, recent, boundary: listBoundary(snapshot, upcoming), sectors };
}

/** The sector shown when none is selected: the current or next one, else the latest flown. */
export function defaultSector(flights) {
  for (const r of flights.upcoming) {
    const e = r.sectors.find((x) => x.status !== 'past') ?? r.sectors[0];
    if (e) return e.sector.id;
  }
  return flights.recent.months[0]?.rotations[0]?.sectors.at(-1)?.sector.id ?? null;
}
