// Condor roster codes: the ONE authoritative table of raw feed titles and the canonical Flight
// Control concept each one is established to mean. Pure data (no imports): the Apps Script copy
// backend/apps-script/CondorCodesV2.gs is generated from it (node scripts/gen-condor-codes-gs.mjs).
// Three things stay separate: the RAW code (here), the CANONICAL concept (kind/subtype/protected,
// contract v2) and USER-FACING wording (terminology in profile.js). Nothing here is inferred;
// a code that is not listed is 'unknown' and stays visible as such.

const SOURCE = 'docs/CONTRACT-V2.md source inventory (2026-10-04)';
const SOURCE_STRICHTAG = 'Owner statement + live-feed trace 2026-10-06 ("-" 30×, "--" 0×); Condor MTV Fibel p.10 (Strichtage)';
const SOURCE_STANDBY_SYMBOL = 'Condor MTV Fibel (Verdi) p.17, Symbol Dienstplan';

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
  // A single dash is the Strichtag: an unassigned day, NOT a free day. '--' never occurs in the feed (unknown).
  { id: 'day-unassigned', match: { exact: '-' }, kind: 'unassigned', source: SOURCE_STRICHTAG },
  { id: 'day-leave', match: { exact: 'U' }, kind: 'off', subtype: 'leave', source: SOURCE },
  { id: 'day-ort', match: { exact: 'ORT' }, kind: 'off', subtype: 'ort', protected: true, source: SOURCE },
  // Phase 2: approved by exact symbol only.
  // Roster symbols of further standby types (the agreement names SBY, SBYHOT, ... are not roster symbols).
  { id: 'standby-sb90s', match: { exact: 'SB90S' }, kind: 'standby', source: SOURCE_STANDBY_SYMBOL },
  { id: 'standby-sb90-i', match: { exact: 'SB90_I' }, kind: 'standby', source: SOURCE_STANDBY_SYMBOL },
  { id: 'standby-sbh30', match: { exact: 'SBH30' }, kind: 'standby', source: SOURCE_STANDBY_SYMBOL },
  { id: 'standby-sbaus', match: { exact: 'SBAUS' }, kind: 'standby', source: SOURCE_STANDBY_SYMBOL },
  { id: 'standby-sb90ko', match: { exact: 'SB90KO' }, kind: 'standby', source: SOURCE_STANDBY_SYMBOL },
].map((d) => Object.freeze({ ...d, match: Object.freeze(d.match) })));

/** Airline designators accepted in feed flight titles ("DE1234 FRA-PMI"). */
export const CONDOR_FLIGHT_DESIGNATORS = Object.freeze(['DE']);
