// Operational state engine. Approved rules (docs/PLAN.md §B, DATA-GAPS.md):
//   - SB explicitly present → STANDBY; RE explicitly present → RESERVE
//   - absence of a flight alone never means OFF; OFF needs a source that states it
//   - LAYOVER only from strong itinerary evidence, always confidence 'inferred', provenance 'derived'
//   - insufficient evidence → UNKNOWN, with the reasons that were considered
// First matching rule wins; every result explains itself in `reasons`.

import { localDateKey, startOfLocalDay, addDays } from '../lib/time.js';
import { buildDays, WINDOW_RANK, MAX_INFERRED_LAYOVER_DAYS, layoverCalendarDays } from './roster.js';

const HOUR = 3600000;

/** Upcoming milestones of a duty, in time order. */
export function dutyMilestones(duty) {
  const out = [];
  if (duty.wakeup !== null) out.push({ kind: 'wakeup', at: duty.wakeup, label: 'Wake-up' });
  if (duty.pickup !== null) out.push({ kind: 'pickup', at: duty.pickup, label: 'Pickup' });
  if (duty.report !== null) out.push({ kind: 'report', at: duty.report, label: 'Briefing' });
  for (const s of duty.sectors) {
    out.push({ kind: 'departure', at: s.dep, label: `Departure ${s.flightNumber}`, sector: s });
    out.push({ kind: 'arrival', at: s.arr, label: `Arrival ${s.destination}`, sector: s });
  }
  return out;
}

