// Roster model: sectors → duties → rotations → layovers → days.
// Pure functions over a RosterSnapshot. Layovers are always derived (no source states them)
// and are only created when the itinerary is unambiguous: an arrival at an outstation
// followed by the next departure from that same outstation.

import { addDays, diffDays, localDateKey, startOfLocalDay } from '../lib/time.js';

const HOUR = 3600000;
/** A ground gap longer than this splits two sectors into separate duties. */
export const DUTY_SPLIT_GAP_MS = 6 * HOUR;

/** Groups time-ordered sectors into duties. */
export function buildDuties(sectors, profile) {
  const duties = [];
  let current = null;
  for (const sector of sectors) {
    const gap = current ? sector.dep - current.sectors.at(-1).arr : Infinity;
    const continues = current && gap >= 0 && gap <= DUTY_SPLIT_GAP_MS && sector.origin === current.sectors.at(-1).destination;
    if (!continues) {
      current = { sectors: [] };
      duties.push(current);
    }
    current.sectors.push(sector);
  }
  return duties.map((d, i) => {
    const first = d.sectors[0];
    const last = d.sectors.at(-1);
    const pickup = first.pickup ?? null;
    const wakeup = pickup !== null ? pickup - profile.wakeupOffsetMin * 60000 : null;
    const fromHistory = d.sectors.every((s) => s.provenance === 'history');
    return {
      id: `duty-${first.id}`,
      index: i,
      kind: 'flight',
      sectors: d.sectors,
      wakeup,
      pickup,
      report: null,
      start: wakeup ?? pickup ?? first.dep,
      end: last.arr,
      confidence: 'confirmed',
      provenance: fromHistory ? 'history' : 'source',
    };
  });
}

/**
 * Rotations start at a duty departing a home base (or the first known duty) and close when a
 * duty ends at a home base. Consecutive duties linked through the same outstation produce a
 * derived layover; a mismatch (arrive A, next departs B) produces no layover and a warning.
 */
export function buildRotations(duties, profile) {
  const home = new Set(profile.homeBases);
  const rotations = [];
  const warnings = [];
  let rotation = null;

  for (const duty of duties) {
    const origin = duty.sectors[0].origin;
    const prev = rotation?.duties.at(-1);
    if (!rotation || rotation.closed) {
      rotation = { duties: [], layovers: [], closed: false, openStart: !home.has(origin) };
      rotations.push(rotation);
    } else if (prev) {
      const at = prev.sectors.at(-1).destination;
      if (at === origin && !home.has(at)) {
        rotation.layovers.push({ airport: at, from: prev.end, to: duty.sectors[0].dep, confidence: 'inferred', provenance: 'derived' });
      } else if (at !== origin) {
        warnings.push({ code: 'itinerary-gap', message: `Arrived ${at}, next departure from ${origin}: no layover inferred` });
      }
    }
    rotation.duties.push(duty);
    if (home.has(duty.sectors.at(-1).destination)) rotation.closed = true;
  }

  return {
    rotations: rotations.map((r, i) => ({
      id: `rotation-${r.duties[0].id}`,
      index: i,
      duties: r.duties,
      layovers: r.layovers,
      start: r.duties[0].start,
      end: r.duties.at(-1).end,
      closed: r.closed,
      openStart: r.openStart,
      outstations: [...new Set(r.duties.flatMap((d) => d.sectors.map((s) => s.destination)).filter((c) => !home.has(c)))],
    })),
    warnings,
  };
}

/**
 * Day-by-day view in the home time zone. Status per day, strongest evidence first:
 *   flight      a sector departs or arrives that day (confirmed)
 *   standby/reserve/off  a source-stated window covers the day (confirmed)
 *   layover     inside a derived layover (inferred)
 *   unknown     with evidence: 'no-duty-reported' (source lists the day as free, which
 *               is NOT proof of OFF), 'duty-unspecified' (the source counts the day as busy
 *               but gives no detail), 'outside-window' (the source does not speak for it)
 */
export function buildDays(snapshot, { rotations }, profile, now, count = 7) {
  const tz = profile.homeTz;
  const todayKey = localDateKey(now, tz);
  const free = new Set();
  for (const block of snapshot.offBlocks) {
    for (let i = 0; i < block.days; i += 1) free.add(addDays(block.start, i));
  }
  const layovers = rotations.flatMap((r) => r.layovers);
  const days = [];

  for (let i = 0; i < count; i += 1) {
    const key = addDays(todayKey, i);
    const start = startOfLocalDay(key, tz);
    const end = startOfLocalDay(addDays(key, 1), tz);
    const touching = snapshot.sectors.filter((s) => (s.dep >= start && s.dep < end) || (s.arr >= start && s.arr < end));
    const window = snapshot.windows.find((w) => w.start < end && w.end > start);
    const layover = layovers.find((l) => l.from < end && l.to > start);
    const day = { date: key, start, isToday: i === 0, status: 'unknown', confidence: 'unknown', provenance: 'none', evidence: null, label: null, sectors: touching };

    if (touching.length) {
      const departing = touching.filter((s) => s.dep >= start && s.dep < end);
      const last = (departing.length ? departing : touching).at(-1);
      Object.assign(day, { status: 'flight', confidence: 'confirmed', provenance: 'source', label: last.destination });
    } else if (window) {
      Object.assign(day, { status: window.kind, confidence: 'confirmed', provenance: 'source', label: window.label ?? null });
    } else if (layover) {
      Object.assign(day, { status: 'layover', confidence: 'inferred', provenance: 'derived', label: layover.airport });
      // The source may also count the day as a (non-flight) duty day: keep that evidence visible.
      if (!free.has(key) && snapshot.offCoverageEnd && diffDays(key, snapshot.offCoverageEnd) >= 0) day.evidence = 'duty-unspecified';
    } else if (snapshot.capabilities.explicitOff && free.has(key)) {
      Object.assign(day, { status: 'off', confidence: 'confirmed', provenance: 'source' });
    } else if (free.has(key)) {
      day.evidence = 'no-duty-reported';
    } else if (snapshot.offCoverageEnd && diffDays(key, snapshot.offCoverageEnd) >= 0) {
      day.evidence = 'duty-unspecified';
    } else {
      day.evidence = 'outside-window';
    }
    days.push(day);
  }
  return days;
}

export function buildRoster(snapshot, profile, now) {
  const duties = buildDuties(snapshot.sectors, profile);
  const { rotations, warnings } = buildRotations(duties, profile);
  const days = buildDays(snapshot, { rotations }, profile, now);
  return { duties, rotations, days, warnings: [...snapshot.warnings, ...warnings] };
}
