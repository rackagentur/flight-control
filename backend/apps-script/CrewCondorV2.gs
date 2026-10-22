// ============================================================================
// FLIGHT CONTROL — CREW INTELLIGENCE: CONDOR CREW-LIST PARSER (Phase 1b, synthetic only)
// ============================================================================
// NOT DEPLOYED. Not part of the installed Apps Script project. The only place that knows the
// Condor crew-list layout inside a roster event description:
//   "<RANK>[digit] <employee-id> <FAMILY>, <GIVEN> (<BASE>)"   e.g. rank codes from
//   FCV2_CONDOR_CONFIG_.crewRanks; the employee id is 6 digits + 1 letter; the base is optional.
// The installed roster adapter (CondorAdapterV2.gs) is unchanged and still never returns crew data;
// this file reuses its configuration and classifier read-only (same Apps Script global scope).
//
// Output entries are { rank, id, family, given } or { parseFailed: true }; id is null when the line has
// no identifier. The id is needed only to compute keyed hashes in CrewCoreV2.gs and must never reach a
// response or a stored record. Nothing is logged; nothing thrown contains description text.
// Lines of the v5 sync enrichment ("CREW HISTORY", "Colleague …", "Original Notes:") do not start with
// a rank code and are ignored. All names start with fcv2Crew and end in "_".
// ============================================================================

const FCV2_CREW_NAME_ = "[\\p{L}][\\p{L} .'’-]{0,39}";

/**
 * Crew entries of one description, or null when it holds no crew-like line (no crew list).
 * A line that starts with a rank code but does not fit the layout is { parseFailed: true }.
 * Duplicate identifiers (the same person listed twice) are kept once.
 */
function fcv2CrewParseLines_(description, config) {
  const ranks = config.crewRanks.join('|');
  const opener = new RegExp('^(' + ranks + ')\\d?\\s+\\S', 'u');
  const full = new RegExp('^(' + ranks + ')\\d?\\s+(?:(\\d{6}[A-Z])\\s+)?(' + FCV2_CREW_NAME_ + '?)\\s*,\\s*(' + FCV2_CREW_NAME_ + '?)\\s*(?:\\(\\s*[A-Z]{3}\\s*\\))?$', 'u');
  const lines = String(description || '').split(/\r?\n/);
  const out = [];
  const seen = {};
  let any = false;
  lines.forEach(function (raw) {
    const line = raw.trim();
    if (line.length > 120 || !opener.test(line)) return;
    any = true;
    const m = line.match(full);
    if (!m || /\d/.test(m[3]) || /\d/.test(m[4])) { out.push({ parseFailed: true }); return; }
    const id = m[2] || null;
    if (id && seen[id]) return;
    if (id) seen[id] = true;
    out.push({ rank: m[1], id: id, family: m[3].trim(), given: m[4].trim() });
  });
  return any ? out : null;
}

/**
 * Normalizes one raw calendar event for Crew Intelligence using the installed classifier:
 *   flight  → { type: 'flight', flight: { sourceId, start, end, origin, destination, flightNumber, crew } }
 *   unknown → { type: 'hidden', hidden: { start, end } } (unrecognised codes, deadheads, other carriers,
 *             unclassifiable titles: a sector may hide behind them)
 *   other   → { type: 'other' } (day codes, check-in, pickup, standby: never sectors)
 */
function fcv2CrewNormalizeEvent_(raw, config) {
  const ev = fcv2ClassifyEvent_(raw, config);
  if (ev.kind === 'flight') {
    return {
      type: 'flight',
      flight: {
        sourceId: ev.sourceId, start: ev.start, end: ev.end, origin: ev.flight.origin, destination: ev.flight.destination,
        flightNumber: ev.flight.number, crew: fcv2CrewParseLines_(raw.description, config),
      },
    };
  }
  if (ev.kind === 'unknown') return { type: 'hidden', hidden: { start: ev.start, end: ev.end } };
  return { type: 'other' };
}

/** A Crew Intelligence window reader over raw events: read(from, to) -> { flights, hidden }. */
function fcv2CrewReaderFrom_(readRaw, config) {
  return function (from, to) {
    const flights = [];
    const hidden = [];
    const seen = {};
    readRaw(from, to).forEach(function (raw) {
      if (seen[raw.sourceId]) return;                                // feed and synced copy overlap at the boundary
      seen[raw.sourceId] = true;
      const n = fcv2CrewNormalizeEvent_(raw, config);
      if (n.type === 'flight') flights.push(n.flight);
      else if (n.type === 'hidden') hidden.push(n.hidden);
    });
    return { flights: flights, hidden: hidden };
  };
}
