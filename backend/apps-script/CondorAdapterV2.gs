// ============================================================================
// FLIGHT CONTROL ROSTER CONTRACT V2 — SOURCE ADAPTER: Condor duty-plan calendar
// ============================================================================
// The ONLY place that knows the airline feed's description layout and flight-title format.
// Everything here is configuration or pure parsing (no Apps Script services), so it
// is unit-tested in Node. The roster CODES (raw title → canonical concept) are NOT here: they
// live in CondorCodesV2.gs, generated from src/airlines/condor/roster-codes.js. That file loads
// AFTER this one (Apps Script appends new files), so this file reads FCV2_CONDOR_CODES_ only
// inside function bodies at call time, never at load time.
//
// Privacy: descriptions contain colleague names and employee numbers. Only two
// things are read: the hotel block, parsed fail-closed against its expected structure
// (name, street lines with numbers, city, phone; anything else drops the address), and
// the aircraft line. Nothing else from a description is ever returned.
// All names end in "_" so they cannot be called through google.script.run.
// ============================================================================

const FCV2_CONDOR_CONFIG_ = Object.freeze({
  adapter: 'condor-calendar',
  // Operational base(s) and the zone the feed's day codes are aligned to.
  baseTimeZone: 'Europe/Berlin',
  homeBases: ['FRA'],
  // Prefixes the sync adds to flight titles in the synced copy of the calendar.
  titlePrefixes: ['✈️✈️✈️ '],
  // First date of usable synced history.
  historyStart: '2022-08-01',
  // Crew rank codes that open crew-list lines in this feed (never part of hotel data).
  crewRanks: ['CP', 'CPT', 'FO', 'SFO', 'SO', 'PU', 'ST', 'SEN', 'FA', 'CA', 'CM', 'FE', 'IP', 'TRI', 'TRE'],
});

/** Title without the sync's decorative prefix, trimmed. */
function fcv2CleanTitle_(title, config) {
  let t = String(title || '').trim();
  (config.titlePrefixes || []).forEach(function (p) {
    const bare = p.trim();
    if (bare && t.indexOf(bare) === 0) t = t.slice(bare.length).trim();
  });
  return t;
}

/** Lines that can never be hotel data: crew entries, name lists, rank codes, references. */
const FCV2_HOTEL_WORDS_ = /(hotel|inn|resort|suite|lodge|resid|collection|plaza|airport|house|palace|apart|tower|centre|center|park|garden|beach|marriott|hilton|hyatt|sheraton|radisson|novotel|ibis|mercure|holiday|crowne|steigen|maritim|melia|riu|iberostar|westin)/i;

function fcv2NeverHotel_(l) {
  const ranks = FCV2_CONDOR_CONFIG_.crewRanks.join('|');
  return l.length < 2 || l.length > 80
    || (new RegExp('^(' + ranks + ')\\d*\\s+\\S', 'i').test(l) && !FCV2_HOTEL_WORDS_.test(l)) // "CP MUELLER …"
    || (/,/.test(l) && !/\d/.test(l) && !FCV2_HOTEL_WORDS_.test(l))      // "Surname, Given (…)" name lists
    || /\b(?=[A-Za-z]*\d)(?=\d*[A-Za-z])[A-Za-z0-9]{5,}\b/.test(l)       // codes mixing letters and digits
    || /\d{6}[A-Za-z]?\b/.test(l)                                   // employee-number token
    || /^[A-Za-z]{2,3}\d+\b/.test(l)                                 // rank with a number: "CP1 …"
    || /^[A-Za-z]{2,3}\s+(?=\S*\d)\S{5,}/.test(l)                     // rank + id: "CP 1234567 …"
    || /^[\p{L}.'’-]+\s*[,\/]\s*[\p{L}.'’-]+$/u.test(l)                // "Surname, Given" / "SURNAME/GIVEN"
    || /[\p{L}.]\s*\/\s*\p{L}/u.test(l)                                // name lists with "/"
    || /\(\s*[A-Za-z]{3}\s*\)/.test(l)                                 // crew base "(FRA)" / "(FRA )"
    || /(code|buchung|booking|confirmation|reservation|nummer|number|\bref\b|\bpnr\b|crew|cockpit|cabin)/i.test(l)
    || !/^[\p{L}\p{N}][\p{L}\p{N} .,'’&()\/-]*$/u.test(l);
}

/**
 * Hotel block, fail-closed. The airline writes: "Hotel", name, street line(s), city line, phone.
 *   name     the first line after "Hotel" (never a name list, rank code or reference)
 *   address  ONLY when the block ends with a phone line: each line must contain a number
 *            (street, postcode) or be the single city line directly before the phone
 *   phone    "+<digits>" line
 * Anything that does not fit drops the address (and the phone); an unusable name drops the hotel.
 */
function fcv2ParseHotel_(lines, i) {
  const block = [];
  let phone = null;
  for (let j = i + 1; j < lines.length && block.length < 5; j++) {
    const l = lines[j];
    if (!l) break;
    if (block.length > 0 && /^\+\d[\d\s()\/.-]{5,}$/.test(l)) { phone = l.replace(/\s+/g, ' '); break; }
    block.push(l);
  }
  const name = block[0];
  if (!name || name.length < 3 || fcv2NeverHotel_(name)) return null;
  const rest = block.slice(1);
  const addressOk = phone !== null && rest.length >= 1 && rest.length <= 3 && rest.every(function (l, k) {
    if (fcv2NeverHotel_(l)) return false;
    if (/\d/.test(l)) return true;
    return k === rest.length - 1 && /^[\p{L}][\p{L} '’-]{1,39}$/u.test(l);   // city line just before the phone
  });
  return addressOk ? { name: name, address: rest.join(', '), phone: phone } : { name: name, address: null, phone: null };
}

/**
 * Allow-listed description reading. Returns only:
 *   hotel    from the block after a line "Hotel" (fcv2ParseHotel_, fail-closed)
 *   aircraft {registration, typeCode}: a line "ABCDE (32N)" outside the hotel block, whose
 *            type code contains a digit (IATA aircraft type codes do; airport codes do not)
 * Every other line (crew lists, booking codes, notes, sync enrichment) is ignored.
 */
function fcv2ParseDescription_(description) {
  const lines = String(description || '').split(/\r?\n/).map(function (l) { return l.trim(); });
  let hotel = null;
  let aircraft = null;
  let inHotel = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^hotel$/i.test(line)) {
      inHotel = true;
      if (!hotel) hotel = fcv2ParseHotel_(lines, i); // a second block is ignored, never merged
      continue;
    }
    if (!line) { inHotel = false; continue; }
    if (!aircraft && !inHotel) {
      const m = line.match(/^([A-Z]{5}|[A-Z]{1,2}-[A-Z0-9]{3,5}) \(([0-9A-Z]{3})\)$/);
      if (m && /\d/.test(m[2])) aircraft = { registration: m[1], typeCode: m[2] };
    }
  }
  return { hotel: hotel, aircraft: aircraft };
}

