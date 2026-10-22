// ============================================================================
// FLIGHT CONTROL ROSTER CONTRACT V2 — FLIGHT ACTION (provider data)
// ============================================================================
// The `flight` action of the fc.roster v2 doPost API (RosterApiV2.gs routes to it after the
// token and contract checks). It looks up ONE flight (flight number + departure date in the
// ORIGIN airport's local time zone + origin airport) at AeroDataBox (RapidAPI) and returns its
// live departure/arrival info: status, terminals, gates, check-in desk, baggage belt, times, the
// provider's own last-update timestamp and per-leg data-quality flags.
//
// These are PROVIDER facts (provenance "provider"): nothing is invented. A gate, terminal,
// desk, belt, time or status the provider does not state is null / "unknown"; no sample data,
// no guessing from other flights, no carry-over between legs or days. More than one matching
// leg is an error (flight-ambiguous), never a pick.
//
// The wire contract (request, response, errors, cache) is fixed by the frontend/backend
// contract note of the same change; the tests in tests/flight-info-backend.test.js pin it.
//
// Everything here is pure and tested in Node: the handler uses ONLY functions injected through
// env (departuresKey, providerFetch, sleep, cacheGet, cachePut, deps). It reuses the departures
// credential and live bindings of RosterApiV2.gs fcv2LiveEnv_ (Script Property
// FC_ADB_RAPIDAPI_KEY, UrlFetchApp, Utilities.sleep, CacheService); no new Script Property.
// The provider key lives only in that Script Property; it never appears in a response, a log, a
// thrown message or this file. Provider errors are mapped to codes; provider text is never echoed.
//
// Load order: this file may be appended LAST in the project. It is self-contained: no top-level
// dependency on any other file and no reference to DeparturesV2.gs names (own constants and
// helpers, so either file can be deployed without the other). Other files' globals are not used.
// Every name starts with "fcv2" / "FCV2" and ends in "_".
// ============================================================================

const FCV2_FLT_HOST_ = 'aerodatabox.p.rapidapi.com';
// Provider attribution (AeroDataBox terms: visible credit on no-payment plans). Added to success responses at response time, never cached.
const FCV2_FLT_ATTRIBUTION_ = Object.freeze({ name: 'AeroDataBox', url: 'https://aerodatabox.com/' });
const FCV2_FLT_RETRY_DELAYS_MS_ = [1200, 2500];    // after HTTP 429
const FCV2_FLT_PAST_DAYS_ = 1;                     // origin-local today - 1 day ...
const FCV2_FLT_AHEAD_DAYS_ = 7;                    // ... origin-local today + 7 days
const FCV2_FLT_TTL_NEAR_S_ = 300;                  // departure within 24 h of now
const FCV2_FLT_TTL_FAR_S_ = 1800;
const FCV2_FLT_NEAR_MS_ = 24 * 3600000;
const FCV2_FLT_CACHE_MAX_CHARS_ = 20000;
const FCV2_FLT_TEXT_MAX_ = 16;
const FCV2_FLT_INPUT_MAX_ = 32;                    // longest accepted flight-number input (after removing whitespace)
const FCV2_FLT_TEXT_RE_ = /^[A-Za-z0-9][A-Za-z0-9 .\/,+-]*$/;
const FCV2_FLT_QUALITY_ = ['basic', 'live', 'approximate'];
const FCV2_FLT_WIRE_STATUS_ = ['scheduled', 'delayed', 'boarding', 'departed', 'arrived', 'diverted', 'cancelled', 'unknown'];
const FCV2_FLT_STATUS_ = Object.freeze({
  expected: 'scheduled', checkin: 'scheduled', scheduled: 'scheduled',
  delayed: 'delayed',
  boarding: 'boarding', gateclosed: 'boarding',
  departed: 'departed', enroute: 'departed', approaching: 'departed',
  arrived: 'arrived',
  diverted: 'diverted',
  canceled: 'cancelled', cancelled: 'cancelled', canceleduncertain: 'cancelled',
});
const FCV2_FLT_WIRE_KEYS_ = ['id', 'flightNumber', 'status', 'lastUpdated', 'departure', 'arrival', 'provenance'];
const FCV2_FLT_LEG_KEYS_ = ['airport', 'scheduled', 'revised', 'runway', 'terminal', 'gate', 'desk', 'belt', 'quality'];

