// Operational state engine. Approved rules (docs/PLAN.md §B, DATA-GAPS.md):
//   - SB explicitly present → STANDBY; RE explicitly present → RESERVE
//   - absence of a flight alone never means OFF; OFF needs a source that states it
//   - LAYOVER only from strong itinerary evidence, always confidence 'inferred', provenance 'derived'
//   - insufficient evidence → UNKNOWN, with the reasons that were considered
// First matching rule wins; every result explains itself in `reasons`.

import { localDateKey, startOfLocalDay, addDays } from '../lib/time.js';

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

  // 3. Source-stated standby / reserve / off windows.
  const window = snapshot.windows.find((w) => w.start <= now && now < w.end);
  if (window && (window.kind === 'standby' || window.kind === 'reserve')) {
    return base({
      status: window.kind, confidence: 'confirmed', provenance: 'source', phase: 'window', window, nextEvent,
      duty: upcomingDuty, reasons: [`The roster lists ${window.kind} until the window ends.`],
    });
  }

  // 4. Layover: strong itinerary evidence only.
  const layover = rotations.flatMap((r) => r.layovers).find((l) => l.from <= now && now < l.to);
  if (layover) {
    const todayKey = localDateKey(now, tz);
    const listedFree = snapshot.offBlocks.some((b) => todayKey >= b.start && todayKey <= addDays(b.start, b.days - 1));
    const listedDuty = !listedFree && snapshot.offCoverageEnd !== null && todayKey <= snapshot.offCoverageEnd;
    return base({
      status: 'layover', confidence: 'inferred', provenance: 'derived', phase: 'layover', location: layover.airport,
      layover, duty: upcomingDuty, nextEvent,
      reasons: [
        `Last flight arrived ${layover.airport}; the next departs ${layover.airport}. Derived, not a roster entry.`,
        ...(listedDuty ? ['The roster also lists a non-flight duty today (standby, reserve or ground duty) without details.'] : []),
      ],
    });
  }

  // 5. Post-duty on the same day (back at base): still the flight day, duty complete.
  const finishedToday = duties.filter((d) => d.end <= now && d.end >= todayStart).at(-1);
  if (finishedToday && home.has(finishedToday.sectors.at(-1).destination)) {
    return base({
      status: 'flight', confidence: 'confirmed', provenance: finishedToday.provenance, phase: 'post-duty',
      location: finishedToday.sectors.at(-1).destination, duty: finishedToday, nextDuty: upcomingDuty, nextEvent,
      reasons: ['Today’s duty is complete.'],
    });
  }

  // 6. OFF only when the source states it.
  if (window && window.kind === 'off') {
    return base({ status: 'off', confidence: 'confirmed', provenance: 'source', phase: 'off', window, duty: upcomingDuty, nextEvent, reasons: ['The roster lists today as off.'] });
  }

  // 7. Everything else is UNKNOWN, with the evidence that was considered.
  const reasons = [];
  const nextDeparture = upcomingDuty?.sectors[0];
  if (nextDeparture && !home.has(nextDeparture.origin) && nextDeparture.dep - now < 7 * 24 * HOUR) {
    reasons.push(`The next departure is from ${nextDeparture.origin}, but the flight there is not visible, so a layover is not assumed.`);
  }
  const todayFree = snapshot.offBlocks.some((b) => {
    const startKey = b.start;
    const endKey = addDays(b.start, b.days - 1);
    const key = localDateKey(now, tz);
    return key >= startKey && key <= endKey;
  });
  const todayKey = localDateKey(now, tz);
  const todayBusyUnspecified = !todayFree && snapshot.offCoverageEnd !== null && todayKey <= snapshot.offCoverageEnd
    && !duties.some((d) => d.sectors.some((s) => s.dep < tomorrowStart && s.arr > todayStart));
  if (todayBusyUnspecified) {
    reasons.unshift('The roster counts today as a duty day without a flight (standby, reserve or ground duty), but the source does not say which, or when.');
  }
  if (todayFree) {
    reasons.push(snapshot.capabilities.explicitOff
      ? 'The roster lists no duty today.'
      : 'The roster reports no flight, standby or reserve starting today. That is not proof of a day off, so OFF is not shown.');
  } else if (!reasons.length) {
    reasons.push(now < tomorrowStart && !upcomingDuty
      ? 'No upcoming duties are visible in the roster source.'
      : 'The roster source does not describe today in enough detail.');
  }
  const phase = todayFree ? 'no-duty-reported' : todayBusyUnspecified ? 'duty-unspecified' : 'insufficient-evidence';
  return base({ phase, duty: upcomingDuty, nextEvent, reasons });
}