function nextEventAfter(now, duties, windows) {
  const candidates = [
    ...duties.flatMap(dutyMilestones),
    // Standby/reserve boundaries are operational events; the end of a day off is not.
    ...windows.filter((w) => w.kind !== 'off').flatMap((w) => [
      { kind: `${w.kind}-start`, at: w.start, label: `${cap(w.kind)} begins` },
      { kind: `${w.kind}-end`, at: w.end, label: `${cap(w.kind)} ends` },
    ]),
  ].filter((m) => m.at > now).sort((a, b) => a.at - b.at);
  return candidates[0] ?? null;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function base(overrides) {
  return {
    status: 'unknown', confidence: 'unknown', provenance: 'none', phase: 'unknown',
    location: null, nextEvent: null, duty: null, nextDuty: null, layover: null, window: null, reasons: [],
    ...overrides,
  };
}

/**
 * @param {object|null} snapshot  RosterSnapshot (or null when no source is connected)
 * @param {{duties: object[], rotations: object[]}|null} roster
 * @param {object} profile
 * @param {number} now
 */
export function deriveState(snapshot, roster, profile, now) {
  if (!snapshot || !roster) {
    return base({ phase: 'no-source', reasons: ['No roster source is connected.'] });
  }
  const { duties, rotations } = roster;
  const home = new Set(profile.homeBases);
  const tz = profile.homeTz;
  const todayStart = startOfLocalDay(localDateKey(now, tz), tz);
  const tomorrowStart = startOfLocalDay(addDays(localDateKey(now, tz), 1), tz);
  const nextEvent = nextEventAfter(now, duties, snapshot.windows);
  const upcomingDuty = duties.find((d) => d.end > now) ?? null;

  // 1. Airborne: inside a sector's block time.
  for (const duty of duties) {
    const sector = duty.sectors.find((s) => s.dep <= now && now < s.arr);
    if (sector) {
      return base({
        status: 'flight', confidence: 'confirmed', provenance: sector.provenance === 'history' ? 'history' : 'source',
        phase: 'airborne', location: null, duty, nextEvent,
        reasons: [`${sector.flightNumber} ${sector.origin}→${sector.destination} is between departure and arrival.`],
      });
    }
  }

  // 2. On duty: from wake-up/pickup until the last arrival. Without a pickup, a departure from
  //    home makes the whole local departure day a flight day; at an outstation no duty start
  //    is invented (the layover, if proven, runs until departure).
  for (const duty of duties) {
    const first = duty.sectors[0];
    const originTz = first.originTz ?? tz;
    const dutyDayStart = startOfLocalDay(localDateKey(first.dep, originTz), originTz);
    const opens = home.has(first.origin)
      ? Math.min(dutyDayStart, duty.wakeup ?? Infinity, duty.pickup ?? Infinity)
      : (duty.wakeup ?? duty.pickup ?? null);
    if (opens !== null && now >= opens && now < duty.end) {
      const between = duty.sectors.some((s, i) => i > 0 && duty.sectors[i - 1].arr <= now && now < s.dep);
      return base({
        status: 'flight', confidence: 'confirmed', provenance: duty.provenance,
        phase: between ? 'turnaround' : 'pre-departure', location: between ? null : first.origin, duty, nextEvent,
        reasons: [`Duty ${first.flightNumber} departs ${first.origin} today.`],
      });
    }
  }

  // Today's day, from the SAME classifier the 7-day strip and Calendar use.
  const today = buildDays(snapshot, roster, profile, now, { count: 1 })[0];

  // 3. Source-stated standby / reserve / layover windows.
  // Same ranking as the day classifier: duty windows outrank a stated layover, then off.
  const window = snapshot.windows.filter((w) => w.start <= now && now < w.end)
    .sort((a, b) => (WINDOW_RANK[a.kind] ?? 9) - (WINDOW_RANK[b.kind] ?? 9))[0];
  if (window && (window.kind === 'standby' || window.kind === 'reserve')) {
    return base({
      status: window.kind, confidence: 'confirmed', provenance: 'source', phase: 'window', window, nextEvent,
      duty: upcomingDuty, reasons: [`The roster lists ${window.kind} until the window ends.`],
    });
  }
  if (window && window.kind === 'layover') {
    return base({
      status: 'layover', confidence: 'confirmed', provenance: 'source', phase: 'layover', location: window.label ?? null,
      window, duty: upcomingDuty, nextEvent, reasons: ['The roster lists this layover.'],
    });
  }

  // 4. Layover: strong itinerary evidence only.
  const layover = rotations.flatMap((r) => r.layovers).find((l) => l.from <= now && now < l.to);
  if (layover) {
    return base({
      status: 'layover', confidence: 'inferred', provenance: 'derived', phase: 'layover', location: layover.airport,
      layover, duty: upcomingDuty, nextEvent,
      reasons: [
        `Last flight arrived ${layover.airport}; the next departs ${layover.airport}. Derived, not a roster entry.`,
        ...(today.evidence === 'duty-unspecified' ? ['The roster also lists a non-flight duty today (standby, reserve or ground duty) without details.'] : []),
      ],
    });
  }

  // 5. Post-duty on the same day (back at base): still the flight day, duty complete.
  //    Uses today's duties from the shared classifier, so the day boundary is identical.
  const finishedToday = today.duties.filter((d) => d.end <= now).at(-1);
  if (finishedToday && home.has(finishedToday.sectors.at(-1).destination)) {
    return base({
      status: 'flight', confidence: 'confirmed', provenance: finishedToday.provenance, phase: 'post-duty',
      location: finishedToday.sectors.at(-1).destination, duty: finishedToday, nextDuty: upcomingDuty, nextEvent,
      reasons: ['Today’s duty is complete.'],
    });
  }

  // 6. A duty overlaps today (e.g. an evening departure from an outstation): a flight day.
  if (today.status === 'flight') {
    const duty = today.duties.find((d) => d.end > now) ?? today.duties.at(-1);
    return base({
      status: 'flight', confidence: 'confirmed', provenance: duty.provenance, phase: duty.end > now ? 'duty-today' : 'post-duty',
      location: duty.sectors[0].origin, duty, nextEvent, reasons: [`Duty ${duty.sectors[0].flightNumber} is rostered today.`],
    });
  }

  // 7. OFF only when the source states it (explicit window or explicit off day).
  if (today.status === 'off') {
    return base({ status: 'off', confidence: 'confirmed', provenance: 'source', phase: 'off', window: today.window, duty: upcomingDuty, nextEvent, reasons: ['The roster lists today as off.'] });
  }

  // 8. Everything else is UNKNOWN, explained with the same evidence the Calendar shows.
  const reasons = [];
  const evidenceReason = {
    'no-duty-reported': 'The roster reports no flight, standby or reserve starting today. That is not proof of a day off, so OFF is not shown.',
    'duty-unspecified': 'The roster counts today as a duty day without a flight (standby, reserve or ground duty), but the source does not say which, or when.',
    'no-flight-listed': 'No flight is listed today, but the source does not cover other duty types for this day.',
    'before-source': 'The roster source does not cover today.',
    'outside-window': 'The roster source does not cover today.',
  }[today.evidence];
  if (evidenceReason) reasons.push(evidenceReason);
  const nextDeparture = upcomingDuty?.sectors[0];
  const previous = duties.filter((d) => d.end <= now).at(-1);
  const lastArrival = previous?.sectors.at(-1);
  if (nextDeparture && lastArrival && lastArrival.destination === nextDeparture.origin && !home.has(nextDeparture.origin)
    && layoverCalendarDays(previous.end, nextDeparture.dep, lastArrival.destTz ?? tz) > MAX_INFERRED_LAYOVER_DAYS) {
    reasons.push(`More than ${MAX_INFERRED_LAYOVER_DAYS} days between arriving ${lastArrival.destination} and the next departure from there, so a layover is not inferred.`);
  } else if (nextDeparture && !home.has(nextDeparture.origin) && nextDeparture.dep - now < 7 * 24 * HOUR) {
    reasons.push(`The next departure is from ${nextDeparture.origin}, but the flight there is not visible, so a layover is not assumed.`);
  }
  if (!reasons.length) {
    reasons.push(now < tomorrowStart && !upcomingDuty
      ? 'No upcoming duties are visible in the roster source.'
      : 'The roster source does not describe today in enough detail.');
  }
  return base({ phase: today.evidence ?? 'insufficient-evidence', duty: upcomingDuty, nextEvent, reasons });
}
