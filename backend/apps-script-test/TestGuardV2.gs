// ============================================================================
// FLIGHT CONTROL — ISOLATED APPS SCRIPT TEST PACKAGE: ISOLATION GUARD (test-only)
// ============================================================================
// NEVER add this file to the production Apps Script project. It exists only inside the two throwaway test
// projects built by scripts/gas-test/build-test-package.mjs (see docs/CREW-GAS-TEST-SETUP.md).
//
// What it does:
//   - fctIsolation_ refuses to run unless the project's Script Properties prove it is the isolated test
//     project (marker, test-format secrets, a deny list of SHA-256 hashes of the PRODUCTION calendar ids, and
//     none of the production-only keys).
//   - fctCalendar_ opens one of the two synthetic calendars only after it proves: the id is configured and not
//     denied, the calendar exists, is owned by the running account, carries the exact test name and a
//     description line "fc-test-marker:<marker>". Any failure throws { fctGuard: <code> } and never carries an
//     id, a name or a description.
//   - fctPrepare_ assigns the constants the production sources read by NAME (SOURCE_CALENDAR_ID,
//     TARGET_CALENDAR_ID, ...) only AFTER the checks passed; until then they point at nothing.
//   - fctEnv_ hardens the production live environment: no provider key, no network, no hotel Sheet.
//   - doPost (declared after RosterApiV2.gs in the same bundle, so it wins) answers { ok:false,
//     error:"not-configured" } whenever the guard refuses, and never says why.
//
// Naming: every helper starts with fct and ends in "_" (not callable remotely). Editor entry points have no
// trailing underscore. No top-level service access: constants and functions only.
// ============================================================================

// The constants production sources use BY NAME and that exist only in the private production project.
// `var` so fctPrepare_ can assign the verified ids. While unverified, getCalendarById('FCTEST-UNSET') is null
// and every unguarded path fails closed. The distinct sync tag key means that even a production synced
// calendar would yield zero tagged events.
var SOURCE_CALENDAR_ID = 'FCTEST-UNSET';
var TARGET_CALENDAR_ID = 'FCTEST-UNSET';
var HOTEL_SPREADSHEET_ID = 'FCTEST-NO-SHEET';
var HOTEL_SHEET_NAME = 'FCTEST-NO-SHEET';
var SYNC_PROPERTY_KEY = 'FCTEST_SYNC_SOURCE_ID';

const FCT_ISOLATED_VALUE_ = 'fc-test-isolated-v1';
const FCT_NAME_FEED_ = 'FC-TEST Airline Feed';
const FCT_NAME_SYNCED_ = 'FC-TEST Synced Roster';
const FCT_MARKER_PREFIX_ = 'fc-test-marker:';
// Keys that exist only in the production project; their presence means this is not the isolated project.
const FCT_PRODUCTION_ONLY_KEYS_ = ['FC_ADB_RAPIDAPI_KEY', 'PLACES_API_KEY', 'FC_V5_GET'];

/** Property value as a string (not trimmed), or null when the property is absent. */
function fctProp_(props, key) {
  const v = props.get(key);
  return v === null || v === undefined ? null : String(v);
}

/** Lowercase hex SHA-256 of a string (own copy: the seeder project has no production sources). */
function fctSha256_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

/** The live dependencies of the guard (the only place the real services are named). */
function fctDeps_() {
  const sp = PropertiesService.getScriptProperties();
  return {
    calendarApp: CalendarApp,
    props: { get: function (k) { return sp.getProperty(k); } },
    hash: fctSha256_,
  };
}

/** Canonical form of a calendar id for the deny-list hash and the equality check: trimmed, lowercase. */
function fctNormId_(id) {
  return String(id).trim().toLowerCase();
}

/** The deny list: at least two distinct lowercase 64-hex SHA-256 hashes (of the PRODUCTION calendar ids). */
function fctDenyList_(props) {
  const raw = fctProp_(props, 'FCT_DENY_SHA256');
  if (raw === null) return null;
  const parts = raw.split(',').map(function (p) { return p.trim(); });
  const distinct = {};
  for (let i = 0; i < parts.length; i++) {
    if (!/^[a-f0-9]{64}$/.test(parts[i])) return null;
    distinct[parts[i]] = true;
  }
  return Object.keys(distinct).length >= 2 ? parts : null;
}

