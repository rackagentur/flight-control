// ============================================================================
// FLIGHT CONTROL ROSTER CONTRACT V2 — READ API (doPost)
// ============================================================================
// A separate, authenticated READ contract next to the unchanged v5 GET actions.
//
// Request : POST, Content-Type text/plain (a CORS "simple request", no preflight),
//           body {"contract":"fc.roster","version":2,"action":..., "token":..., ...}
// Actions : capabilities | roster {from?, to?} | history {from?, to?}
//           | stats (BH-2: the unchanged v5 getStats payload, now behind the token)
// Auth    : shared secret in Script Property FC_V2_TOKEN, compared in constant time.
//           No property → every call is refused ("not-configured"). The correct token is
//           always accepted; only failed attempts are counted and limited, so failures by
//           someone else can never lock the owner out.
// Output  : JSON, always HTTP 200 (Apps Script cannot set status codes);
//           failures are {ok:false, error:<code>}.
//
// Reads only: the airline calendar (fresh window), the synced calendar (earlier part
// of the window and history; only events carrying the sync tag), and the hotel Sheet
// (read-only; never getHotelSheet(), which rewrites the header row).
// Uses constants defined elsewhere in the project by NAME only (no values here):
//   SOURCE_CALENDAR_ID, TARGET_CALENDAR_ID, HOTEL_SPREADSHEET_ID, HOTEL_SHEET_NAME, SYNC_PROPERTY_KEY
// Every helper ends in "_"; doPost itself checks the token before doing anything.
// ============================================================================

const FCV2_TOKEN_PROPERTY_ = 'FC_V2_TOKEN';
const FCV2_MAX_BODY_ = 8192;
const FCV2_MAX_FAILURES_ = 20;          // bad tokens per 10 minutes before refusing for a while
const FCV2_CACHE_SECONDS_ = 6 * 3600;   // history cache

function doPost(e) {
  const body = e && e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : '';
  const result = fcv2HandlePost_(body, fcv2LiveEnv_());
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

/** Constant-time comparison of two strings (no early exit on the first difference). */
function fcv2SafeEqual_(a, b) {
  a = String(a);
  b = String(b);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** Month arithmetic on 'YYYY-MM-DD' keys. */
function fcv2MonthStart_(key, deltaMonths) {
  const p = key.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1 + deltaMonths, 1)).toISOString().slice(0, 10);
}

/**
 * Pure request handler (tested in Node with a fake env).
 * env: {token():string|null, now():number, stats():Object (v5 payload), config, failures:{get():number, add():void},
 *       airlineEvents(fromMs,toMs), syncedEvents(fromMs,toMs), startOfDay(key):number,
 *       cacheGet(key), cachePut(key,value), deps:{hash, localIso, localDate, tzOf, hotelLookup}}
 */
