// User profile: every crew-specific assumption that v5 hardcoded lives here instead.
// Defaults match the current power user's setup; all values are user-configurable later.

import { store } from '../store.js';
import { isValidTimeZone } from '../lib/time.js';

export const DEFAULT_PROFILE = Object.freeze({
  name: '',
  homeTz: 'Europe/Berlin',
  base: 'FRA',
  // Operational crew base(s): rotations start and end here. Only the crew base, never a
  // convenience list. (v5's HOME_BASES was a "no hotel needed" list: see noHotelAirports.)
  homeBases: Object.freeze(['FRA']),
  // Airports where hotel suggestions are suppressed (v5 HOME_BASES behaviour). Display only:
  // never used for rotations, layovers or state.
  noHotelAirports: Object.freeze(['FRA', 'CGN', 'DUS', 'MUC', 'HAM', 'BER']),
  wakeupOffsetMin: 60,          // v5: wake-up = pickup − 60 min
  referenceTzRow: true,         // show home-base time for sectors outside the home zone
  alarmShortcutName: 'AddAlarm',
  hotelListUrl: '',
  kmPerBlockHour: 850,
  airlineAdapter: 'condor',
});

const IATA = /^[A-Z]{3}$/;

/** Merges stored values over defaults, discarding anything invalid. */
export function normalizeProfile(input = {}) {
  const p = { ...DEFAULT_PROFILE };
  if (typeof input.name === 'string') p.name = input.name.slice(0, 40);
  if (isValidTimeZone(input.homeTz)) p.homeTz = input.homeTz;
  // Base and crew bases resolve together; defaults never leak into a configured profile.
  const base = IATA.test(input.base ?? '') ? input.base : null;
  const bases = Array.isArray(input.homeBases) ? [...new Set(input.homeBases.filter((code) => IATA.test(code)))] : [];
  if (base && bases.length) { p.base = base; p.homeBases = Object.freeze(bases.includes(base) ? bases : [base, ...bases]); }
  else if (base) { p.base = base; p.homeBases = Object.freeze([base]); }
  else if (bases.length) { p.base = bases[0]; p.homeBases = Object.freeze(bases); }
  if (Array.isArray(input.noHotelAirports)) {
    p.noHotelAirports = Object.freeze([...new Set(input.noHotelAirports.filter((code) => IATA.test(code)))]);
  }
  if (Number.isInteger(input.wakeupOffsetMin) && input.wakeupOffsetMin >= 0 && input.wakeupOffsetMin <= 240) {
    p.wakeupOffsetMin = input.wakeupOffsetMin;
  }
  if (typeof input.referenceTzRow === 'boolean') p.referenceTzRow = input.referenceTzRow;
  if (typeof input.alarmShortcutName === 'string' && input.alarmShortcutName.trim()) p.alarmShortcutName = input.alarmShortcutName.trim().slice(0, 60);
  if (typeof input.hotelListUrl === 'string' && /^https:\/\//.test(input.hotelListUrl)) p.hotelListUrl = input.hotelListUrl;
  if (Number.isFinite(input.kmPerBlockHour) && input.kmPerBlockHour > 0) p.kmPerBlockHour = input.kmPerBlockHour;
  return Object.freeze(p);
}

export function loadProfile() {
  return normalizeProfile(store.getJSON('profile', {}) ?? {});
}

export function saveProfile(partial) {
  const next = normalizeProfile({ ...loadProfile(), ...partial });
  store.setJSON('profile', next);
  return next;
}

export function isHomeBase(profile, iata) {
  return profile.homeBases.includes(iata);
}