/**
 * The isolation check of the API project. Requires ALL of: the isolation flag, none of the production-only
 * keys, a test-format roster token, a test-format pepper and synthetic owner id (when set), a marker and a deny
 * list. Returns { ok: true } or { ok: false, reason: <stable code> } (the reason is for the editor, never for
 * an HTTP caller).
 */
function fctIsolation_(props) {
  const no = function (reason) { return { ok: false, reason: reason }; };
  if (fctProp_(props, 'FCT_ISOLATED') !== FCT_ISOLATED_VALUE_) return no('not-isolated');
  for (let i = 0; i < FCT_PRODUCTION_ONLY_KEYS_.length; i++) {
    if (fctProp_(props, FCT_PRODUCTION_ONLY_KEYS_[i]) !== null) return no('production-property');
  }
  if (!/^fctest_[a-f0-9]{64}$/.test(fctProp_(props, 'FC_V2_TOKEN') || '')) return no('token-format');
  const pepper = fctProp_(props, 'FC_CREW_PEPPER');
  if (pepper !== null && !/^fctest_pepper_[a-f0-9]{64}$/.test(pepper)) return no('pepper-format');
  const self = fctProp_(props, 'FC_CREW_SELF');
  if (self !== null && !/^99[0-9]{4}X$/.test(self)) return no('self-format');
  if (!/^[a-f0-9]{32,64}$/.test(fctProp_(props, 'FCT_MARKER') || '')) return no('marker-missing');
  if (fctDenyList_(props) === null) return no('denylist-missing');
  return { ok: true };
}

/**
 * Opens the synthetic calendar of a role ('feed' | 'synced') or throws { fctGuard: <code> }.
 * deps: { calendarApp, props: { get(key) }, hash(text) } (injected so Node tests can fake them).
 * Checks, in order: role; both ids configured and distinct; deny list and marker present; neither id denied;
 * the calendar exists; its exact name; owned by the running account; its description holds
 * "fc-test-marker:<FCT_MARKER>". The thrown value is a bare code: no id, name or description.
 */
function fctCalendar_(role, deps) {
  const fail = function (code) { throw { fctGuard: code }; };
  if (role !== 'feed' && role !== 'synced') fail('bad-role');
  const feedId = fctProp_(deps.props, 'FCT_CAL_FEED_ID');
  const syncedId = fctProp_(deps.props, 'FCT_CAL_SYNCED_ID');
  if (!feedId || !syncedId) fail('calendar-id-missing');
  if (feedId === syncedId) fail('calendar-ids-equal');
  const deny = fctDenyList_(deps.props);
  if (deny === null) fail('denylist-missing');
  const marker = fctProp_(deps.props, 'FCT_MARKER');
  if (!/^[a-f0-9]{32,64}$/.test(marker || '')) fail('marker-missing');
  // Ids are compared and hashed normalized (trimmed, lowercase), as scripts/gas-test/hash-id.mjs does, so a
  // production id pasted with different case or stray whitespace is still denied.
  if (fctNormId_(feedId) === fctNormId_(syncedId)) fail('calendar-ids-equal');
  let hashes = null;
  try { hashes = [deps.hash(fctNormId_(feedId)), deps.hash(fctNormId_(syncedId))]; } catch (err) { hashes = null; }
  if (hashes === null) fail('hash-error');
  // Both ids are checked whatever the role: a production id in either slot means the setup is wrong.
  if (deny.indexOf(hashes[0]) >= 0 || deny.indexOf(hashes[1]) >= 0) fail('calendar-denied');
  const id = role === 'feed' ? feedId : syncedId;
  let calendar = null;
  let lookupFailed = false;
  try { calendar = deps.calendarApp.getCalendarById(id); } catch (err) { lookupFailed = true; }
  if (lookupFailed) fail('calendar-error');
  if (!calendar) fail('calendar-missing');
  let name = null;
  let owned = null;
  let description = null;
  let readFailed = false;
  try { name = calendar.getName(); owned = calendar.isOwnedByMe(); description = calendar.getDescription(); } catch (err) { readFailed = true; }
  if (readFailed) fail('calendar-error');
  if (name !== (role === 'feed' ? FCT_NAME_FEED_ : FCT_NAME_SYNCED_)) fail('calendar-name');
  if (owned !== true) fail('calendar-not-owned');
  if (typeof description !== 'string' || description.indexOf(FCT_MARKER_PREFIX_ + marker) < 0) fail('calendar-marker');
  return { id: id, calendar: calendar };
}

