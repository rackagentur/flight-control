// Generates the SYNTHETIC Apps Script test backend for the iPhone preview (docs/IPHONE-ACCEPTANCE.md):
// the pure fc.roster v2 handlers followed by a test environment over the repository's synthetic
// Condor fixture, shifted to the current date. It reads no calendar, Sheet or provider and holds no
// production identifier or token. This script only writes files; it never deploys.
//
//   node scripts/preview/gen-test-backend.mjs [outDir]   → generic two-file backend
//   node scripts/preview/gen-test-backend.mjs --fc66 <reviewed-baseline-dir> <new-output-dir>
//     → Code.gs + AcceptanceV2.gs + unchanged Fixtures.gs/appsscript.json (existing FC66 project)
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, relative, isAbsolute, basename, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { NOW, feedEvents, syncedEvents, hotelRows } from '../../tests/fixtures/condor-feed.synthetic.mjs';

const backend = new URL('../../backend/apps-script/', import.meta.url);
// Pure handlers only. Live bindings and the v5 router are omitted from the generated artifact.
export const SOURCE_FILES = ['CondorAdapterV2.gs', 'RosterModelV2.gs', 'AirportsV2.gs', 'RosterApiV2.gs', 'CondorCodesV2.gs', 'DeparturesV2.gs', 'FlightInfoV2.gs'];
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
//   FC_TEST_PROVIDER_MODE   gates | missing | stale | not-found | provider-error (default gates)
// doGet always answers auth-required. The provider is an in-memory fixture selector only.
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
    departuresKey: function () { return 'synthetic-fixture-selector'; }, // not a credential
    providerFetch: function (url) { return fctProvider_(url, now, props.getProperty('FC_TEST_PROVIDER_MODE') || 'gates'); },
    sleep: function () {}, // no provider retry waits or requests
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

  let result;
  if (mode === 'auth') {
    result = { ok: false, error: 'unauthorized' };
  } else {
    result = fcv2HandlePost_(body, fcv2LiveEnv_());
    // Fault injection happens only after the normal authentication/contract checks succeed.
    if (result && result.ok === true && mode === 'timeout') Utilities.sleep(FCT_SLEEP_MS_);
    if (result && result.ok === true && ['flight', 'departures'].indexOf(result.action) >= 0
        && PropertiesService.getScriptProperties().getProperty('FC_TEST_PROVIDER_MODE') === 'stale') {
      result.fetchedAt = Date.now() - 4 * 3600000;
      if (result.flight) result.flight.lastUpdated = Date.now() - 8 * 3600000;
    }
    if (mode === 'malformed' && result && result.ok === true && result.action === 'roster') {
      result = { ok: true, contract: FCV2_CONTRACT_, version: FCV2_VERSION_, action: 'roster', generatedAt: Date.now(), events: 'malformed' };
    }
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ success: false, error: 'auth-required' })).setMimeType(ContentService.MimeType.JSON);
}
`;

/** Return a uniquely delimited source section or fail closed when upstream layout changes. */
function sourceBetween(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0 || source.indexOf(start, a + start.length) >= 0 || source.indexOf(end, b + end.length) >= 0)
    throw new Error('Synthetic source boundary changed; review generator');
  return source.slice(a, b);
}

/** The complete test-backend source (deterministic for a given repository state). */
function fixtureData() {
  const feed = feedEvents();
  const synced = syncedEvents();
  const radar = feed.filter((e) => ['SB90', 'RE5'].includes(e.title)).map((e, i) => ({
    number: `DE93${String(i + 1).padStart(2, '0')}`, origin: e.title === 'SB90' ? 'BER' : 'FRA',
    destination: 'PMI', dep: e.start + 2 * 3600000,
  }));
  return { fixtureNow: NOW, feed, synced, rows: hotelRows(feed), radar };
}

function pureSources({ omitEntryPoint = false } = {}) {
  return SOURCE_FILES.map((f) => {
    let source = readFileSync(new URL(f, backend), 'utf8');
    if (f === 'RosterApiV2.gs') {
      // Keep request/auth/model helpers; omit all live calendar/Sheet/HTTP bindings.
      const boundary = source.indexOf('function fcv2RawEvent_(');
      if (boundary < 0 || source.lastIndexOf('function fcv2RawEvent_(') !== boundary) throw new Error('RosterApiV2 pure-helper boundary changed; review generator');
      source = source.slice(0, boundary);
      if (omitEntryPoint) {
        source = source.replace(sourceBetween(source, 'function doPost(e) {', '/** Constant-time comparison'), '');
      }
    }
    return `// ---- ${f} (pure handlers/helpers; live bindings omitted) ----\n${source}`;
  }).join('\n\n');
}

export function generate() {
  const sources = pureSources(), data = fixtureData();
  const head = '// GENERATED by scripts/preview/gen-test-backend.mjs. SYNTHETIC test backend for the iPhone preview.\n'
    + '// Do not edit by hand and never paste into the production Apps Script project.\n\n';
  return head + sources + TEST_SECTION.replace('__DATA__', JSON.stringify(data)).replace('__MODES__', JSON.stringify(MODES))
    + readFileSync(new URL('./provider-fixtures.gs', import.meta.url), 'utf8');
}

