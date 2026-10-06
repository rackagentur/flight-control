// ============================================================================
// FLIGHT CONTROL ROSTER CONTRACT V2 — DEPARTURES ACTION (provider data)
// ============================================================================
// The `departures` action of the fc.roster v2 doPost API (RosterApiV2.gs routes to it
// after the token and contract checks). It proxies AeroDataBox (RapidAPI) scheduled
// departures for one airport and returns them normalized as ScheduledFlight records.
//
// These are PROVIDER facts (provenance "provider"): not roster sectors, not assignments.
// No mock or sample data, no airline-name map, no haul/region/visa inference, nothing
// about risk or eligibility. Any failing chunk fails the whole request (no partial data).
//
// Everything here is pure and tested in Node: the handler uses ONLY functions injected
// through env (departuresKey, providerFetch, sleep, cacheGet, cachePut, deps). The live
// bindings (Script Property FC_ADB_RAPIDAPI_KEY, UrlFetchApp, Utilities.sleep,
// CacheService) are in RosterApiV2.gs fcv2LiveEnv_. The provider key lives only in the
// Script Property; it never appears in a response, a log, a thrown message or this file.
//
// Load order: this file may be appended LAST in the project. It has no top-level
// dependency on any other file (constants and functions only); other files' globals are
// referenced inside function bodies at call time only.
// Every name starts with "fcv2" and ends in "_".
// ============================================================================

const FCV2_DEP_KEY_PROPERTY_ = 'FC_ADB_RAPIDAPI_KEY';
const FCV2_DEP_MAX_RANGE_MS_ = 24 * 3600000;
const FCV2_DEP_PAST_MS_ = 24 * 3600000;            // `from` may be at most this far in the past
const FCV2_DEP_FUTURE_MS_ = 14 * 24 * 3600000;     // `to` may be at most this far ahead
const FCV2_DEP_CHUNK_STEP_MS_ = 11 * 3600000;      // chunk starts; the 1 h overlap absorbs DST ambiguity
const FCV2_DEP_CHUNK_SPAN_MS_ = 12 * 3600000;      // AeroDataBox allows at most 12 h per call
const FCV2_DEP_OVERLAP_MS_ = 3600000;              // chunk overlap, and the outer padding next to a UTC-offset change
const FCV2_DEP_SPACING_MS_ = 1100;                 // pause between calls that really hit the provider
const FCV2_DEP_RETRY_DELAYS_MS_ = [1200, 2500];    // after HTTP 429
const FCV2_DEP_TTL_NEAR_S_ = 600;                  // chunk starts within 6 h of now
const FCV2_DEP_TTL_FAR_S_ = 3600;
const FCV2_DEP_NEAR_MS_ = 6 * 3600000;
const FCV2_DEP_CACHE_MAX_CHARS_ = 90000;
const FCV2_DEP_MAX_CARRIERS_ = 10;
const FCV2_DEP_TEXT_MAX_ = 60;
const FCV2_DEP_HOST_ = 'aerodatabox.p.rapidapi.com';
const FCV2_DEP_STATUS_ = Object.freeze({
  expected: 'scheduled', checkin: 'scheduled', scheduled: 'scheduled',
  delayed: 'delayed',
  boarding: 'boarding', gateclosed: 'boarding',
  departed: 'departed', enroute: 'departed', approaching: 'departed', arrived: 'departed', diverted: 'departed',
  canceled: 'cancelled', cancelled: 'cancelled', canceleduncertain: 'cancelled',
});

/** Validates a departures request against `now`. Returns {error} or the normalized request. */
function fcv2DepartureRequest_(req, now, tzOf) {
  const airport = req.airport;
  const tz = typeof airport === 'string' && /^[A-Z]{3}$/.test(airport) ? tzOf(airport) : null;
  if (!tz) return { error: 'unknown-airport' };
  const from = req.from;
  const to = req.to;
  if (typeof from !== 'number' || typeof to !== 'number' || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from) {
    return { error: 'bad-range' };
  }
  if (to - from > FCV2_DEP_MAX_RANGE_MS_) return { error: 'range-too-long' };
  if (from < now - FCV2_DEP_PAST_MS_ || to > now + FCV2_DEP_FUTURE_MS_) return { error: 'range-out-of-bounds' };
  const carriers = fcv2DepartureCarriers_(req.carriers);
  if (carriers === false) return { error: 'bad-request' };
  return { airport: airport, tz: tz, from: from, to: to, carriers: carriers };
}

