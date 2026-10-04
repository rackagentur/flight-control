// Review samples: SYNTHETIC normalized snapshots, one per operational state, built around the
// current time. Used only in ?review mode. Every identifier is deliberately fictional so a
// sample can never be mistaken for a real roster: places are HOME and AWAY, flights are
// SAMPLE 01…, and the review profile has HOME as its only base. Every scenario sits on top of a
// fictional "mixed month" (long-haul rotation, day trip, confirmed past layover, standby/reserve
// week, explicit OFF days, unknown days) so the Calendar can be reviewed too.

import { addDays, localDateKey, startOfLocalDay } from '../lib/time.js';

const H = 3600000;
const M = 60000;

export const SAMPLE_HOME = 'HOME';
export const SAMPLE_AWAY = 'AWAY';
const FIXED_TZ = { EAST: 'Europe/Athens', WEST: 'America/New_York', SOUTH: 'Europe/Lisbon' };

/** Zone used for AWAY per layover tone (keeps the clock arithmetic realistic, the place fictional). */
const AWAY_TZ = { ocean: 'America/Santo_Domingo', olive: 'Europe/Athens', sand: 'Asia/Dubai', stone: 'America/Toronto' };

export const SAMPLE_CAPABILITIES = Object.freeze({
  // OFF only where an explicit off window says so; other free days stay "no duty reported".
  sectors: true, pickup: true, offDaysByAbsence: true, explicitOff: false,
  standbyWindows: true, reserveWindows: true, pastSectors: true, reportTime: false,
  hotels: false, history: false, actions: Object.freeze([]),
});

/** The review profile: same home time zone as the user, fictional base. */
export function sampleProfile(profile) {
  return Object.freeze({ ...profile, base: SAMPLE_HOME, homeBases: Object.freeze([SAMPLE_HOME]), noHotelAirports: Object.freeze([]), hotelListUrl: '' });
}

function sector(n, origin, destination, dep, blockMin, tzOf, pickup = null) {
  const flightNumber = `SAMPLE ${String(n).padStart(2, '0')}`;
  return {
    // Stable across rebuilds (each sample flight number is unique), so a selected sample sector
    // survives a reload even when its scenario times move with the clock.
    id: `sample-${n}`, flightNumber, origin, destination, dep, arr: dep + blockMin * M, blockMin,
    originTz: tzOf(origin), destTz: tzOf(destination), pickup, provenance: 'source', legacy: null,
  };
}

// Sample coverage: free-day list −14…+20 (with +18/+19 listed as duty), flights to +26,
// nothing beyond (no data). This makes Duty, Unknown and No data visible in the month.
const SAMPLE_DUTY_DAYS = new Set([18, 19]);

function snapshot(now, { sectors = [], windows = [], offBlocks = [] }, month, tz) {
  const today = localDateKey(now, tz);
  const free = [];
  for (let d = -14; d <= 20; d += 1) if (!SAMPLE_DUTY_DAYS.has(d)) free.push({ start: addDays(today, d), days: 1 });
  return {
    source: { id: 'sample', label: 'Sample data · not your roster', kind: 'sample', fetchedAt: now },
    capabilities: SAMPLE_CAPABILITIES,
    sectors: [...month.sectors, ...sectors].sort((a, b) => a.dep - b.dep),
    coverageStart: startOfLocalDay(addDays(today, -14), tz),
    windows: [...month.windows, ...windows],
    offBlocks: [...free, ...offBlocks],
    offCoverageEnd: addDays(today, 20),
    flightCoverageEnd: addDays(today, 26),
    dutyBlock: null, stats: null, map: null, achievements: [], warnings: [],
  };
}

/**
 * The fictional background month, placed away from the state scenarios (which use the days
 * around today): offsets +4…+24.
 */