/** Isolation + both calendar checks, then (and only then) the production constants are assigned. */
function fctPrepare_(deps) {
  const d = deps || fctDeps_();
  const iso = fctIsolation_(d.props);
  if (!iso.ok) throw { fctGuard: iso.reason };
  const feed = fctCalendar_('feed', d);
  const synced = fctCalendar_('synced', d);
  SOURCE_CALENDAR_ID = feed.id;
  TARGET_CALENDAR_ID = synced.id;
  return { feed: feed, synced: synced };
}

/**
 * The production live environment (fcv2LiveEnv_) after the guard passed, hardened: no provider key (so
 * departures and flight are neither offered nor served), a provider fetch that always throws, a synthetic
 * stats answer and no hotel Sheet lookup.
 */
function fctEnv_(deps) {
  fctPrepare_(deps || null);
  const env = fcv2LiveEnv_();
  env.departuresKey = function () { return null; };
  env.providerFetch = function () { throw new Error('fctest-no-network'); };
  env.stats = function () { return { success: true, synthetic: true }; };
  env.sleep = function () {};
  env.deps.hotelLookup = function () { return null; };
  return env;
}

/**
 * Request handling behind doPost, separated for tests and the smoke runner. A refused guard answers
 * not-configured (never the reason); an unexpected error in a handler answers server-error without details.
 */
function fctHandle_(body, deps) {
  let env = null;
  try { env = fctEnv_(deps || null); } catch (err) { env = null; }
  if (env === null) return { ok: false, error: 'not-configured' };
  try { return fcv2HandlePost_(body, env); } catch (err) { return { ok: false, error: 'server-error' }; }
}

// The production `doPost` (RosterApiV2.gs) is declared earlier in the same bundle; this later declaration wins.
function doPost(e) {
  const body = e && e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : '';
  return ContentService.createTextOutput(JSON.stringify(fctHandle_(body, null))).setMimeType(ContentService.MimeType.JSON);
}

// The production `stats` source (getFlightStats) lives in the private production project; the test answer is synthetic.
function getFlightStats() {
  return { success: true, synthetic: true };
}

/** Editor: one JSON line of booleans and stable reason codes (never a value, id, name or URL). */
function fctCheckSetup() {
  const api = typeof fcv2HandlePost_ === 'function';
  const out = { role: api ? 'api' : 'seeder' };
  let deps = null;
  try { deps = fctDeps_(); } catch (err) { deps = null; }
  if (deps === null) {
    out.services = false;
  } else {
    const iso = api ? fctIsolation_(deps.props) : fctSeederIsolation_(deps.props);
    out.isolation = iso.ok ? 'ok' : iso.reason;
    ['feed', 'synced'].forEach(function (role) {
      try { fctCalendar_(role, deps); out[role] = 'ok'; } catch (err) { out[role] = err && err.fctGuard ? err.fctGuard : 'error'; }
    });
    if (api) {
      out.crewEnabled = fctProp_(deps.props, 'FC_CREW_ENABLED') === 'on';
      out.selfMatchesFixture = fctProp_(deps.props, 'FC_CREW_SELF') === fctSynthId_(0);
      try {
        const owner = String(fctProp_(deps.props, 'FC_CREW_OWNER') || '').trim().toLowerCase();
        const email = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
        out.identityMatchesOwner = !!owner && !!email && owner === email;
      } catch (err) {
        out.identityMatchesOwner = 'unavailable';
      }
    }
  }
  console.log(JSON.stringify(out));
  return out;
}