export function writeBackend(outDir) {
  const out = resolve(outDir);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'FlightControlTestBackend.gs'), generate());
  writeFileSync(join(out, 'appsscript.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`);
  return out;
}

// FC66 profile: the existing wrapper remains the only public request entry point.
const FC66_ENV = `
function fc66Acceptance_(request, properties, providerMode) {
  const config = FCV2_CONDOR_CONFIG_, now = Date.now(), shift = fctShift_(now);
  const env = {
    config: config, token: function () { return properties.getProperty('FC66_TEST_TOKEN'); },
    now: function () { return now; },
    // Outer FC66 authentication already refused invalid credentials; no new auth policy/cache.
    failures: { get: function () { return 0; }, add: function () {} },
    startOfDay: function (key) { return fcv2StartOfDay_(key, config.baseTimeZone); },
    airlineEvents: function (from, to) { return fctEvents_(FCT_DATA_.feed, shift, from, to); },
    syncedEvents: function (from, to) { return fctEvents_(FCT_DATA_.synced, shift, from, to); },
    departuresKey: function () { return 'synthetic-fixture-selector'; },
    providerFetch: function (url) { return fctProvider_(url, now, providerMode); },
    sleep: function () {}, cacheGet: function () { return null; }, cachePut: function () {},
    deps: { hash: fcv2Hash_, localIso: fcv2LocalIso_, localDate: fcv2LocalDate_,
      tzOf: function (iata) { return Object.prototype.hasOwnProperty.call(FCV2_AIRPORT_TZ_, iata) ? FCV2_AIRPORT_TZ_[iata] : null; },
      hotelLookup: fctHotelLookup_ },
  };
  const response = fcv2HandlePost_(JSON.stringify(request), env);
  if (response.ok === true && response.action === 'capabilities') response.actions = response.actions.filter(function (a) { return a !== 'stats'; });
  if (response.ok === true && ['flight', 'departures'].indexOf(response.action) >= 0 && providerMode === 'stale') {
    response.fetchedAt = now - 4 * 3600000;
    if (response.flight) response.flight.lastUpdated = now - 8 * 3600000;
  }
  return response;
}
`;

export function generateFc66Acceptance() {
  const helpers = sourceBetween(TEST_SECTION, '/** Whole days', 'function fcv2LiveEnv_()');
  return '// GENERATED SYNTHETIC FC66 acceptance helpers. No public entry points or live bindings.\n'
    + pureSources({ omitEntryPoint: true })
    + `\nconst FCT_DATA_ = ${JSON.stringify(fixtureData())};\nconst FCT_DAY_MS_ = 86400000;\n`
    + helpers + FC66_ENV + readFileSync(new URL('./provider-fixtures.gs', import.meta.url), 'utf8');
}

// Pinned reviewed version-1 source bytes, not credentials. A different baseline requires review.
export const FC66_BASELINE = Object.freeze({
  'Code.gs': 'bc36bc585c3c17b695c5cf433171dc980b5cd50da62520ff6e8536630eabf72b',
  'Fixtures.gs': '293d576f39c00f2947e24949834808ec53dbc2626c3db75ddb6f125729fb4103',
  'appsscript.json': '4431940bf5056996cddf51b8496bcd680ce74d95d630e2508d9f7d7b2c123716',
});
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function readFc66Baseline(baseDir) {
  return Object.fromEntries(Object.entries(FC66_BASELINE).map(([file, expected]) => {
    const bytes = readFileSync(join(baseDir, file));
    if (digest(bytes) !== expected) throw new Error(`FC66 baseline differs: ${file}; review before generating`);
    return [file, bytes];
  }));
}

/** Local only. Keeps the legacy snapshots and manifest byte-identical; never reads properties. */
export function writeFc66Backend(outDir, baseDir) {
  const baseline = readFc66Baseline(baseDir);
  const source = generateFc66Acceptance(); // validate source boundaries before writing anything
  const out = resolve(outDir), repo = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
  const outside = (parent, child) => { const rel = relative(parent, child); return rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel); };
  // Resolve existing ancestors to refuse an output symlink back into the repository or snapshot.
  let ancestor = out;
  const suffix = [];
  while (!existsSync(ancestor)) { suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
  const destination = resolve(realpathSync(ancestor), ...suffix);
  if (!outside(repo, destination) || !outside(realpathSync(baseDir), destination)) throw new Error('FC66 output must be outside repository and baseline');
  if (existsSync(out) && readdirSync(out).length) throw new Error('FC66 output must be empty or absent');
  const files = {
    'Code.gs': readFileSync(new URL('./fc66-handler.gs', import.meta.url)),
    'AcceptanceV2.gs': Buffer.from(source),
    'Fixtures.gs': baseline['Fixtures.gs'],
    'appsscript.json': baseline['appsscript.json'],
  };
  mkdirSync(out, { recursive: true });
  for (const [file, bytes] of Object.entries(files)) writeFileSync(join(out, file), bytes, { flag: 'wx' });
  return { out, hashes: Object.fromEntries(Object.entries(files).map(([file, bytes]) => [file, digest(bytes)])) };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--fc66') {
    if (process.argv.length !== 5) throw new Error('Usage: gen-test-backend.mjs --fc66 <reviewed-baseline-dir> <new-output-dir>');
    console.log(JSON.stringify(writeFc66Backend(process.argv[4], process.argv[3]), null, 2));
  } else {
    const out = writeBackend(process.argv[2] ?? join(tmpdir(), `fc-test-backend-${Date.now()}`));
    console.log(`Synthetic test backend written to ${out} (FlightControlTestBackend.gs, appsscript.json). Not deployed.`);
  }
}