function fcv2HandlePost_(body, env) {
  if (typeof body !== 'string' || !body || body.length > FCV2_MAX_BODY_) return { ok: false, error: 'bad-request' };
  let req;
  try { req = JSON.parse(body); } catch (err) { return { ok: false, error: 'bad-request' }; }
  if (!req || typeof req !== 'object') return { ok: false, error: 'bad-request' };

  const expected = env.token();
  if (!expected) return { ok: false, error: 'not-configured' };
  if (typeof req.token !== 'string' || !fcv2SafeEqual_(req.token, expected)) {
    // Over the limit, failures get "rate-limited" (and are no longer counted); the correct
    // token above is unaffected. Guessing stays infeasible with a long random token.
    if (env.failures.get() >= FCV2_MAX_FAILURES_) return { ok: false, error: 'rate-limited' };
    env.failures.add();
    return { ok: false, error: 'unauthorized' };
  }
  if (req.contract !== FCV2_CONTRACT_ || req.version !== FCV2_VERSION_) {
    return { ok: false, error: 'unsupported-contract', contract: FCV2_CONTRACT_, version: FCV2_VERSION_ };
  }

  const config = env.config;
  const now = env.now();
  const today = env.deps.localDate(now, config.baseTimeZone);

  if (req.action === 'capabilities') {
    return {
      ok: true, contract: FCV2_CONTRACT_, version: FCV2_VERSION_, action: 'capabilities', generatedAt: now,
      actions: ['capabilities', 'roster', 'history', 'stats'],
      limits: { rosterMaxDays: FCV2_WINDOW_MAX_DAYS_, historyMaxMonths: FCV2_HISTORY_MAX_MONTHS_, historyMaxSectors: FCV2_HISTORY_MAX_SECTORS_ },
      source: { adapter: config.adapter, baseTimeZone: config.baseTimeZone },
    };
  }

  if (req.action === 'roster') {
    // Default: previous, current and next month.
    const from = req.from || fcv2MonthStart_(today, -1);
    const to = req.to || fcv2AddDays_(fcv2MonthStart_(today, 2), -1);
    const range = fcv2Range_(from, to, FCV2_WINDOW_MAX_DAYS_);
    if (range.error) return { ok: false, error: range.error };
    // Fresh part from the airline feed (from today); earlier days from the synced copy.
    const segments = [];
    let events = [];
    if (range.from < today) {
      const end = range.to < today ? range.to : fcv2AddDays_(today, -1);
      segments.push({ from: range.from, to: end, basis: 'synced-copy' });
      events = events.concat(env.syncedEvents(env.startOfDay(range.from), env.startOfDay(fcv2AddDays_(end, 1))));
    }
    if (range.to >= today) {
      const start = range.from > today ? range.from : today;
      segments.push({ from: start, to: range.to, basis: 'airline-feed' });
      events = events.concat(env.airlineEvents(env.startOfDay(start), env.startOfDay(fcv2AddDays_(range.to, 1))));
    }
    // A synced copy that overlaps the feed boundary must not double an event.
    const seen = {};
    events = events.filter(function (ev) { if (seen[ev.sourceId]) return false; seen[ev.sourceId] = true; return true; })
      .map(function (raw) { return fcv2ClassifyEvent_(raw, config); });
    return fcv2BuildRoster_({ events: events, from: range.from, to: range.to, segments: segments, now: now, config: config }, env.deps);
  }

  if (req.action === 'history') {
    const to = req.to || fcv2AddDays_(today, -1);
    const from = req.from || fcv2MonthStart_(today, -(FCV2_HISTORY_MAX_MONTHS_ - 1));
    const range = fcv2Range_(from, to, null, FCV2_HISTORY_MAX_MONTHS_);
    if (range.error) return { ok: false, error: range.error };
    if (range.from < config.historyStart) return { ok: false, error: 'before-history-start', historyStart: config.historyStart };
    if (range.to >= today) return { ok: false, error: 'history-is-past-only' };
    const key = 'fcv2-history-' + range.from + '-' + range.to;
    const cached = env.cacheGet(key);
    if (cached) return cached;
    const events = env.syncedEvents(env.startOfDay(range.from), env.startOfDay(fcv2AddDays_(range.to, 1)))
      .map(function (raw) { return fcv2ClassifyEvent_(raw, config); });
    const result = fcv2BuildHistory_({ events: events, from: range.from, to: range.to, now: now, config: config }, env.deps);
    env.cachePut(key, result);
    return result;
  }

  if (req.action === 'stats') {
    // BH-2: the v5 getStats payload, unchanged (its own {success, ...} shape), for token holders.
    // A failing read answers in JSON without details (never an HTML error page).
    try { return env.stats(); } catch (err) { return { ok: false, error: 'stats-unavailable' }; }
  }

  return { ok: false, error: 'unknown-action' };
}

// ---------------------------------------------------------------------------
// Live environment (Apps Script services). Not unit-testable in Node; kept thin.
// ---------------------------------------------------------------------------

