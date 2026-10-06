// Airline profile model (JSDoc only; no runtime code).
// Core (model/ui) never hard-codes airline terms; each airline pack supplies its own wording.
// Contract subtype ids ('off' | 'free' | 'leave' | 'ort') are data ids and stay airline-neutral;
// only the human-facing labels below belong to a pack.

/**
 * @typedef {Object} OffSubtypeLabel
 * @property {string} short    cell code (calendar, key)
 * @property {string} name     plain-language name
 * @property {string} [detail] optional qualifier appended in parentheses to the calendar description
 */

/**
 * @typedef {Object} Terminology
 * @property {Object<string, OffSubtypeLabel>} offSubtype  labels for the free-family day subtypes, by contract id
 * @property {string} protectedLegend   calendar key text for the protected free day
 * @property {string} protectedEyebrow  day detail heading for a protected free day stated by the roster
 * @property {string} protectedReason   state-engine reason for a protected free day
 */

/**
 * @typedef {Object} AirlineProfile
 * @property {string} id            registry id (matches /^[a-z0-9-]{1,32}$/)
 * @property {string} name          display name
 * @property {string|null} iata     two-letter airline code, null when not airline-specific
 * @property {Terminology} terminology
 */

export {};