function mixedMonth(at, offDay, tzOf) {
  const day = (d, hh, mm = 0) => at(d, hh, mm);
  return {
    sectors: [
      // Rotation HOME → WEST → HOME with a source-stated (confirmed) layover window.
      sector(41, SAMPLE_HOME, 'WEST', day(21, 10, 0), 520, tzOf),
      sector(42, 'WEST', SAMPLE_HOME, day(23, 18, 0), 460, tzOf),
      // Long-haul: overnight outbound crossing midnight, inferred layover, overnight return.
      sector(51, SAMPLE_HOME, SAMPLE_AWAY, day(4, 22, 0), 600, tzOf, day(4, 19, 30)),
      sector(52, SAMPLE_AWAY, SAMPLE_HOME, day(7, 13, 0), 570, tzOf),
      // Day trip: out and back the same day.
      sector(61, SAMPLE_HOME, 'EAST', day(10, 6, 30), 150, tzOf, day(10, 4, 50)),
      sector(62, 'EAST', SAMPLE_HOME, day(10, 9, 50), 160, tzOf),
    ],
    windows: [
      { kind: 'layover', start: day(21, 18, 40), end: day(23, 18, 0), label: 'WEST' },
      // Rest family: an ordinary OFF day and an ORT (protected free day, contract v2), both stated.
      offDay(16), { ...offDay(17), subtype: 'ort', protected: true, label: 'ORT' },
      { kind: 'standby', start: day(12, 5, 0), end: day(12, 17, 0), label: 'SB' },
      { kind: 'standby', start: day(13, 5, 0), end: day(13, 17, 0), label: 'SB' },
      { kind: 'reserve', start: day(14, 8, 0), end: day(14, 20, 0), label: 'RE' },
      { kind: 'reserve', start: day(15, 8, 0), end: day(15, 20, 0), label: 'RE' },
    ],
  };
}

/** Flights review variants (layered over a state scenario). */
export const SAMPLE_VARIANTS = Object.freeze(['multi', 'incomplete', 'history']);

function applyVariant(snap, variant, { at, tzOf, now, tz }) {
  if (variant === 'multi') {
    // A four-sector short-haul duty: out and back twice, one pickup at the start.
    const multi = [
      sector(71, SAMPLE_HOME, 'EAST', at(2, 6, 10), 155, tzOf, at(2, 4, 40)),
      sector(72, 'EAST', SAMPLE_HOME, at(2, 9, 35), 165, tzOf),
      sector(73, SAMPLE_HOME, 'SOUTH', at(2, 13, 5), 140, tzOf),
      sector(74, 'SOUTH', SAMPLE_HOME, at(2, 16, 10), 135, tzOf),
    ];
    // It replaces the scenario's own flights of the next days, so it is the next rotation.
    return { ...snap, sectors: [...snap.sectors.filter((x) => x.dep < at(0, 0) || x.dep >= at(4, 0)), ...multi].sort((a, b) => a.dep - b.dep) };
  }
  if (variant === 'incomplete') {
    // The source shares only five flights; one airport has no known time zone, no pickup is
    // listed, and the long-haul return lies beyond the last listed flight.
    const listed = [
      sector(81, SAMPLE_HOME, 'NORTH', at(1, 7, 0), 95, tzOf),
      sector(82, 'NORTH', SAMPLE_HOME, at(1, 9, 40), 100, tzOf),
      sector(83, SAMPLE_HOME, 'EAST', at(2, 6, 30), 150, tzOf, at(2, 4, 50)),
      sector(84, 'EAST', SAMPLE_HOME, at(2, 9, 50), 160, tzOf),
      sector(85, SAMPLE_HOME, SAMPLE_AWAY, at(4, 22, 0), 600, tzOf),
    ];
    return {
      ...snap,
      sectors: listed,
      windows: snap.windows.filter((w) => w.kind !== 'layover'),
      flightCoverageEnd: localDateKey(listed.at(-1).dep, tz),
      flightListLimit: 5,
      warnings: [{ code: 'upcoming-truncated', message: 'The source lists only the next 5 flights; later days may be incomplete.' }],
    };
  }
  if (variant === 'history') {
    // Flown sectors: two still in the current sample source window, three remembered from
    // earlier syncs on this (sample) device. All fictional; nothing is stored.
    const flown = [
      sector(91, SAMPLE_HOME, 'EAST', at(-5, 6, 30), 150, tzOf, at(-5, 4, 50)),
      sector(92, 'EAST', SAMPLE_HOME, at(-5, 9, 50), 160, tzOf),
      ...[[-21, 'WEST', 520, 470, 2], [-48, SAMPLE_AWAY, 600, 570, 3], [-83, 'SOUTH', 140, 135, 0]].flatMap(([d, to, out, back, stay], i) => [
        { ...sector(93 + i * 2, SAMPLE_HOME, to, at(d, 9, 0), out, tzOf), provenance: 'history', seenAt: at(d - 2, 8) },
        { ...sector(94 + i * 2, to, SAMPLE_HOME, stay ? at(d + stay, 13, 0) : at(d, 9, 0) + (out + 50) * M, back, tzOf), provenance: 'history', seenAt: at(d - 2, 8) },
      ]),
    ];
    return { ...snap, sectors: [...flown, ...snap.sectors].sort((a, b) => a.dep - b.dep) };
  }
  return snap;
}