/** Compiled code matchers, built on first call (never at load time; see the header). */
let FCV2_CODE_MATCHERS_ = null;

function fcv2CodeMatchers_() {
  if (!FCV2_CODE_MATCHERS_) {
    FCV2_CODE_MATCHERS_ = FCV2_CONDOR_CODES_.codes.map(function (def) {
      if (Object.prototype.hasOwnProperty.call(def.match, 'exact')) {
        const exact = def.match.exact;
        return { def: def, test: function (t) { return t === exact; } };
      }
      const re = new RegExp(def.match.pattern);
      return { def: def, test: function (t) { return re.test(t); } };
    });
  }
  return FCV2_CODE_MATCHERS_;
}

/**
 * Classifies one raw calendar event into a normalized source event.
 * Order: flight title (designator from the code table), then the code table in its own order.
 * @param {{sourceId:string, title:string, start:number, end:number, location?:string, description?:string, basis:string}} raw
 * @returns {object} {sourceId, kind, subtype, code, title, start, end, location, flight, aircraft, hotel, basis, protected}
 */
function fcv2ClassifyEvent_(raw, config) {
  const title = fcv2CleanTitle_(raw.title, config);
  const location = /^[A-Z]{3}$/.test(String(raw.location || '').trim()) ? String(raw.location).trim() : null;
  const parsed = fcv2ParseDescription_(raw.description);
  const out = {
    sourceId: String(raw.sourceId), kind: 'unknown', subtype: null, code: title.slice(0, 24), title: title.slice(0, 80),
    start: raw.start, end: raw.end, location: location, flight: null, aircraft: null, hotel: null,
    basis: raw.basis, protected: false,
  };
  const flight = title.match(/^([A-Z0-9]{2})(\d{1,4})\s+([A-Z]{3})-([A-Z]{3})\b/);
  if (flight && FCV2_CONDOR_CODES_.flightDesignators.indexOf(flight[1]) >= 0) {
    out.kind = 'flight';
    out.code = flight[1];
    out.flight = { number: flight[1] + flight[2], origin: flight[3], destination: flight[4] };
    out.aircraft = parsed.aircraft;
    out.hotel = parsed.hotel;
    return out;
  }
  const matchers = fcv2CodeMatchers_();
  for (let i = 0; i < matchers.length; i++) {
    if (!matchers[i].test(title)) continue;
    const def = matchers[i].def;
    out.kind = def.kind;
    out.subtype = def.subtype || null;
    out.code = title;
    // Only windows (standby/reserve) carry a roster hotel; day codes and check-in/pickup do not.
    if (def.kind === 'standby' || def.kind === 'reserve') out.hotel = parsed.hotel;
    out.protected = Boolean(def.protected);
    return out;
  }
  // Unknown code: kept with its original code/title, never dropped or guessed.
  return out;
}