/** null/undefined → null (no filter); a valid list → deduplicated, sorted; anything else → false. */
function fcv2DepartureCarriers_(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length < 1 || value.length > FCV2_DEP_MAX_CARRIERS_) return false;
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string' || !/^[A-Z0-9]{2}$/.test(value[i])) return false;
  }
  return value.filter(function (c, i) { return value.indexOf(c) === i; }).sort();
}

/** Minutes of local-clock difference between two 'YYYY-MM-DDTHH:mm' strings. */
function fcv2LocalMinutes_(a, b) {
  return (Date.parse(b + ':00Z') - Date.parse(a + ':00Z')) / 60000;
}

/**
 * Splits [from, to] into provider windows: chunk i starts at from + i·11 h and ends at
 * min(start + 12 h, to); chunks stop once the previous chunk's end reaches `to` (so a
 * range of at most 12 h is one call, up to 23 h two, up to 34 h three; the handler never
 * asks for more than 26 h). The 1 h overlap is removed by filtering on the instant and
 * deduplicating. Each chunk also carries its
 * airport-local strings; if a spring-forward gap makes a 12 h window span 13 local hours
 * (AeroDataBox counts local time), the end is pulled back to 12 local hours, which is
 * exactly the next chunk's start, so there is still no gap.
 */
function fcv2DepartureChunks_(from, to, tz, deps) {
  const chunks = [];
  let previousEnd = -Infinity;
  for (let start = from; start < to && previousEnd < to; start += FCV2_DEP_CHUNK_STEP_MS_) {
    let end = Math.min(start + FCV2_DEP_CHUNK_SPAN_MS_, to);
    const fromLocal = deps.localIso(start, tz).slice(0, 16);
    let toLocal = deps.localIso(end, tz).slice(0, 16);
    const span = fcv2LocalMinutes_(fromLocal, toLocal);
    if (span > 720) {
      // Never pull back past the next chunk's start (a `to` off the minute would leave a few seconds uncovered).
      end = Math.max(end - (span - 720) * 60000, start + FCV2_DEP_CHUNK_STEP_MS_);
      toLocal = deps.localIso(end, tz).slice(0, 16);
    }
    chunks.push({ start: start, end: end, fromLocal: fromLocal, toLocal: toLocal });
    previousEnd = end;
  }
  return chunks;
}

/** UTC offset text ('+01:00') of the airport zone at an instant, from deps.localIso. */
function fcv2OffsetAt_(ms, tz, deps) {
  return deps.localIso(ms, tz).slice(16);
}

/**
 * The range sent to the provider. The provider takes airport-LOCAL strings, and a local time
 * inside a repeated (fall-back) hour or next to a changeover is ambiguous, so an outer end
 * within 1 h of a UTC-offset change of the airport zone is moved outward by 1 h (results are
 * still filtered by instant to [from, to)). Otherwise nothing is added (provider quota).
 */
function fcv2ProviderRange_(from, to, tz, deps) {
  const nearChange = function (ms) {
    return fcv2OffsetAt_(ms - FCV2_DEP_OVERLAP_MS_, tz, deps) !== fcv2OffsetAt_(ms + FCV2_DEP_OVERLAP_MS_, tz, deps);
  };
  return {
    from: nearChange(from) ? from - FCV2_DEP_OVERLAP_MS_ : from,
    to: nearChange(to) ? to + FCV2_DEP_OVERLAP_MS_ : to,
  };
}