/**
 * Review-only weather: deterministic sample values for the fictional places, labelled as
 * samples. Never makes a network request. Real airports and unknown zones stay unavailable.
 */
export function sampleWeather(query) {
  if (!query || query.status !== 'unavailable' || query.reason !== 'no-coordinates' || !query.date) return query?.status === 'query' ? { status: 'unavailable', reason: 'review' } : query;
  const ahead = Math.round((Date.parse(`${query.date}T12:00:00Z`) - Date.parse(`${query.todayLocal}T12:00:00Z`)) / 86400000);
  if (ahead < 0) return { status: 'unavailable', reason: 'past' };
  if (ahead >= 10) return { status: 'later', availableFrom: null, date: query.date };
  const seed = [...`${query.iata}${query.date}`].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % 997, 7);
  const codes = [0, 1, 2, 3, 61, 80];
  const code = codes[seed % codes.length];
  const max = 14 + (seed % 15);
  return { status: 'ok', sample: true, date: query.date, max, min: max - 5 - (seed % 4), code, text: ['Clear', 'Mainly clear', 'Partly cloudy', 'Overcast', 'Rain', 'Rain showers'][codes.indexOf(code)], source: 'Sample' };
}

/** @returns {import('../model/types.js').RosterSnapshot} */
export function sampleSnapshot(state, tone, now, profile, variant = null) {
  const tz = profile.homeTz;
  const awayTz = AWAY_TZ[tone] ?? AWAY_TZ.stone;
  // NORTH is deliberately an airport without a known time zone (incomplete-data scenario).
  const tzOf = (code) => (code === SAMPLE_HOME ? tz : code === 'NORTH' ? null : FIXED_TZ[code] ?? awayTz);
  const today = localDateKey(now, tz);
  const at = (dayOffset, hh, mm = 0) => startOfLocalDay(addDays(today, dayOffset), tz) + hh * H + mm * M;
  const offDay = (d) => ({ kind: 'off', start: at(d, 0), end: at(d + 1, 0), label: 'OFF' });
  const month = mixedMonth(at, offDay, tzOf);
  const snapshot_ = (parts) => applyVariant(snapshot(now, parts, month, tz), variant, { at, tzOf, now, tz });

  switch (state) {
    case 'off':
      return snapshot_({
        windows: [offDay(0), offDay(3)],
        offBlocks: [{ start: today, days: 1 }],
        sectors: [
          sector(1, SAMPLE_HOME, SAMPLE_AWAY, at(1, 9, 40), 520, tzOf, at(1, 7, 25)),
          sector(2, SAMPLE_AWAY, SAMPLE_HOME, at(2, 12, 30), 450, tzOf),
        ],
      });
    case 'flight': {
      // On duty: wake-up done, pickup in 25 min, a two-sector day out and back.
      const dep = now + 2 * H + 15 * M;
      return snapshot_({
        sectors: [
          sector(11, SAMPLE_HOME, SAMPLE_AWAY, dep, 135, tzOf, now + 25 * M),
          sector(12, SAMPLE_AWAY, SAMPLE_HOME, dep + 190 * M, 140, tzOf),
        ],
        windows: [offDay(1)],
      });
    }
    case 'standby':
    case 'reserve':
      return snapshot_({
        windows: [{ kind: state, start: now - 3 * H, end: now + 6 * H + 40 * M, label: state === 'standby' ? 'SB' : 'RE' }, offDay(1)],
        sectors: [sector(21, SAMPLE_HOME, SAMPLE_AWAY, at(2, 10, 5), 370, tzOf, at(2, 7, 50))],
      });
    case 'layover':
      return snapshot_({
        sectors: [
          sector(31, SAMPLE_HOME, SAMPLE_AWAY, now - 20 * H, 600, tzOf, now - 22 * H),
          sector(32, SAMPLE_AWAY, SAMPLE_HOME, now + 26 * H, 560, tzOf),
        ],
        windows: [offDay(3)],
      });
    default:
      return snapshot_({});
  }
}
