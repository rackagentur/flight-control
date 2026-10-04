// Review samples: SYNTHETIC normalized snapshots, one per operational state, built around the
// current time. Used only in ?review mode. Every identifier is deliberately fictional so a
// sample can never be mistaken for a real roster: places are HOME and AWAY, flights are
// SAMPLE 01…, and the review profile has HOME as its only base.

import { addDays, localDateKey, startOfLocalDay } from '../lib/time.js';

const H = 3600000;
const M = 60000;

export const SAMPLE_HOME = 'HOME';
export const SAMPLE_AWAY = 'AWAY';

/** Zone used for AWAY per layover tone (keeps the clock arithmetic realistic, the place fictional). */
const AWAY_TZ = { ocean: 'America/Santo_Domingo', olive: 'Europe/Athens', sand: 'Asia/Dubai', stone: 'America/Toronto' };

export const SAMPLE_CAPABILITIES = Object.freeze({
  sectors: true, pickup: true, offDaysByAbsence: false, explicitOff: true,
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

function snapshot(now, { sectors = [], windows = [], offBlocks = [] }) {
  return {
    source: { id: 'sample', label: 'Sample data · not your roster', kind: 'sample', fetchedAt: now },
    capabilities: SAMPLE_CAPABILITIES,
    sectors, coverageStart: now - 3 * 86400000, windows, offBlocks,
    offCoverageEnd: null,
    dutyBlock: null, stats: null, map: null, achievements: [], warnings: [],
  };
}

/** @returns {import('../model/types.js').RosterSnapshot} */
export function sampleSnapshot(state, tone, now, profile) {
  const tz = profile.homeTz;
  const awayTz = AWAY_TZ[tone] ?? AWAY_TZ.stone;
  const tzOf = (code) => (code === SAMPLE_HOME ? tz : awayTz);
  const today = localDateKey(now, tz);
  const at = (dayOffset, hh, mm = 0) => startOfLocalDay(addDays(today, dayOffset), tz) + hh * H + mm * M;
  const offDay = (d) => ({ kind: 'off', start: at(d, 0), end: at(d + 1, 0), label: 'OFF' });

  switch (state) {
    case 'off':
      return snapshot(now, {
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
      return snapshot(now, {
        sectors: [
          sector(11, SAMPLE_HOME, SAMPLE_AWAY, dep, 135, tzOf, now + 25 * M),
          sector(12, SAMPLE_AWAY, SAMPLE_HOME, dep + 190 * M, 140, tzOf),
        ],
        windows: [offDay(1)],
      });
    }
    case 'standby':
    case 'reserve':
      return snapshot(now, {
        windows: [{ kind: state, start: now - 3 * H, end: now + 6 * H + 40 * M, label: state === 'standby' ? 'SB' : 'RE' }, offDay(1)],
        sectors: [sector(21, SAMPLE_HOME, SAMPLE_AWAY, at(2, 10, 5), 370, tzOf, at(2, 7, 50))],
      });
    case 'layover':
      return snapshot(now, {
        sectors: [
          sector(31, SAMPLE_HOME, SAMPLE_AWAY, now - 20 * H, 600, tzOf, now - 22 * H),
          sector(32, SAMPLE_AWAY, SAMPLE_HOME, now + 26 * H, 560, tzOf),
        ],
        windows: [offDay(3)],
      });
    default:
      return snapshot(now, {});
  }
}
