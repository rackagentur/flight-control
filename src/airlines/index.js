// Airline registry. Core code reads airline wording (and, later, rules) only through here.
// Unknown or missing ids fall back to the neutral generic profile.

import { GENERIC } from './generic.js';
import { CONDOR } from './condor/profile.js';

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

const REGISTRY = Object.freeze({
  [CONDOR.id]: deepFreeze(CONDOR),
});
const FALLBACK = deepFreeze(GENERIC);

/** Ids of the registered airline packs (the generic fallback is not a registered pack). */
export const AIRLINE_IDS = Object.freeze(Object.keys(REGISTRY));

/** @param {string|null|undefined} id @returns {import('./types.js').AirlineProfile} */
export function getAirline(id) {
  return Object.hasOwn(REGISTRY, id ?? '') ? REGISTRY[id] : FALLBACK;
}

/** The airline pack for a normalized user profile. */
export function airlineOf(profile) {
  return getAirline(profile?.airlineId);
}
