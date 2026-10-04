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
const FIXED_TZ = { EAST: 'Europe/Athens', WEST: 'America/New_York' };

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

let seq = 0;
function sector(n, origin, destination, dep, blockMin, tzOf, pickup = null) {
  const flightNumber = `SAMPLE ${String(n).padStart(2, '0')}`;
  return {
    id: `sample-${n}-${dep}-${seq++}`, flightNumber, origin, destination, dep, arr: dep + blockMin * M, blockMin,
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
      offDay(16), offDay(17),
      { kind: 'standby', start: day(12, 5, 0), end: day(12, 17, 0), label: 'SB' },
      { kind: 'standby', start: day(13, 5, 0), end: day(13, 17, 0), label: 'SB' },
      { kind: 'reserve', start: day(14, 8, 0), end: day(14, 20, 0), label: 'RE' },
      { kind: 'reserve', start: day(15, 8, 0), end: day(15, 20, 0), label: 'RE' },
    ],
  };
}

/** @returns {import('../model/types.js').RosterSnapshot} */
export function sampleSnapshot(state, tone, now, profile) {
  const tz = profile.homeTz;
  const awayTz = AWAY_TZ[tone] ?? AWAY_TZ.stone;
  const tzOf = (code) => (code === SAMPLE_HOME ? tz : FIXED_TZ[code] ?? awayTz);
  const today = localDateKey(now, tz);
  const at = (dayOffset, hh, mm = 0) => startOfLocalDay(addDays(today, dayOffset), tz) + hh * H + mm * M;
  const offDay = (d) => ({ kind: 'off', start: at(d, 0), end: at(d + 1, 0), label: 'OFF' });
  const month = mixedMonth(at, offDay, tzOf);
  const snapshot_ = (parts) => snapshot(now, parts, month, tz);

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