function fcv2LocalIso_(ms, tz) {
  // "XXX" renders a zero offset as "Z"; the contract always states the offset numerically.
  return Utilities.formatDate(new Date(ms), tz, "yyyy-MM-dd'T'HH:mmXXX").replace(/Z$/, '+00:00');
}
function fcv2LocalDate_(ms, tz) {
  return Utilities.formatDate(new Date(ms), tz, 'yyyy-MM-dd');
}
function fcv2Hash_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
/** First instant of a local date in the base zone (binary search; DST- and half-hour-safe). */
function fcv2StartOfDay_(key, tz) {
  let lo = Date.parse(key + 'T00:00:00Z') - 36 * 3600000;
  let hi = lo + 72 * 3600000;
  while (hi - lo > 60000) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (fcv2LocalDate_(mid, tz) >= key) hi = mid; else lo = mid;
  }
  return hi - (hi % 60000);
}

function fcv2RawEvent_(event, basis, sourceId) {
  return {
    sourceId: sourceId, title: event.getTitle(), start: event.getStartTime().getTime(), end: event.getEndTime().getTime(),
    location: event.getLocation(), description: event.getDescription(), basis: basis,
  };
}

/** Verified Sheet rows only: name + destination match AND this stay's source event recorded. */
function fcv2HotelLookupFactory_() {
  let rows = null;
  const norm = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
  return function (sourceId, name, airport) {
    if (!airport) return null;
    if (rows === null) {
      try {
        rows = SpreadsheetApp.openById(HOTEL_SPREADSHEET_ID).getSheetByName(HOTEL_SHEET_NAME).getDataRange().getValues().slice(1);
      } catch (err) { rows = []; }
    }
    const row = rows.filter(function (r) {
      return norm(r[0]) === norm(name) && String(r[1] || '').trim().toUpperCase() === airport
        && String(r[10] || '').split('|').map(function (x) { return x.trim(); }).indexOf(String(sourceId)) >= 0
        && String(r[12] || '').trim() === 'VERIFIED';
    })[0];
    if (!row || !isFinite(Number(row[4])) || !isFinite(Number(row[5]))) return null;
    return { lat: Number(row[4]), lon: Number(row[5]), mapsUrl: String(row[6] || '') || null, placeId: String(row[11] || '') || null };
  };
}

function fcv2LiveEnv_() {
  const config = FCV2_CONDOR_CONFIG_;
  const props = PropertiesService.getScriptProperties();
  const cache = CacheService.getScriptCache();
  return {
    config: config,
    token: function () { return props.getProperty(FCV2_TOKEN_PROPERTY_); },
    now: function () { return Date.now(); },
    stats: function () { return getFlightStats(); },
    failures: {
      get: function () { return Number(cache.get('fcv2-failures') || 0); },
      add: function () { cache.put('fcv2-failures', String(Number(cache.get('fcv2-failures') || 0) + 1), 600); },
    },
    startOfDay: function (key) { return fcv2StartOfDay_(key, config.baseTimeZone); },
    airlineEvents: function (fromMs, toMs) {
      return CalendarApp.getCalendarById(SOURCE_CALENDAR_ID).getEvents(new Date(fromMs), new Date(toMs))
        .map(function (ev) { return fcv2RawEvent_(ev, 'airline-feed', ev.getId()); });
    },
    syncedEvents: function (fromMs, toMs) {
      // Only events the sync created (they carry the source event id); the synced
      // calendar also holds unrelated personal events, which are never read.
      return CalendarApp.getCalendarById(TARGET_CALENDAR_ID).getEvents(new Date(fromMs), new Date(toMs))
        .map(function (ev) { const id = ev.getTag(SYNC_PROPERTY_KEY); return id ? fcv2RawEvent_(ev, 'synced-copy', id) : null; })
        .filter(Boolean);
    },
    cacheGet: function (key) { const v = cache.get(key); return v ? JSON.parse(v) : null; },
    cachePut: function (key, value) { const s = JSON.stringify(value); if (s.length < 90000) cache.put(key, s, FCV2_CACHE_SECONDS_); },
    deps: {
      hash: fcv2Hash_,
      localIso: fcv2LocalIso_,
      localDate: fcv2LocalDate_,
      tzOf: function (iata) { return Object.prototype.hasOwnProperty.call(FCV2_AIRPORT_TZ_, iata) ? FCV2_AIRPORT_TZ_[iata] : null; },
      hotelLookup: fcv2HotelLookupFactory_(),
    },
  };
}
