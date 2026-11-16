// Generates the SYNTHETIC Apps Script test backend for the iPhone preview (docs/IPHONE-ACCEPTANCE.md):
// the unchanged fc.roster v2 sources followed by a test environment over the repository's synthetic
// Condor fixture, shifted to the current date. It reads no calendar, Sheet or provider and holds no
// production identifier or token. This script only writes files; it never deploys.
//
//   node scripts/preview/gen-test-backend.mjs [outDir]   → FlightControlTestBackend.gs + appsscript.json
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { NOW, feedEvents, syncedEvents, hotelRows } from '../../tests/fixtures/condor-feed.synthetic.mjs';

const backend = new URL('../../backend/apps-script/', import.meta.url);
// Same load order as the live project; DeparturesV2.gs is left out (no provider key, no departures action).
export const SOURCE_FILES = ['CondorAdapterV2.gs', 'RosterModelV2.gs', 'AirportsV2.gs', 'RosterApiV2.gs', 'RouterV2.gs', 'CondorCodesV2.gs'];
export const MODES = ['valid', 'timeout', 'malformed', 'empty', 'auth'];

export const MANIFEST = Object.freeze({
  timeZone: 'Europe/Berlin',
  runtimeVersion: 'V8',
  exceptionLogging: 'STACKDRIVER',
  webapp: { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_DEPLOYING' },
});

// Function declarations below replace the live ones above them (one file: the later declaration wins).
const TEST_SECTION = `
// ============================================================================
// SYNTHETIC TEST BACKEND — iPhone preview only. Never add this to the production project.
// ============================================================================
// Overrides fcv2LiveEnv_ and doPost from RosterApiV2.gs above: the synthetic fixture is shifted by
// whole days to today; no calendar, Sheet or provider is read.
// Script Properties (Project settings → Script properties):
//   FC_TEST_TOKEN  required; a throwaway random value, never the production token
//   FC_TEST_MODE   valid | timeout | malformed | empty | auth   (absent or anything else = valid)
// doGet (RouterV2.gs) answers getStats with "auth-required" because FC_V5_GET is never set here.
// ============================================================================

const FCT_DATA_ = __DATA__;
const FCT_DAY_MS_ = 86400000;
const FCT_SLEEP_MS_ = 30000;   // longer than the app's 25 s request timeout
const FCT_MODES_ = __MODES__;

function fctMode_() {
  const mode = PropertiesService.getScriptProperties().getProperty('FC_TEST_MODE');
  return FCT_MODES_.indexOf(mode) >= 0 ? mode : 'valid';
}

/** Whole days between the fixture's "now" and today (local times move with the dates). */
function fctShift_(now) {
  return Math.round((now - FCT_DATA_.fixtureNow) / FCT_DAY_MS_) * FCT_DAY_MS_;
}

function fctEvents_(list, shift, fromMs, toMs) {
  return list.map(function (e) { return Object.assign({}, e, { start: e.start + shift, end: e.end + shift }); })
    .filter(function (e) { return e.end > fromMs && e.start < toMs; });
}

/** The live Sheet rules over the synthetic rows: VERIFIED + name + airport + this stay's source id. */
function fctHotelLookup_(sourceId, name, airport) {
  if (!airport) return null;
  const norm = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
  const row = FCT_DATA_.rows.filter(function (r) {
    return norm(r[0]) === norm(name) && String(r[1] || '').trim().toUpperCase() === airport
      && String(r[10] || '').split('|').map(function (x) { return x.trim(); }).indexOf(String(sourceId)) >= 0
      && String(r[12] || '').trim() === 'VERIFIED';
  })[0];
  return row ? { lat: Number(row[4]), lon: Number(row[5]), mapsUrl: String(row[6] || '') || null, placeId: String(row[11] || '') || null } : null;
}

function fcv2LiveEnv_() {
  const config = FCV2_CONDOR_CONFIG_;
  const props = PropertiesService.getScriptProperties();
  const cache = CacheService.getScriptCache();
  const now = Date.now();
  const shift = fctShift_(now);
  const empty = fctMode_() === 'empty';
  return {
    config: config,
    token: function () { return props.getProperty('FC_TEST_TOKEN'); },
    now: function () { return now; },
    stats: function () { return { success: true, synthetic: true, upcoming: [], daysOff: [] }; },
    failures: {
      get: function () { return Number(cache.get('fcv2-failures') || 0); },
      add: function () { cache.put('fcv2-failures', String(Number(cache.get('fcv2-failures') || 0) + 1), 600); },
    },
    startOfDay: function (key) { return fcv2StartOfDay_(key, config.baseTimeZone); },
    airlineEvents: function (fromMs, toMs) { return empty ? [] : fctEvents_(FCT_DATA_.feed, shift, fromMs, toMs); },
    syncedEvents: function (fromMs, toMs) { return empty ? [] : fctEvents_(FCT_DATA_.synced, shift, fromMs, toMs); },
    // No history cache: every mode change must take effect at once.
    cacheGet: function () { return null; },
    cachePut: function () {},
    deps: {
      hash: fcv2Hash_,
      localIso: fcv2LocalIso_,
      localDate: fcv2LocalDate_,
      tzOf: function (iata) { return Object.prototype.hasOwnProperty.call(FCV2_AIRPORT_TZ_, iata) ? FCV2_AIRPORT_TZ_[iata] : null; },
      hotelLookup: fctHotelLookup_,
    },
  };
}

function doPost(e) {
  const mode = fctMode_();
  const body = e && e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : '';
  if (mode === 'timeout') Utilities.sleep(FCT_SLEEP_MS_);
  let result;
  if (mode === 'auth') {
    result = { ok: false, error: 'unauthorized' };
  } else {
    result = fcv2HandlePost_(body, fcv2LiveEnv_());
    if (mode === 'malformed' && result && result.ok === true && result.action === 'roster') {
      result = { ok: true, contract: FCV2_CONTRACT_, version: FCV2_VERSION_, action: 'roster', generatedAt: Date.now(), events: 'malformed' };
    }
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}
`;

/** The complete test-backend source (deterministic for a given repository state). */
export function generate() {
  const feed = feedEvents();
  const synced = syncedEvents();
  const data = { fixtureNow: NOW, feed, synced, rows: hotelRows(feed) };
  const sources = SOURCE_FILES.map((f) => `// ---- ${f} (unchanged copy from backend/apps-script) ----\n${readFileSync(new URL(f, backend), 'utf8')}`).join('\n\n');
  const head = '// GENERATED by scripts/preview/gen-test-backend.mjs. SYNTHETIC test backend for the iPhone preview.\n'
    + '// Do not edit by hand and never paste into the production Apps Script project.\n\n';
  return head + sources + TEST_SECTION.replace('__DATA__', JSON.stringify(data)).replace('__MODES__', JSON.stringify(MODES));
}

export function writeBackend(outDir) {
  const out = resolve(outDir);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'FlightControlTestBackend.gs'), generate());
  writeFileSync(join(out, 'appsscript.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`);
  return out;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const out = writeBackend(process.argv[2] ?? join(tmpdir(), `fc-test-backend-${Date.now()}`));
  console.log(`Synthetic test backend written to ${out} (FlightControlTestBackend.gs, appsscript.json). Not deployed.`);
}