function fcv2DepartureUrl_(airport, fromLocal, toLocal) {
  return 'https://' + FCV2_DEP_HOST_ + '/flights/airports/iata/' + airport + '/' + fromLocal + '/' + toLocal
    + '?withLeg=false&direction=Departure&withCancelled=true&withCodeshared=false&withCargo=false&withPrivate=false&withLocation=false';
}

function fcv2DepartureCacheKey_(airport, chunk, carriers) {
  return 'fcv2-dep-' + airport + '-' + chunk.fromLocal + '-' + chunk.toLocal + '-' + (carriers ? carriers.join(',') : '*');
}

/** Provider status (case-insensitive) → scheduled | delayed | boarding | departed | cancelled | unknown. */
function fcv2MapDepartureStatus_(status) {
  if (typeof status !== 'string') return 'unknown';
  const key = status.toLowerCase();
  return Object.prototype.hasOwnProperty.call(FCV2_DEP_STATUS_, key) ? FCV2_DEP_STATUS_[key] : 'unknown';
}

/** '2026-10-06 14:30Z' → epoch ms; null when missing or unparseable. */
function fcv2ParseProviderUtc_(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(text)) return null;
  const ms = Date.parse(text);
  if (!isFinite(ms)) return null;
  // Date.parse rolls impossible days over (Feb 30 → Mar 2); an impossible date is unparseable.
  const day = new Date(Date.UTC(+text.slice(0, 4), +text.slice(5, 7) - 1, +text.slice(8, 10)));
  return day.getUTCMonth() + 1 === +text.slice(5, 7) && day.getUTCDate() === +text.slice(8, 10) ? ms : null;
}

function fcv2DepartureText_(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= FCV2_DEP_TEXT_MAX_ ? text : null;
}

function fcv2DepartureNumber_(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, '').toUpperCase();
  return text || null;
}

/** One provider entry → ScheduledFlightWire, or null when it has no flight number or scheduled time. */
function fcv2NormalizeDeparture_(entry, airport, deps) {
  if (!entry || typeof entry !== 'object') return null;
  const flightNumber = fcv2DepartureNumber_(entry.number) || fcv2DepartureNumber_(entry.callSign);
  if (!flightNumber) return null;
  const movement = entry.movement && typeof entry.movement === 'object' ? entry.movement : {};
  const scheduled = movement.scheduledTime && typeof movement.scheduledTime === 'object' ? movement.scheduledTime : {};
  const scheduledDep = fcv2ParseProviderUtc_(scheduled.utc);
  if (scheduledDep === null) return null;
  const revised = movement.revisedTime && typeof movement.revisedTime === 'object' ? movement.revisedTime : {};
  const revisedDep = fcv2ParseProviderUtc_(revised.utc);
  const airlineIata = entry.airline && typeof entry.airline === 'object' && typeof entry.airline.iata === 'string' ? entry.airline.iata : '';
  const lead = flightNumber.slice(0, 2);
  const carrier = /^[A-Z0-9]{2}$/.test(airlineIata) ? airlineIata : (/^[A-Z0-9]{2}$/.test(lead) ? lead : null);
  const dest = movement.airport && typeof movement.airport === 'object' ? movement.airport : {};
  const destination = typeof dest.iata === 'string' && /^[A-Z]{3}$/.test(dest.iata) ? dest.iata : null;
  const craft = entry.aircraft && typeof entry.aircraft === 'object' ? entry.aircraft : {};
  const model = fcv2DepartureText_(craft.model);
  const registration = fcv2DepartureText_(craft.reg);
  return {
    id: 'f_' + deps.hash(flightNumber + '|' + scheduledDep).slice(0, 16),
    flightNumber: flightNumber,
    carrier: carrier,
    origin: airport,
    destination: destination,
    destinationName: fcv2DepartureText_(dest.name),
    scheduledDep: scheduledDep,
    revisedDep: revisedDep,
    status: fcv2MapDepartureStatus_(entry.status),
    aircraft: model === null && registration === null ? null : { model: model, registration: registration },
    provenance: 'provider',
  };
}

