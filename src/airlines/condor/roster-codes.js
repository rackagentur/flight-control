// Condor roster codes: the ONE authoritative table of raw feed titles and the canonical Flight
// Control concept each one is established to mean. Pure data (no imports): the Apps Script copy
// backend/apps-script/CondorCodesV2.gs is generated from it (node scripts/gen-condor-codes-gs.mjs).
// Three things stay separate: the RAW code (here), the CANONICAL concept (kind/subtype/protected,
// contract v2) and USER-FACING wording (terminology in profile.js). Nothing here is inferred;
// a code that is not listed is 'unknown' and stays visible as such.

const SOURCE = 'docs/CONTRACT-V2.md source inventory (2026-10-04)';

/**
 * Raw titles in match order (first match wins). `exact` compares the cleaned title as is;
 * `pattern` is an anchored regex source string tested against the cleaned title.
 * @type {ReadonlyArray<import('../types.js').RosterCodeDefinition>}
 */
export const CONDOR_ROSTER_CODES = Object.freeze([
  { id: 'checkin', match: { exact: 'C/I' }, kind: 'checkin', source: SOURCE },
  { id: 'pickup', match: { exact: 'P/U' }, kind: 'pickup', source: SOURCE },
  { id: 'standby-sb', match: { pattern: '^SB\\d{0,3}$' }, kind: 'standby', source: SOURCE },
  { id: 'reserve-re', match: { pattern: '^RE\\d{0,3}$' }, kind: 'reserve', source: SOURCE },
  { id: 'day-off', match: { exact: 'OFF' }, kind: 'off', subtype: 'off', source: SOURCE },
  { id: 'day-free', match: { exact: '-' }, kind: 'off', subtype: 'free', source: SOURCE },
  { id: 'day-leave', match: { exact: 'U' }, kind: 'off', subtype: 'leave', source: SOURCE },
  { id: 'day-ort', match: { exact: 'ORT' }, kind: 'off', subtype: 'ort', protected: true, source: SOURCE },
].map((d) => Object.freeze({ ...d, match: Object.freeze(d.match) })));

/** Airline designators accepted in feed flight titles ("DE1234 FRA-PMI"). */
export const CONDOR_FLIGHT_DESIGNATORS = Object.freeze(['DE']);
