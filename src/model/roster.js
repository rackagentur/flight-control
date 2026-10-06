// Roster model: sectors → duties → rotations → layovers → days.
// Pure functions over a RosterSnapshot. Inferred layovers are only created when the itinerary
// is unambiguous: an arrival at an outstation followed by the next departure from that same
// outstation within MAX_INFERRED_LAYOVER_DAYS calendar days (approved classifier rule).
// Source-stated layover windows are separate and never capped.

import { addDays, diffDays, localDateKey, startOfLocalDay } from '../lib/time.js';

const HOUR = 3600000;
/** A ground gap longer than this splits two sectors into separate duties. */
export const DUTY_SPLIT_GAP_MS = 6 * HOUR;

/**
 * Approved rule: a layover may be inferred only when the departure date is at most this many
 * calendar days after the arrival date, both in the outstation's local time (home time zone
 * when the outstation's zone is unknown). Longer gaps stay UNKNOWN; never OFF.
 */
export const MAX_INFERRED_LAYOVER_DAYS = 6;

export function layoverCalendarDays(arrival, departure, tz) {
  return diffDays(localDateKey(arrival, tz), localDateKey(departure, tz));
}

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
    // Report (check-in) time only when the source states it (v2); never estimated.
    const report = Number.isFinite(first.report) ? first.report : null;
    const fromHistory = d.sectors.every((s) => s.provenance === 'history');
    return {
      id: `duty-${first.id}`,
      index: i,
      kind: 'flight',
      sectors: d.sectors,
      wakeup,
      pickup,
      report,
      start: wakeup ?? pickup ?? report ?? first.dep,
      end: last.arr,
      confidence: 'confirmed',
      provenance: fromHistory ? 'history' : 'source',
    };
  });
}

/** The source-stated layover window covering a ground gap at `airport`, if any. */
export function statedLayover(windows, airport, from, to) {
  return windows.find((w) => w.kind === 'layover' && (!w.label || w.label === airport) && w.start < to && w.end > from) ?? null;
}

/**
 * Rotations start at a duty departing a home base (or the first known duty) and close when a
 * duty ends at a home base. Consecutive duties linked through the same outstation produce a
 * derived layover; a mismatch (arrive A, next departs B) ends the rotation with a warning.
 */