/** Keeps only flights of the given carriers (null/empty list = no filter). */
function fcv2FilterCarriers_(flights, carriers) {
  if (!carriers) return flights;
  return flights.filter(function (f) { return f.carrier !== null && carriers.indexOf(f.carrier) >= 0; });
}

/**
 * Stable identity of a provider entry that was dropped: flight number, call sign and the raw
 * scheduled utc string (JSON, so a missing field and a non-object entry are still keyed).
 */
function fcv2DroppedKey_(entry) {
  if (!entry || typeof entry !== 'object') return JSON.stringify([entry === undefined ? null : entry]);
  const movement = entry.movement && typeof entry.movement === 'object' ? entry.movement : {};
  const scheduled = movement.scheduledTime && typeof movement.scheduledTime === 'object' ? movement.scheduledTime : {};
  const part = function (v) { return v === undefined ? null : v; };
  return JSON.stringify([part(entry.number), part(entry.callSign), part(scheduled.utc)]);
}

/**
 * Provider response object → {flights, dropped, droppedKeys}. `body` must be a plain object; a missing
 * `departures` is an empty list, a non-array `departures` is an unexpected shape (null).
 * Not range-filtered (the handler filters by instant); carrier-filtered when `carriers` is set.
 */
function fcv2NormalizeAdb_(body, airport, carriers, deps) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const list = body.departures === undefined || body.departures === null ? [] : body.departures;
  if (!Array.isArray(list)) return null;
  const flights = [];
  const droppedKeys = [];
  const occurrences = {};
  for (let i = 0; i < list.length; i++) {
    const flight = fcv2NormalizeDeparture_(list[i], airport, deps);
    if (flight) { flights.push(flight); continue; }
    // The n-th identical dropped entry gets '#n', so repeats inside one response still count,
    // while the same entry returned again by an overlapping chunk is recognised.
    const base = fcv2DroppedKey_(list[i]);
    occurrences[base] = (Object.prototype.hasOwnProperty.call(occurrences, base) ? occurrences[base] : 0) + 1;
    droppedKeys.push(base + '#' + occurrences[base]);
  }
  return { flights: fcv2FilterCarriers_(flights, carriers), dropped: droppedKeys.length, droppedKeys: droppedKeys };
}

/**
 * One provider call with the 429 retry schedule. Returns {body} (parsed object; {departures:[]}
 * for 204 or an empty 200) or {error}.
 * Never returns or throws the URL, the key or any provider text.
 */