function fcv2FltIsObject_(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function fcv2FltSameKeys_(value, keys) {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every(function (k) { return Object.prototype.hasOwnProperty.call(value, k); });
}

/**
 * Canonical flight number: whitespace removed, upper case, carrier (2 characters) + number
 * WITHOUT leading zeros (at least one digit, at most four) + optional one-letter suffix.
 * 'DE 2016', 'de2016', 'DE02016' → 'DE2016'; 'DE 0016' → 'DE16'. Anything else → null.
 */
function fcv2FlightCanonical_(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, '');
  if (!text || text.length > FCV2_FLT_INPUT_MAX_ || !/^[A-Za-z0-9]+$/.test(text)) return null;
  const match = /^([A-Z0-9]{2})(\d+)([A-Z]?)$/.exec(text.toUpperCase());
  if (!match) return null;
  const digits = match[2].replace(/^0+(?=\d)/, '');
  if (digits.length > 4) return null;
  return match[1] + digits + match[3];
}

/** True for a real 'YYYY-MM-DD' calendar date (Feb 30 is not one). */
function fcv2FlightDateValid_(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(Date.UTC(+value.slice(0, 4), +value.slice(5, 7) - 1, +value.slice(8, 10)));
  return d.getUTCFullYear() === +value.slice(0, 4) && d.getUTCMonth() + 1 === +value.slice(5, 7) && d.getUTCDate() === +value.slice(8, 10);
}

function fcv2FlightAddDays_(date, days) {
  return new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10) + days)).toISOString().slice(0, 10);
}

/**
 * Validates a flight request against `now`. Returns {error} or {flightNumber (canonical), date, origin, tz}.
 * The window is in the ORIGIN airport's local calendar: today - 1 day ... today + 7 days, inclusive.
 */
function fcv2FlightRequest_(req, now, deps) {
  if (typeof req.flightNumber !== 'string' || typeof req.date !== 'string' || typeof req.origin !== 'string') return { error: 'bad-request' };
  const flightNumber = fcv2FlightCanonical_(req.flightNumber);
  if (!flightNumber || !fcv2FlightDateValid_(req.date)) return { error: 'bad-request' };
  const tz = /^[A-Z]{3}$/.test(req.origin) ? deps.tzOf(req.origin) : null;
  if (!tz) return { error: 'unknown-airport' };
  const today = deps.localIso(now, tz).slice(0, 10);
  if (req.date < fcv2FlightAddDays_(today, -FCV2_FLT_PAST_DAYS_) || req.date > fcv2FlightAddDays_(today, FCV2_FLT_AHEAD_DAYS_)) return { error: 'range-out-of-bounds' };
  return { flightNumber: flightNumber, date: req.date, origin: req.origin, tz: tz };
}

function fcv2FlightUrl_(flightNumber, date) {
  return 'https://' + FCV2_FLT_HOST_ + '/flights/number/' + flightNumber + '/' + date
    + '?withAircraftImage=false&withLocation=false';
}

function fcv2FlightCacheKey_(flightNumber, date, origin) {
  return 'fcv2-flt-' + flightNumber + '-' + date + '-' + origin;
}

/** Provider status (case-insensitive, spaces removed) → one of FCV2_FLT_WIRE_STATUS_. */
function fcv2FlightStatus_(status) {
  if (typeof status !== 'string') return 'unknown';
  const key = status.replace(/\s+/g, '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(FCV2_FLT_STATUS_, key) ? FCV2_FLT_STATUS_[key] : 'unknown';
}

/** '2026-10-06 14:30Z' → epoch ms; null when missing or unparseable (impossible dates included). */
function fcv2FlightParseUtc_(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(text)) return null;
  const ms = Date.parse(text);
  if (!isFinite(ms)) return null;
  const day = new Date(Date.UTC(+text.slice(0, 4), +text.slice(5, 7) - 1, +text.slice(8, 10)));
  return day.getUTCMonth() + 1 === +text.slice(5, 7) && day.getUTCDate() === +text.slice(8, 10) ? ms : null;
}

/** Gate / terminal / desk / belt text: trimmed, inner whitespace collapsed, 1..16 characters, restricted alphabet; else null. */
function fcv2FlightText_(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  return text.length >= 1 && text.length <= FCV2_FLT_TEXT_MAX_ && FCV2_FLT_TEXT_RE_.test(text) ? text : null;
}

/** Provider quality flags → unique subset of ['basic','live','approximate'], in that order. */
function fcv2FlightQuality_(value) {
  if (!Array.isArray(value)) return [];
  const seen = value.map(function (q) { return typeof q === 'string' ? q.trim().toLowerCase() : ''; });
  return FCV2_FLT_QUALITY_.filter(function (q) { return seen.indexOf(q) >= 0; });
}

function fcv2FlightTime_(value) {
  return fcv2FltIsObject_(value) ? fcv2FlightParseUtc_(value.utc) : null;
}