export function buildRotations(duties, profile, windows = []) {
  const home = new Set(profile.homeBases);
  const rotations = [];
  const warnings = [];
  let rotation = null;

  for (const duty of duties) {
    const origin = duty.sectors[0].origin;
    const prev = rotation?.duties.at(-1);
    const at = prev?.sectors.at(-1).destination;
    // A gap in the itinerary (arrive A, next departure from B) ends the rotation: the two
    // duties are never connected merely because the roster lists them one after the other.
    const mismatch = rotation && !rotation.closed && at !== origin;
    if (mismatch) {
      warnings.push({ code: 'itinerary-gap', message: `Arrived ${at}, next departure from ${origin}: no layover inferred` });
    }
    // Same outstation but too long apart: not a plausible layover, so not inferred and not connected.
    const tz = prev?.sectors.at(-1).destTz ?? profile.homeTz;
    // An explicit roster layover covering the gap is never capped.
    const stated = prev && Boolean(statedLayover(windows, at, prev.end, duty.sectors[0].dep));
    const tooLong = rotation && !rotation.closed && !mismatch && !home.has(at) && !stated
      && layoverCalendarDays(prev.end, duty.sectors[0].dep, tz) > MAX_INFERRED_LAYOVER_DAYS;
    if (tooLong) {
      warnings.push({ code: 'layover-too-long', message: `${layoverCalendarDays(prev.end, duty.sectors[0].dep, tz)} days between arriving ${at} and departing ${at}: longer than ${MAX_INFERRED_LAYOVER_DAYS}, so no layover is inferred` });
    }
    const gap = mismatch || tooLong;
    if (!rotation || rotation.closed || gap) {
      rotation = { duties: [], layovers: [], closed: false, openStart: !home.has(origin) };
      rotations.push(rotation);
    } else if (at === origin && !home.has(at)) {
      rotation.layovers.push({ airport: at, from: prev.end, to: duty.sectors[0].dep, confidence: 'inferred', provenance: 'derived' });
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

/** When windows overlap a day: standby/reserve first, then a stated layover, then off. */
export const WINDOW_RANK = { standby: 0, reserve: 1, layover: 2, off: 3 };

/** Plain-language meaning of each UNKNOWN evidence code (shared by Today and Calendar). */
export const EVIDENCE = {
  'no-duty-reported': 'The source lists no flight, standby or reserve starting this day. Not proof of a day off.',
  'duty-unspecified': 'The source counts this as a duty day without a flight (standby, reserve or ground duty), with no details.',
  'no-flight-listed': 'No flight is listed for this day; other duties are not covered by the source.',
  'before-source': 'Before the period the source covers.',
  'outside-window': 'Outside the period the source covers.',
  'nothing-rostered': 'The roster lists nothing for this day. Not proof of a day off.',
  'not-published': 'The roster has not been published this far yet.',
  'unknown-code': 'The roster lists a code Flight Control does not recognise. It is shown as it is, not as a duty or a day off.',
};

/**
 * Day-by-day view in the home time zone, for any date range. The single classifier used by
 * Today (7-day strip) and Calendar (month grid). Strongest evidence first:
 *   flight            a duty (wake-up/pickup → last arrival) overlaps the day (confirmed)
 *   standby/reserve/off/layover  a source-stated window covers the day (confirmed)
 *   layover           inside a derived layover (inferred, provenance derived)
 *   unknown           with an evidence code (see EVIDENCE); never styled or labelled as OFF
 * Each day also carries its rotation membership for continuity drawing.
 * @param {{from?: string, count?: number}} [range] from = 'YYYY-MM-DD' (default today), count days
 */
export function buildDays(snapshot, { duties, rotations }, profile, now, { from = null, count = 7 } = {}) {
  const tz = profile.homeTz;
  const todayKey = localDateKey(now, tz);
  const startKey = from ?? todayKey;
  const free = new Set();
  for (const block of snapshot.offBlocks) {
    for (let i = 0; i < block.days; i += 1) free.add(addDays(block.start, i));
  }
  const layovers = rotations.flatMap((r) => r.layovers);
  const coverageStartKey = Number.isFinite(snapshot.coverageStart) ? localDateKey(snapshot.coverageStart, tz) : null;
  const rotationSpans = rotations.map((r) => ({ r, first: localDateKey(r.start, tz), last: localDateKey(r.end, tz) }));
  const days = [];

  for (let i = 0; i < count; i += 1) {
    const key = addDays(startKey, i);
    const start = startOfLocalDay(key, tz);
    const end = startOfLocalDay(addDays(key, 1), tz);
    const dayDuties = duties.filter((d) => d.start < end && d.end > start);
    const touching = dayDuties.flatMap((d) => d.sectors).filter((s) => s.dep < end && s.arr > start);
    // Several windows may touch a day: duty windows outrank a stated layover, which outranks off.
    const window = snapshot.windows.filter((w) => w.start < end && w.end > start)
      .sort((a, b) => (WINDOW_RANK[a.kind] ?? 9) - (WINDOW_RANK[b.kind] ?? 9))[0];
    const layover = layovers.find((l) => l.from < end && l.to > start);
    const span = rotationSpans.find((x) => key >= x.first && key <= x.last);
    const unknownCodes = (snapshot.unknownEvents ?? []).filter((u) => u.start < end && u.end > start).map((u) => u.code);
    const day = {
      date: key, start, end, isToday: key === todayKey, status: 'unknown', confidence: 'unknown', provenance: 'none',
      evidence: null, label: null, sectors: touching, duties: dayDuties, window: window ?? null, layover: layover ?? null,
      rotationId: span?.r.id ?? null,
      rotationPos: !span ? null : span.first === span.last ? 'single' : key === span.first ? 'start' : key === span.last ? 'end' : 'middle',
      rotationOpenStart: Boolean(span?.r.openStart && key === span.first),
      rotationOpenEnd: Boolean(span && !span.r.closed && key === span.last),
      // Unrecognised roster codes on this day (v2), whatever else the day is.
      unknownCodes,
    };

    if (dayDuties.length) {
      const departing = touching.filter((s) => s.dep >= start && s.dep < end);
      const pool = departing.length ? departing : touching.length ? touching : dayDuties[0].sectors;
      // Label: the day's outstation when there is one (an out-and-back shows its turnaround),
      // otherwise the last destination (e.g. the return to base).
      const away = pool.find((s) => !profile.homeBases.includes(s.destination));
      const fromHistory = dayDuties.every((d) => d.provenance === 'history');
      Object.assign(day, { status: 'flight', confidence: 'confirmed', provenance: fromHistory ? 'history' : 'source', label: (away ?? pool.at(-1)).destination });
    } else if (window && !(window.kind === 'off' && layover && !window.subtype)) {
      // An explicitly coded rest day (v2: off/free/leave/protected) is a source fact and outranks an
      // inferred layover; a generic off window during an inferred layover keeps the layover.
      Object.assign(day, { status: window.kind, confidence: 'confirmed', provenance: 'source', label: window.label ?? null });
      if (window.kind === 'off' && window.subtype) Object.assign(day, { offSubtype: window.subtype, protected: window.protected === true });
    } else if (layover) {
      Object.assign(day, { status: 'layover', confidence: 'inferred', provenance: 'derived', label: layover.airport });
      // A source-stated off day while away stays attached (shown in the day detail).
      // The source may also count the day as a (non-flight) duty day: keep that evidence visible.
      if (!free.has(key) && snapshot.offCoverageEnd && diffDays(key, snapshot.offCoverageEnd) >= 0) day.evidence = 'duty-unspecified';
    } else if (snapshot.unknownEvents?.some((u) => u.start < end && u.end > start)) {
      const u = snapshot.unknownEvents.find((x) => x.start < end && x.end > start);
      Object.assign(day, { evidence: 'unknown-code', label: u.code, sourceCode: u.code, sourceTitle: u.title });
    } else if (snapshot.dayStates && snapshot.dayStates[key]) {
      // v2 coverage: an empty day is never OFF, and an unpublished day is not "no flight".
      day.evidence = snapshot.dayStates[key] === 'unpublished' ? 'not-published' : snapshot.dayStates[key] === 'empty' ? 'nothing-rostered' : 'duty-unspecified';
    } else if (snapshot.dayStates && snapshot.coverageEnd && key > snapshot.coverageEnd) {
      day.evidence = 'outside-window';
    } else if (snapshot.capabilities.explicitOff && free.has(key)) {
      Object.assign(day, { status: 'off', confidence: 'confirmed', provenance: 'source' });
    } else if (coverageStartKey && key < coverageStartKey) {
      day.evidence = 'before-source';
    } else if (free.has(key)) {
      day.evidence = 'no-duty-reported';
    } else if (snapshot.offCoverageEnd && key <= snapshot.offCoverageEnd) {
      day.evidence = 'duty-unspecified';
    } else if (snapshot.flightCoverageEnd && key <= snapshot.flightCoverageEnd) {
      day.evidence = 'no-flight-listed';
    } else {
      day.evidence = 'outside-window';
    }
    days.push(day);
  }
  return days;
}

export function buildRoster(snapshot, profile, now) {
  const duties = buildDuties(snapshot.sectors, profile);
  const { rotations, warnings } = buildRotations(duties, profile, snapshot.windows);
  const days = buildDays(snapshot, { duties, rotations }, profile, now);
  return { duties, rotations, days, warnings: [...snapshot.warnings, ...warnings] };
}