function fcv2ProviderGet_(url, key, env) {
  let res = null;
  for (let attempt = 0; attempt <= FCV2_DEP_RETRY_DELAYS_MS_.length; attempt++) {
    if (attempt > 0) env.sleep(FCV2_DEP_RETRY_DELAYS_MS_[attempt - 1]);
    try { res = env.providerFetch(url, key); } catch (err) { return { error: 'provider-unavailable' }; }
    if (!res || typeof res !== 'object') return { error: 'provider-unavailable' };
    if (res.status !== 429) break;
  }
  if (res.status === 429) return { error: 'provider-rate-limited' };
  if (res.status === 401 || res.status === 403) return { error: 'provider-auth-failed' };
  // 204, and a 200 with an empty body, mean "no flights in this window": an empty list.
  if (res.status === 204 || (res.status === 200 && typeof res.body === 'string' && !res.body.trim())) return { body: { departures: [] } };
  if (res.status !== 200 || typeof res.body !== 'string') return { error: 'provider-unavailable' };
  let parsed;
  try { parsed = JSON.parse(res.body); } catch (err) { return { error: 'provider-unavailable' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'provider-unavailable' };
  return { body: parsed };
}

function fcv2ValidChunkCache_(value) {
  return !!value && typeof value === 'object' && Array.isArray(value.flights)
    && typeof value.fetchedAt === 'number' && isFinite(value.fetchedAt)
    && typeof value.dropped === 'number' && isFinite(value.dropped)
    && Array.isArray(value.droppedKeys);
}

/**
 * The `departures` action. req is the parsed, already authenticated request; now is ms.
 * env: {departuresKey():string|null, providerFetch(url,key):{status,body}, sleep(ms),
 *       cacheGet(key), cachePut(key,value,ttlSeconds), deps:{hash, localIso, tzOf}}
 */
function fcv2HandleDepartures_(req, env, now) {
  const checked = fcv2DepartureRequest_(req, now, env.deps.tzOf);
  if (checked.error) return { ok: false, error: checked.error };
  const key = typeof env.departuresKey === 'function' ? env.departuresKey() : null;
  if (typeof key !== 'string' || !key) return { ok: false, error: 'departures-not-configured' };

  // The provider is asked for the padded range (see fcv2ProviderRange_); results are filtered to [from, to).
  const asked = fcv2ProviderRange_(checked.from, checked.to, checked.tz, env.deps);
  const chunks = fcv2DepartureChunks_(asked.from, asked.to, checked.tz, env.deps);
  const entries = [];
  let fetchedAt = now;
  let calls = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const cacheKey = fcv2DepartureCacheKey_(checked.airport, chunk, checked.carriers);
    let entry = null;
    try { entry = env.cacheGet(cacheKey); } catch (err) { entry = null; }
    if (!fcv2ValidChunkCache_(entry)) {
      if (calls > 0) env.sleep(FCV2_DEP_SPACING_MS_);
      calls += 1;
      const got = fcv2ProviderGet_(fcv2DepartureUrl_(checked.airport, chunk.fromLocal, chunk.toLocal), key, env);
      if (got.error) return { ok: false, error: got.error };
      const normalized = fcv2NormalizeAdb_(got.body, checked.airport, checked.carriers, env.deps);
      if (!normalized) return { ok: false, error: 'provider-unavailable' };
      entry = { fetchedAt: now, flights: normalized.flights, dropped: normalized.dropped, droppedKeys: normalized.droppedKeys };
      const ttl = chunk.start < now + FCV2_DEP_NEAR_MS_ ? FCV2_DEP_TTL_NEAR_S_ : FCV2_DEP_TTL_FAR_S_;
      try {
        if (JSON.stringify(entry).length <= FCV2_DEP_CACHE_MAX_CHARS_) env.cachePut(cacheKey, entry, ttl);
      } catch (err) { /* a cache failure never fails the request */ }
    }
    if (entry.fetchedAt < fetchedAt) fetchedAt = entry.fetchedAt;
    entries.push(entry);
  }

  // dropped: each dropped provider entry once per request, however many chunks returned it.
  const droppedSeen = {};
  let dropped = 0;
  // Same flight id in several chunks: keep the copy from the chunk fetched last (ties: the later chunk).
  const byId = {};
  const ids = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    for (let k = 0; k < entry.droppedKeys.length; k++) {
      if (!Object.prototype.hasOwnProperty.call(droppedSeen, entry.droppedKeys[k])) {
        droppedSeen[entry.droppedKeys[k]] = true;
        dropped += 1;
      }
    }
    for (let k = 0; k < entry.flights.length; k++) {
      const f = entry.flights[k];
      if (f.scheduledDep < checked.from || f.scheduledDep >= checked.to) continue;
      if (!Object.prototype.hasOwnProperty.call(byId, f.id)) {
        ids.push(f.id);
        byId[f.id] = { flight: f, fetchedAt: entry.fetchedAt };
      } else if (entry.fetchedAt >= byId[f.id].fetchedAt) {
        byId[f.id] = { flight: f, fetchedAt: entry.fetchedAt };
      }
    }
  }
  const flights = ids.map(function (id) { return byId[id].flight; }).sort(function (a, b) {
    return a.scheduledDep - b.scheduledDep || (a.flightNumber < b.flightNumber ? -1 : a.flightNumber > b.flightNumber ? 1 : 0);
  });

  return {
    ok: true, contract: 'fc.roster', version: 2, action: 'departures',
    airport: checked.airport, airportTz: checked.tz, from: checked.from, to: checked.to, carriers: checked.carriers,
    provider: 'aerodatabox', generatedAt: now, fetchedAt: fetchedAt, dropped: dropped, flights: flights,
  };
}