/** One provider movement → Leg. `isDeparture` decides which of desk/belt exist (the other is always null). */
function fcv2FlightLeg_(raw, isDeparture) {
  const leg = fcv2FltIsObject_(raw) ? raw : {};
  const iata = fcv2FltIsObject_(leg.airport) && typeof leg.airport.iata === 'string' && /^[A-Z]{3}$/.test(leg.airport.iata) ? leg.airport.iata : null;
  return {
    airport: iata,
    scheduled: fcv2FlightTime_(leg.scheduledTime),
    revised: fcv2FlightTime_(leg.revisedTime),
    runway: fcv2FlightTime_(leg.runwayTime),
    terminal: fcv2FlightText_(leg.terminal),
    gate: fcv2FlightText_(leg.gate),
    desk: isDeparture ? fcv2FlightText_(leg.checkInDesk) : null,
    belt: isDeparture ? null : fcv2FlightText_(leg.baggageBelt),
    quality: fcv2FlightQuality_(leg.quality),
  };
}

/** Provider entries that are THE requested leg: same canonical number, same departure airport, same origin-local date. */
function fcv2FlightMatches_(list, q) {
  return list.filter(function (entry) {
    if (!fcv2FltIsObject_(entry) || fcv2FlightCanonical_(entry.number) !== q.flightNumber) return false;
    const dep = fcv2FltIsObject_(entry.departure) ? entry.departure : {};
    if (!fcv2FltIsObject_(dep.airport) || dep.airport.iata !== q.origin) return false;
    const scheduled = fcv2FltIsObject_(dep.scheduledTime) ? dep.scheduledTime : {};
    return typeof scheduled.local === 'string' && scheduled.local.slice(0, 10) === q.date;
  });
}

function fcv2FlightId_(q, deps) {
  return 'g_' + deps.hash(q.flightNumber + '|' + q.date + '|' + q.origin).slice(0, 16);
}

/** The matched provider entry → FlightInfoWire. */
function fcv2FlightNormalize_(entry, q, deps) {
  return {
    id: fcv2FlightId_(q, deps),
    flightNumber: q.flightNumber,
    status: fcv2FlightStatus_(entry.status),
    lastUpdated: fcv2FlightParseUtc_(entry.lastUpdatedUtc),
    departure: fcv2FlightLeg_(entry.departure, true),
    arrival: fcv2FlightLeg_(entry.arrival, false),
    provenance: 'provider',
  };
}

/**
 * One provider call with the 429 retry schedule. Returns {list} (the parsed array; [] for 204,
 * 404 and an empty 200) or {error}. Never returns or throws the URL, the key or any provider text.
 */
function fcv2FlightProviderGet_(url, key, env) {
  let res = null;
  for (let attempt = 0; attempt <= FCV2_FLT_RETRY_DELAYS_MS_.length; attempt++) {
    if (attempt > 0) env.sleep(FCV2_FLT_RETRY_DELAYS_MS_[attempt - 1]);
    try { res = env.providerFetch(url, key); } catch (err) { return { error: 'provider-unavailable' }; }
    if (!res || typeof res !== 'object') return { error: 'provider-unavailable' };
    if (res.status !== 429) break;
  }
  if (res.status === 429) return { error: 'provider-rate-limited' };
  if (res.status === 401 || res.status === 403) return { error: 'provider-auth-failed' };
  // 204, 404 and a 200 with an empty body mean "no such flight": an empty list.
  if (res.status === 204 || res.status === 404 || (res.status === 200 && typeof res.body === 'string' && !res.body.trim())) return { list: [] };
  if (res.status !== 200 || typeof res.body !== 'string') return { error: 'provider-unavailable' };
  let parsed;
  try { parsed = JSON.parse(res.body); } catch (err) { return { error: 'provider-unavailable' }; }
  if (!Array.isArray(parsed)) return { error: 'provider-unavailable' };
  return { list: parsed };
}

function fcv2FlightIntOrNull_(value) {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value));
}

function fcv2FlightTextOrNull_(value) {
  return value === null || (typeof value === 'string' && fcv2FlightText_(value) === value);
}

/** True when `leg` has exactly the Leg shape fcv2FlightLeg_ produces (desk/belt direction rules included). */
function fcv2FlightValidLeg_(leg, isDeparture) {
  if (!fcv2FltIsObject_(leg) || !fcv2FltSameKeys_(leg, FCV2_FLT_LEG_KEYS_)) return false;
  if (leg.airport !== null && (typeof leg.airport !== 'string' || !/^[A-Z]{3}$/.test(leg.airport))) return false;
  if (!fcv2FlightIntOrNull_(leg.scheduled) || !fcv2FlightIntOrNull_(leg.revised) || !fcv2FlightIntOrNull_(leg.runway)) return false;
  if (!fcv2FlightTextOrNull_(leg.terminal) || !fcv2FlightTextOrNull_(leg.gate) || !fcv2FlightTextOrNull_(leg.desk) || !fcv2FlightTextOrNull_(leg.belt)) return false;
  if (isDeparture ? leg.belt !== null : leg.desk !== null) return false;
  if (!Array.isArray(leg.quality)) return false;
  let last = -1;
  for (let i = 0; i < leg.quality.length; i++) {
    const at = FCV2_FLT_QUALITY_.indexOf(leg.quality[i]);
    if (at <= last) return false;   // unknown value, duplicate or wrong order
    last = at;
  }
  return true;
}

