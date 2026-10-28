// Condor crew presentation (Crew Intelligence Phase 1c, Stage A). Pure: no imports, no I/O.
// Turns validated `crew` members (src/sources/crew-v2.js) into display groups and names. The only
// place that knows Condor rank codes on the frontend. Meanings of rank codes are NOT inferred: a code
// is grouped and labelled only when its meaning is listed in CONDOR_CREW_RANKS, which holds owner-
// verified mappings only. Everything else is shown in the neutral `crew` group with the raw code.
// Names are shown exactly as spelled by the roster (never re-cased); only the initials are upper-cased.

/**
 * Rank codes the backend crew-list parser recognises (backend/apps-script/CondorAdapterV2.gs crewRanks).
 * Codes only: their meanings are NOT verified and must not be derived from this list.
 * @type {ReadonlyArray<string>}
 */
export const CONDOR_CREW_RANK_CODES = Object.freeze(['CP', 'CPT', 'FO', 'SFO', 'SO', 'PU', 'ST', 'SEN', 'FA', 'CA', 'CM', 'FE', 'IP', 'TRI', 'TRE']);

/**
 * Owner-verified rank mappings: code -> { group: 'cockpit'|'cabin', label }.
 * EMPTY on purpose: no mapping has been confirmed by the owner yet (decision D7 pending). Entries are
 * added only after explicit owner confirmation; until then every code uses the neutral fallback.
 * @type {Readonly<Record<string, {group:'cockpit'|'cabin', label:string}>>}
 */
export const CONDOR_CREW_RANKS = Object.freeze({});

const GROUP_ORDER = Object.freeze(['cockpit', 'cabin', 'crew']);
const VERIFIED_GROUPS = new Set(['cockpit', 'cabin']);
const HAS_LETTER = /\p{L}/u;
const ROUTE = /^([A-Z]{3})-([A-Z]{3})$/;

/** A name part as received (trimmed), or null when missing or empty. Never re-cased. */
function namePart(part) {
  if (typeof part !== 'string') return null;
  const trimmed = part.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * "Given Family" exactly as received: spelling, case, hyphens, apostrophes (' and ’), periods and inner
 * spaces are preserved; each part is trimmed, the two are joined by one space, a missing part is omitted.
 * @param {string|null} given
 * @param {string|null} family
 * @returns {string|null} null when both parts are missing
 */
export function formatCrewName(given, family) {
  const parts = [namePart(given), namePart(family)].filter((p) => p !== null);
  return parts.length ? parts.join(' ') : null;
}

function firstLetter(part) {
  const p = namePart(part);
  if (p === null) return '';
  const m = p.match(HAS_LETTER);
  if (!m) return '';
  const upper = m[0].toLocaleUpperCase('de');
  // One letter stays one letter: when upper-casing expands it (ß -> SS), the original letter is kept.
  return [...upper].length === 1 ? upper : m[0];
}

/**
 * Initials: first letter of the given name, then of the family name, upper-case (a letter whose upper case
 * is longer, such as ß, is kept as is); a missing part is omitted.
 * @param {string|null} given
 * @param {string|null} family
 * @returns {string}
 */
export function crewInitials(given, family) {
  return firstLetter(given) + firstLetter(family);
}

/**
 * 'FRA-PMI' -> 'FRA–PMI' (en dash); anything that is not two IATA codes -> null.
 * @param {string} route
 * @returns {string|null}
 */
export function formatCrewRoute(route) {
  const m = typeof route === 'string' ? route.match(ROUTE) : null;
  return m ? `${m[1]}–${m[2]}` : null;
}

function rankOf(code, ranks) {
  if (typeof code !== 'string') return { group: 'crew', rank: { code: null, label: null, verified: false } };
  const entry = ranks && Object.prototype.hasOwnProperty.call(ranks, code) ? ranks[code] : null;
  if (entry && VERIFIED_GROUPS.has(entry.group) && typeof entry.label === 'string' && entry.label !== '') {
    return { group: entry.group, rank: { code, label: entry.label, verified: true } };
  }
  // Unknown or unverified: neutral group, the raw code as given (not interpreted).
  return { group: 'crew', rank: { code, label: code, verified: false } };
}

/**
 * Display groups for validated crew members, in backend order inside each group.
 * Groups: cockpit, cabin (verified ranks only), crew (neutral fallback); empty groups are omitted.
 * Entries without any name (unreadable crew line) are not presented, only counted.
 * @param {ReadonlyArray<object>} members validated `crew` members
 * @param {{ranks?: Readonly<Record<string, {group:string, label:string}>>}} [options]
 * @returns {{groups: Array<{id:'cockpit'|'cabin'|'crew', members: object[]}>, unreadable: number}}
 */
export function presentCrew(members, { ranks = CONDOR_CREW_RANKS } = {}) {
  const buckets = { cockpit: [], cabin: [], crew: [] };
  let unreadable = 0;
  for (const m of Array.isArray(members) ? members : []) {
    if (!m || typeof m !== 'object') { unreadable += 1; continue; }
    const family = typeof m.family === 'string' ? m.family : null;
    const given = typeof m.given === 'string' ? m.given : null;
    if (family === null && given === null) { unreadable += 1; continue; }
    const { group, rank } = rankOf(m.rank, ranks);
    buckets[group].push({
      name: formatCrewName(given, family),
      initials: crewInitials(given, family),
      rank,
      match: m.match,
      count: m.count ?? null,
      last: m.last ? { date: m.last.date, flightNumber: m.last.flightNumber, route: m.last.route } : null,
      recordedMatch: typeof m.recordedMatch === 'boolean' ? m.recordedMatch : null,
      asOfRecorded: Number.isInteger(m.asOfRecorded) ? m.asOfRecorded : null,
    });
  }
  return {
    groups: GROUP_ORDER.filter((id) => buckets[id].length).map((id) => ({ id, members: buckets[id] })),
    unreadable,
  };
}
