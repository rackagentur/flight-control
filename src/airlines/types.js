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
 * Every field below is REQUIRED: Today, Calendar and the state engine read them unconditionally
 * (tests/airlines.test.js enforces this for every pack and the generic fallback).
 * @property {{off: OffSubtypeLabel, free: OffSubtypeLabel, leave: OffSubtypeLabel, ort: OffSubtypeLabel}} offSubtype  labels for the free-family day subtypes, by contract id (short and name required)
 * @property {string} protectedLegend   calendar key text for the protected free day
 * @property {string} protectedEyebrow  day detail heading for a protected free day stated by the roster
 * @property {string} protectedReason   state-engine reason for a protected free day
 * @property {UnassignedTerm} unassigned  wording for a day the roster lists with no duty assigned (not a day off)
 */

/**
 * @typedef {Object} UnassignedTerm
 * @property {string} short    full uppercase word (Today's status title)
 * @property {string} cell     compact code for a calendar cell, the calendar key sample and the 7-day strip (fits a 7-column cell at the normal code size)
 * @property {string} name     plain-language name (Today kicker, day detail)
 * @property {string} legend   calendar key text
 * @property {string} reason   state-engine reason
 * @property {string} summary  month-summary label ("<n> <summary>")
 */

/**
 * One raw roster code of an airline and the canonical Flight Control concept it is established
 * to mean. Raw codes stay separate from canonical concepts (contract v2) and from user-facing
 * terminology.
 * @typedef {Object} RosterCodeDefinition
 * @property {string} id                 stable key inside the pack ('checkin', 'pickup', 'standby-sb', 'reserve-re', 'day-off', 'day-leave', 'day-ort', 'day-unassigned', ...)
 * @property {{exact:string}|{pattern:string}} match   raw roster title: exact code, or an anchored regex SOURCE string
 * @property {'checkin'|'pickup'|'standby'|'reserve'|'off'|'unassigned'} kind   canonical Flight Control concept (contract v2)
 * @property {'off'|'free'|'leave'|'ort'|null} [subtype]
 * @property {boolean} [protected]
 * @property {string} source             where the mapping is established, e.g. 'docs/CONTRACT-V2.md source inventory (2026-10-04)'
 */

/**
 * @typedef {Object} AirlineProfile
 * @property {string} id            registry id (matches /^[a-z0-9-]{1,32}$/)
 * @property {string} name          display name
 * @property {string|null} iata     two-letter airline code, null when not airline-specific
 * @property {Terminology} terminology
 * @property {ReadonlyArray<string>} [flightDesignators]  optional; two-character airline designators accepted in feed flight titles (packs with a roster feed); also the carrier filter for schedule departures (absent = no filter)
 * @property {ReadonlyArray<RosterCodeDefinition>} [rosterCodes]  raw roster codes in match order (packs with a roster feed)
 */

export {};