/** A cached envelope is usable only if it and its flight are exactly what a fresh lookup of THIS query produces. */
function fcv2FlightValidCache_(value, q, deps) {
  if (!fcv2FltIsObject_(value) || !fcv2FltSameKeys_(value, ['fetchedAt', 'found', 'flight'])) return false;
  if (typeof value.fetchedAt !== 'number' || !isFinite(value.fetchedAt)) return false;
  if (typeof value.found !== 'boolean') return false;
  if (!value.found) return value.flight === null;
  const f = value.flight;
  if (!fcv2FltIsObject_(f) || !fcv2FltSameKeys_(f, FCV2_FLT_WIRE_KEYS_)) return false;
  if (f.id !== fcv2FlightId_(q, deps) || f.flightNumber !== q.flightNumber) return false;
  if (typeof f.status !== 'string' || FCV2_FLT_WIRE_STATUS_.indexOf(f.status) < 0) return false;
  if (!fcv2FlightIntOrNull_(f.lastUpdated)) return false;
  if (f.provenance !== 'provider') return false;
  if (!fcv2FlightValidLeg_(f.departure, true) || !fcv2FlightValidLeg_(f.arrival, false)) return false;
  return f.departure.airport === q.origin;
}

/** Cache lifetime: short when the departure (else the local noon of the date) is within 24 h of now. */
function fcv2FlightTtl_(flight, q, now, deps) {
  let at = flight && flight.departure ? (flight.departure.scheduled !== null ? flight.departure.scheduled : flight.departure.revised) : null;
  if (at === null || at === undefined) {
    const noonUtc = Date.parse(q.date + 'T12:00:00Z');
    const offset = deps.localIso(noonUtc, q.tz).slice(16);   // '+02:00'
    const sign = offset.charAt(0) === '-' ? -1 : 1;
    const offsetMs = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6))) * 60000;
    at = noonUtc - offsetMs;
  }
  return Math.abs(at - now) <= FCV2_FLT_NEAR_MS_ ? FCV2_FLT_TTL_NEAR_S_ : FCV2_FLT_TTL_FAR_S_;
}

/**
 * The `flight` action. req is the parsed, already authenticated request; now is ms.
 * env: {departuresKey():string|null, providerFetch(url,key):{status,body}, sleep(ms),
 *       cacheGet(key), cachePut(key,value,ttlSeconds), deps:{hash, localIso, tzOf}}
 */
function fcv2HandleFlight_(req, env, now) {
  const q = fcv2FlightRequest_(req, now, env.deps);
  if (q.error) return { ok: false, error: q.error };
  const key = typeof env.departuresKey === 'function' ? env.departuresKey() : null;
  if (typeof key !== 'string' || !key) return { ok: false, error: 'flight-not-configured' };

  const cacheKey = fcv2FlightCacheKey_(q.flightNumber, q.date, q.origin);
  let entry = null;
  try { entry = env.cacheGet(cacheKey); } catch (err) { entry = null; }
  if (!fcv2FlightValidCache_(entry, q, env.deps)) {
    const got = fcv2FlightProviderGet_(fcv2FlightUrl_(q.flightNumber, q.date), key, env);
    if (got.error) return { ok: false, error: got.error };
    const matches = fcv2FlightMatches_(got.list, q);
    if (matches.length > 1) return { ok: false, error: 'flight-ambiguous' };
    const flight = matches.length === 1 ? fcv2FlightNormalize_(matches[0], q, env.deps) : null;
    entry = { fetchedAt: now, found: flight !== null, flight: flight };
    try {
      if (JSON.stringify(entry).length <= FCV2_FLT_CACHE_MAX_CHARS_) env.cachePut(cacheKey, entry, fcv2FlightTtl_(flight, q, now, env.deps));
    } catch (err) { /* a cache failure never fails the request */ }
  }

  return {
    ok: true, contract: 'fc.roster', version: 2, action: 'flight', provider: 'aerodatabox',
    generatedAt: now, fetchedAt: entry.fetchedAt,
    query: { flightNumber: q.flightNumber, date: q.date, origin: q.origin },
    found: entry.found, flight: entry.flight,
    attribution: FCV2_FLT_ATTRIBUTION_,
  };
}
