// iPhone preview tooling (docs/IPHONE-ACCEPTANCE.md): the staged site holds only the offline shell's
// files, and the generated SYNTHETIC test backend serves contract v2 that the real frontend accepts,
// with each failure mode the acceptance run needs. Nothing here deploys or contacts a network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { stage, precacheList, PREVIEW_CONFIG, ABOUT_LINE } from '../scripts/preview/stage.mjs';
import { generate, MANIFEST, MODES, generateFc66Acceptance, writeFc66Backend, readFc66Baseline, FC66_BASELINE } from '../scripts/preview/gen-test-backend.mjs';
import { localDate, localIso } from './gs-harness.js';
import { validateRoster, validateHistory } from '../src/sources/contract-v2.js';
import { adaptV2 } from '../src/sources/fc-appscript-v2.js';
import { NOW } from './fixtures/condor-feed.synthetic.mjs';
import { validateFlightInfo, adaptFlightInfo } from '../src/sources/flight-info-v2.js';
import { validateDepartures } from '../src/sources/departures-v2.js';
import { PROFILE } from './helpers.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

test('stage: only sw.js, the precached shell files and vercel.json; byte-identical copies', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'fc-stage-')), 'site');
  try {
    const { files } = stage(out);
    const assets = precacheList(readFileSync(join(root, 'sw.js'), 'utf8'));
    const expected = ['sw.js', 'vercel.json', ...assets.map((a) => a.path)].sort();
    const staged = walk(out).map((f) => relative(out, f).replaceAll('\\', '/')).sort();
    assert.deepEqual(staged, expected);
    assert.deepEqual(files, expected);
    for (const p of staged) {
      assert.ok(!/^(reference|docs|tests|backend|scripts|legacy|\.claude|\.git)\//.test(p), `${p} must not be staged`);
      if (p !== 'vercel.json') assert.ok(readFileSync(join(out, p)).equals(readFileSync(join(root, p))), `${p} copied unchanged`);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'vercel.json'), 'utf8')), JSON.parse(JSON.stringify(PREVIEW_CONFIG)));
  } finally { rmSync(dirname(out), { recursive: true, force: true }); }
});

test('stage: refuses a directory inside the repository or a non-empty directory', () => {
  assert.throws(() => stage(join(root, 'preview-site')), /inside the repository/);
  assert.throws(() => stage(root), /inside the repository/);
  const dir = mkdtempSync(join(tmpdir(), 'fc-stage-'));
  try {
    writeFileSync(join(dir, 'stray.txt'), 'x');
    assert.throws(() => stage(dir), /empty or absent/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('preview config: worker and entry document are revalidated; preview is not indexed', () => {
  const find = (source) => PREVIEW_CONFIG.headers.find((h) => h.source === source)?.headers ?? [];
  for (const source of ['/', '/index.html', '/sw.js']) assert.ok(find(source).some((h) => h.key === 'Cache-Control' && h.value === 'no-cache'), source);
  assert.ok(find('/(.*)').some((h) => h.key === 'X-Robots-Tag' && /noindex/.test(h.value)));
});

test('stage --label: preview builds A and B differ only in the About line and their regenerated, self-consistent sw.js', () => {
  const base = mkdtempSync(join(tmpdir(), 'fc-stage-label-'));
  try {
    const plain = stage(join(base, 'plain'));
    const a = stage(join(base, 'a'), { label: 'A' });
    const b = stage(join(base, 'b'), { label: 'B' });
    const repoVersion = readFileSync(join(root, 'sw.js'), 'utf8').match(/const VERSION = '([^']+)'/)[1];
    assert.ok(a.version && b.version && a.version !== b.version && a.version !== repoVersion && b.version !== repoVersion, 'three distinct cache versions');
    for (const [run, label] of [[a, 'A'], [b, 'B']]) {
      const dir = run.out;
      const settings = readFileSync(join(dir, 'src/ui/screens/settings.js'), 'utf8');
      assert.ok(settings.includes(`Version 2.0 · preview build ${label}`) && !settings.includes(ABOUT_LINE));
      const assets = precacheList(readFileSync(join(dir, 'sw.js'), 'utf8'));
      for (const asset of assets) assert.equal(createHash('sha256').update(readFileSync(join(dir, asset.path))).digest('hex'), asset.sha256, `${label}: ${asset.path} matches its staged hash`);
      const differing = walk(dir).map((f) => relative(dir, f)).filter((p) => !readFileSync(join(dir, p)).equals(readFileSync(join(plain.out, p))));
      assert.deepEqual(differing.sort(), ['src/ui/screens/settings.js', 'sw.js'], `${label}: only the About line and the worker differ`);
    }
    assert.ok(readFileSync(join(root, 'src/ui/screens/settings.js'), 'utf8').includes(ABOUT_LINE), 'the repository file is unchanged');
    assert.equal(plain.version, null);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('stage --label: rejects labels outside A-Z, 0-9 and "-"', () => {
  for (const label of ['', 'b', 'A B', '<x>', 'A'.repeat(13)]) assert.throws(() => stage(join(tmpdir(), `fc-never-${Date.now()}`), { label }), /build label/);
});

// --- Synthetic test backend ------------------------------------------------------------------

function loadBackend({ props = {}, now = Date.now(), code = generate(), tokenProperty = 'FC_TEST_TOKEN' } = {}) {
  const store = { ...props };
  const sleeps = [];
  const cache = new Map();
  const forbiddenCalls = [];
  const forbidden = new Proxy({}, { get(_target, key) { forbiddenCalls.push(key); throw new Error('Forbidden live service access'); } });
  const propertyReads = [];
  const sandbox = {
    console, CalendarApp: forbidden, SpreadsheetApp: forbidden, UrlFetchApp: forbidden, ScriptApp: forbidden,
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => { propertyReads.push(k); return k in store ? store[k] : null; } }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v) }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ text: s, setMimeType() { return this; } }) },
    Utilities: {
      formatDate(date, tz, pattern) {
        if (pattern === 'yyyy-MM-dd') return localDate(date.getTime(), tz);
        if (pattern === "yyyy-MM-dd'T'HH:mmXXX") return localIso(date.getTime(), tz).replace(/\+00:00$/, 'Z');
        throw new Error(`pattern not faked: ${pattern}`);
      },
      computeDigest: (_alg, text) => [...createHash('sha256').update(text).digest()].map((b) => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      sleep: (ms) => sleeps.push(ms),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const post = (action, token = props[tokenProperty], extra = {}) =>
    JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify({ contract: 'fc.roster', version: 2, action, token, ...extra }) } }).text);
  const get = (params) => JSON.parse(sandbox.doGet({ parameter: params }).text);
  return { post, get, sleeps, store, propertyReads, sandbox, forbiddenCalls };
}

const TOKEN = 'synthetic-preview-token-0123456789';

test('test backend: synthetic roster around today is accepted by the real frontend validator and adapter', () => {
  const now = Date.now();
  const b = loadBackend({ props: { FC_TEST_TOKEN: TOKEN }, now });
  const caps = b.post('capabilities');
  assert.equal(caps.ok, true);
  assert.deepEqual(caps.actions, ['capabilities', 'roster', 'history', 'stats', 'departures', 'flight']);
  const roster = b.post('roster');
  assert.equal(validateRoster(roster).ok, true, validateRoster(roster).reason);
  assert.ok(roster.sectors.length >= 5, 'flights present');
  assert.ok(roster.sectors.some((s) => s.dep > now), 'upcoming flights');
  assert.ok(roster.sectors.some((s) => s.aircraft), 'aircraft line parsed');
  assert.ok(roster.stays.some((s) => s.hotel?.location?.status === 'verified'), 'one verified synthetic hotel pin');
  const snapshot = adaptV2(roster, { profile: PROFILE, fetchedAt: now });
  assert.ok(snapshot.sectors.length >= 5);
  const history = b.post('history');
  assert.equal(validateHistory(history).ok, true);
  assert.equal(b.post('stats').success, true);
});

test('test backend: wrong or missing token, and no token configured, are refused', () => {
  const b = loadBackend({ props: { FC_TEST_TOKEN: TOKEN } });
  assert.equal(b.post('roster', 'wrong-token').error, 'unauthorized');
  assert.equal(b.post('roster', null).error, 'unauthorized');
  assert.equal(loadBackend().post('roster', TOKEN).error, 'not-configured');
});

test('test backend: modes timeout, malformed, empty and auth behave as the run sheet expects', () => {
  const props = { FC_TEST_TOKEN: TOKEN };
  const t = loadBackend({ props: { ...props, FC_TEST_MODE: 'timeout' } });
  assert.equal(t.post('roster').ok, true);
  assert.ok(t.sleeps[0] > 25000, 'sleeps beyond the 25 s client timeout');
  const m = loadBackend({ props: { ...props, FC_TEST_MODE: 'malformed' } }).post('roster');
  assert.equal(validateRoster(m).ok, false);
  const e = loadBackend({ props: { ...props, FC_TEST_MODE: 'empty' } }).post('roster');
  assert.equal(validateRoster(e).ok, true);
  assert.equal(e.events.length, 0);
  assert.equal(loadBackend({ props: { ...props, FC_TEST_MODE: 'auth' } }).post('capabilities').error, 'unauthorized');
  assert.equal(loadBackend({ props: { ...props, FC_TEST_MODE: 'nonsense' } }).post('roster').ok, true, 'unknown mode = valid');
  assert.deepEqual(MODES, ['valid', 'timeout', 'malformed', 'empty', 'auth']);
});

test('test backend: GET never serves data; manifest is an anonymous web app executing as the deployer', () => {
  const b = loadBackend({ props: { FC_TEST_TOKEN: TOKEN } });
  assert.equal(b.get({ action: 'getStats' }).error, 'auth-required');
  assert.equal(b.get({}).success, false);
  assert.deepEqual(MANIFEST.webapp, { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_DEPLOYING' });
});

test('test backend source: synthetic data only, no production configuration names are read', () => {
  const src = generate();
  const testSection = src.slice(src.indexOf('SYNTHETIC TEST BACKEND'));
  for (const name of ['SOURCE_CALENDAR_ID', 'TARGET_CALENDAR_ID', 'HOTEL_SPREADSHEET_ID', 'CalendarApp', 'SpreadsheetApp', 'UrlFetchApp', 'FC_V2_TOKEN'])
    assert.ok(!testSection.includes(name), `test section must not use ${name}`);
  assert.match(src, /Sample Riverside Hotel/);
});


const fixtureFlight = (roster) => {
  const s = roster.sectors.find((s) => s.flightNumber === 'DE9201');
  return { flightNumber: s.flightNumber, origin: s.origin, date: localDate(s.dep, 'Europe/Berlin') };
};

test('test backend: real gate/Radar contracts, attribution and current-date fixture linkage', () => {
  for (const now of [NOW, Date.parse('2026-10-15T08:00:00Z'), Date.parse('2026-10-25T08:00:00Z')]) {
    const b = loadBackend({ now, props: { FC_TEST_TOKEN: TOKEN } });
    const roster = b.post('roster');
    const request = fixtureFlight(roster);
    const flight = b.post('flight', TOKEN, request);
    assert.equal(validateFlightInfo(flight).ok, true, JSON.stringify(flight));
    assert.equal(flight.found, true);
    assert.equal(flight.flight.departure.gate, 'A 24');
    assert.equal(flight.flight.arrival.gate, '12');
    assert.equal(flight.flight.departure.airport, 'FRA');
    assert.equal(flight.flight.arrival.airport, 'BKK');
    assert.equal(adaptFlightInfo(flight, { now }).stale, false);
    assert.equal(flight.attribution.name, 'AeroDataBox');
    const overnight = roster.sectors.find((s) => s.flightNumber === 'DE9202');
    const back = b.post('flight', TOKEN, { flightNumber: overnight.flightNumber, origin: overnight.origin,
      date: localDate(overnight.dep, 'Asia/Bangkok') });
    assert.equal(validateFlightInfo(back).ok, true);
    assert.equal(back.found, true);
    assert.equal(back.flight.departure.scheduled, overnight.dep);
    assert.equal(back.flight.arrival.scheduled, overnight.arr);
    assert.equal(back.flight.departure.airport, 'BKK');
    assert.equal(back.flight.arrival.airport, 'FRA');
    assert.equal(b.post('flight', TOKEN, { ...request, date: localDate(now, 'Europe/Berlin') }).found, false, 'wrong date cannot borrow gates');
    const shift = Math.round((now - NOW) / 86400000) * 86400000;
    // Matches the fixture SB90 standby at BER, nine days after its anchor.
    const from = Date.parse('2026-10-13T02:55:00Z') + shift;
    const radar = b.post('departures', TOKEN, { airport: 'BER', from, to: from + 12 * 3600000, carriers: ['DE'] });
    assert.equal(validateDepartures(radar).ok, true, JSON.stringify(radar));
    assert.ok(radar.flights.some((f) => f.flightNumber === 'DE9301'));
    assert.equal(radar.attribution.name, 'AeroDataBox');
    const fraFrom = Date.parse('2026-10-16T02:55:00Z') + shift;
    const fra = b.post('departures', TOKEN, { airport: 'FRA', from: fraFrom, to: fraFrom + 10 * 3600000 });
    assert.ok(fra.flights.some((f) => f.flightNumber === 'DE9302'));
    assert.ok(b.propertyReads.every((k) => ['FC_TEST_TOKEN', 'FC_TEST_MODE', 'FC_TEST_PROVIDER_MODE'].includes(k)));
  }
});

test('test backend: missing, stale, not-found and provider errors preserve normal wire semantics', () => {
  const now = NOW;
  const range = { airport: 'BER', from: Date.parse('2026-10-13T02:55:00Z'), to: Date.parse('2026-10-13T14:55:00Z') };
  for (const mode of ['missing', 'stale', 'not-found', 'provider-error']) {
    const b = loadBackend({ now, props: { FC_TEST_TOKEN: TOKEN, FC_TEST_PROVIDER_MODE: mode } });
    const roster = b.post('roster');
    const flight = b.post('flight', TOKEN, fixtureFlight(roster));
    const radar = b.post('departures', TOKEN, range);
    if (mode === 'provider-error') {
      assert.equal(flight.error, 'provider-unavailable');
      assert.equal(radar.error, 'provider-unavailable');
    } else {
      assert.equal(validateFlightInfo(flight).ok, true, JSON.stringify(flight));
      assert.equal(validateDepartures(radar).ok, true, JSON.stringify(radar));
      if (mode === 'not-found') { assert.equal(flight.found, false); assert.equal(radar.flights.length, 0); }
      if (mode === 'stale') {
        assert.equal(adaptFlightInfo(flight, { now }).stale, true);
        assert.equal(radar.fetchedAt, now - 4 * 3600000);
      }
      if (mode === 'missing') {
        const view = adaptFlightInfo(flight, { now });
        assert.equal(view.departure.gateState, 'pending');
        assert.equal(view.arrival.gateState, 'unavailable');
        assert.equal(radar.flights[0].destination, null);
      }
    }
    assert.deepEqual(b.post('roster'), roster, 'provider mode never changes saved-roster input');
  }
});

test('test backend: provider fixtures and timeout injection are behind authentication, no live bindings shipped', () => {
  for (const mode of ['valid', 'timeout', 'auth', 'malformed', 'empty']) {
    const b = loadBackend({ now: NOW, props: { FC_TEST_TOKEN: TOKEN, FC_TEST_MODE: mode, FC_TEST_PROVIDER_MODE: 'provider-error' } });
    for (const action of ['flight', 'departures']) {
      assert.equal(b.post(action, 'wrong-token').error, 'unauthorized');
      assert.equal(b.post(action, null).error, 'unauthorized');
    }
    assert.deepEqual(b.sleeps, []);
    assert.ok(!b.propertyReads.includes('FC_TEST_PROVIDER_MODE'), 'rejected requests never select provider fixtures');
  }
  const code = generate().split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /CalendarApp|SpreadsheetApp|UrlFetchApp|ScriptApp/);
  assert.match(code, /synthetic-fixture-selector/);
});


// FC66 uses a deliberately invented token; no Keychain, property dump or live service is consulted.
const FC66_TOKEN = 'fc66_' + 'a'.repeat(64);
const FC66_REVOKED = 'fc66_' + 'b'.repeat(64);
const fc66Handler = readFileSync(new URL('../scripts/preview/fc66-handler.gs', import.meta.url), 'utf8');
const fc66Acceptance = generateFc66Acceptance();
// The exact reviewed snapshot is optional for portable unit tests. Release verification supplies
// FC66_BASELINE_DIR and additionally verifies pinned bytes, all legacy fixtures and generated files.
const fc66Baseline = process.env.FC66_BASELINE_DIR ? readFc66Baseline(process.env.FC66_BASELINE_DIR) : null;
const unitLegacy = loadBackend({ now: NOW, props: { FC_TEST_TOKEN: TOKEN } });
const unitFixture = Object.fromEntries(['capabilities', 'roster', 'history'].map((a) => [a, unitLegacy.post(a)]));
unitFixture.capabilities.actions = ['capabilities', 'roster', 'history'];
const fc66Fixtures = fc66Baseline?.['Fixtures.gs'].toString() ?? `const FC66_FIXTURES = ${JSON.stringify({ mixed: unitFixture })};`;
function compatibility(props = {}, now = NOW, code = fc66Handler) {
  return loadBackend({ props: { FC66_TEST_TOKEN: FC66_TOKEN, ...props }, now, tokenProperty: 'FC66_TEST_TOKEN',
    code: fc66Fixtures + '\n' + fc66Acceptance + '\n' + code });
}
const gateProps = { FC66_FIXTURE: 'gate-radar' };
const radarRange = { airport: 'BER', from: Date.parse('2026-10-13T02:55:00Z'), to: Date.parse('2026-10-13T14:55:00Z') };

test('FC66: exactly one public entry pair, no generic credential reads or live service bindings', () => {
  const code = fc66Handler + fc66Acceptance;
  for (const entry of ['doGet', 'doPost']) assert.equal((code.match(new RegExp('function ' + entry + '\\(', 'g')) || []).length, 1);
  assert.doesNotMatch(fc66Acceptance, /FC_TEST_TOKEN|FC_TEST_MODE|FC_TEST_PROVIDER_MODE|function do(?:Get|Post)\(/);
  assert.doesNotMatch(code.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n'), /CalendarApp|SpreadsheetApp|UrlFetchApp|ScriptApp|DriveApp|CacheService/);
  const b = compatibility(gateProps);
  const r = b.post('roster');
  assert.equal(b.post('flight', FC66_TOKEN, fixtureFlight(r)).found, true);
  assert.equal(b.post('departures', FC66_TOKEN, radarRange).ok, true);
  assert.deepEqual(b.forbiddenCalls, []);
  assert.ok(b.propertyReads.every((k) => ['FC66_TEST_TOKEN', 'FC66_FIXTURE', 'FC66_SCENARIO', 'FC66_PROVIDER_MODE'].includes(k)));
});

test('FC66: sole credential, format validation, bad/revoked credentials and body limits fail before dispatch', () => {
  for (const props of [{}, gateProps]) {
    const b = compatibility({ ...props, FC_TEST_TOKEN: FC66_REVOKED });
    let dispatches = 0;
    b.sandbox.fc66Acceptance_ = () => { dispatches++; throw new Error('Must not dispatch'); };
    for (const token of [null, '', 1, {}, FC66_REVOKED, 'wrong', 'fc66_' + 'a'.repeat(63)]) {
      assert.equal(b.post('flight', token).error, 'unauthorized');
    }
    for (const body of [null, '', '{', 'null', '[]', 'x'.repeat(16385)]) {
      assert.equal(JSON.parse(b.sandbox.doPost({ postData: { contents: body } }).text).error, 'bad-request');
    }
    assert.equal(b.post('flight', FC66_TOKEN, { version: 1 }).error, 'unsupported-contract');
    assert.equal(dispatches, 0);
    assert.ok(b.propertyReads.every((k) => k === 'FC66_TEST_TOKEN'));
  }
  for (const value of [null, '', 'fc66_' + 'A'.repeat(64), 'a'.repeat(64), 'fc66_' + 'a'.repeat(63)]) {
    assert.equal(compatibility({ ...gateProps, FC66_TEST_TOKEN: value, FC_TEST_TOKEN: FC66_TOKEN }).post('capabilities', FC66_TOKEN).error, 'not-configured');
  }
  assert.equal(compatibility(gateProps).post('capabilities').ok, true);
});

test('FC66: GET handshake, legacy defaults, action/range restrictions and mutation isolation unchanged', () => {
  const b = compatibility();
  assert.deepEqual(b.get({ action: 'getStats', token: FC66_TOKEN }), { success: false, error: 'auth-required', message: 'Authentication required.' });
  assert.deepEqual(b.get({}), { success: false, message: 'Not available.' });
  assert.deepEqual(b.post('capabilities').actions, ['capabilities', 'roster', 'history']);
  assert.equal(validateRoster(b.post('roster')).ok, true);
  for (const action of ['flight', 'departures', 'stats', 'setScenario']) assert.equal(b.post(action).error, 'unknown-action');
  assert.equal(b.post('roster', FC66_TOKEN, { from: '2026-10-01' }).error, 'bad-request');
  const original = b.post('roster');
  b.store.FC66_SCENARIO = 'empty'; b.post('roster');
  b.store.FC66_SCENARIO = 'valid'; assert.deepEqual(b.post('roster'), original);
  assert.deepEqual(b.post('roster', FC66_TOKEN, { fixture: 'gate-radar', FC66_FIXTURE: 'gate-radar' }), original);
});

test('FC66: legacy scenario semantics also wrap new fixture, including history and capabilities exceptions', () => {
  for (const fixture of ['mixed', 'gate-radar']) {
    const b = compatibility({ FC66_FIXTURE: fixture });
    for (const scenario of ['expired', 'server-error', 'throw', 'malformed', 'empty']) {
      b.store.FC66_SCENARIO = scenario;
      for (const action of ['roster', 'history']) {
        if (scenario === 'throw') { assert.throws(() => b.post(action), /Synthetic Step 6.6 server failure/); continue; }
        const response = b.post(action);
        if (scenario === 'expired') assert.equal(response.error, 'unauthorized');
        if (scenario === 'server-error') assert.equal(response.error, 'internal-error');
        if (scenario === 'malformed') assert.equal(response.sectors, null);
        if (scenario === 'empty') assert.deepEqual(response.sectors, []);
      }
      const caps = b.post('capabilities');
      assert.equal(scenario === 'expired' ? caps.error : caps.ok, scenario === 'expired' ? 'unauthorized' : true);
      assert.equal(b.post('roster', FC66_REVOKED).error, 'unauthorized', 'auth precedes every scenario');
    }
    assert.deepEqual(b.forbiddenCalls, []);
  }
  const b = compatibility({ ...gateProps, FC66_SCENARIO: 'server-error' });
  for (const action of ['flight', 'departures']) assert.equal(b.post(action).error, 'internal-error');
});

test('FC66: invalid operator selections fail closed; request fields cannot override them', () => {
  for (const props of [{ FC66_FIXTURE: '__proto__' }, { FC66_SCENARIO: 'timeout' }, { ...gateProps, FC66_PROVIDER_MODE: 'unknown' }]) {
    const b = compatibility(props);
    assert.equal(b.post('capabilities', FC66_TOKEN, { FC66_SCENARIO: 'valid', FC66_PROVIDER_MODE: 'gates', FC66_FIXTURE: 'gate-radar' }).error, 'not-configured');
  }
  const b = compatibility({ ...gateProps, FC66_PROVIDER_MODE: 'provider-error', FC_TEST_PROVIDER_MODE: 'gates' });
  assert.equal(b.post('flight', FC66_TOKEN, { ...fixtureFlight(b.post('roster')), mode: 'gates', FC66_PROVIDER_MODE: 'gates' }).error, 'provider-unavailable');
});

test('FC66: gated flight/Radar fixtures validate, preserve roster and handle missing/stale/error states', () => {
  for (const now of [NOW, Date.parse('2026-10-15T08:00:00Z'), Date.parse('2026-10-25T08:00:00Z')]) {
    const shift = Math.round((now - NOW) / 86400000) * 86400000;
    for (const mode of ['gates', 'missing', 'stale', 'not-found', 'provider-error']) {
      const b = compatibility({ ...gateProps, FC66_PROVIDER_MODE: mode }, now);
      assert.deepEqual(b.post('capabilities').actions, ['capabilities', 'roster', 'history', 'departures', 'flight']);
      assert.equal(b.post('stats').error, 'unknown-action');
      const roster = b.post('roster');
      assert.equal(validateRoster(roster).ok, true);
      assert.equal(validateHistory(b.post('history')).ok, true);
      const flight = b.post('flight', FC66_TOKEN, fixtureFlight(roster));
      const departures = b.post('departures', FC66_TOKEN, { ...radarRange, from: radarRange.from + shift, to: radarRange.to + shift });
      if (mode === 'provider-error') {
        assert.equal(flight.error, 'provider-unavailable'); assert.equal(departures.error, 'provider-unavailable');
      } else {
        assert.equal(validateFlightInfo(flight).ok, true);
        assert.equal(validateDepartures(departures).ok, true);
        assert.equal(flight.attribution.name, 'AeroDataBox'); assert.equal(departures.attribution.name, 'AeroDataBox');
        if (mode === 'not-found') { assert.equal(flight.found, false); assert.deepEqual(departures.flights, []); }
        else {
          const view = adaptFlightInfo(flight, { now });
          assert.equal(view.stale, mode === 'stale');
          assert.equal(view.departure.gateState, mode === 'missing' ? 'pending' : 'available');
          assert.equal(view.arrival.gateState, mode === 'missing' ? 'unavailable' : 'available');
          assert.ok(departures.flights.some((f) => f.flightNumber === 'DE9301'));
          if (mode === 'gates') {
            assert.equal(flight.flight.departure.gate, 'A 24'); assert.equal(flight.flight.arrival.gate, '12');
            const back = roster.sectors.find((s) => s.flightNumber === 'DE9202');
            const result = b.post('flight', FC66_TOKEN, { flightNumber: back.flightNumber, origin: back.origin, date: localDate(back.dep, 'Asia/Bangkok') });
            assert.equal(result.flight.departure.scheduled, back.dep); assert.equal(result.flight.arrival.scheduled, back.arr);
            assert.equal(result.flight.departure.airport, 'BKK'); assert.equal(result.flight.arrival.airport, 'FRA');
          }
        }
      }
      assert.deepEqual(b.post('roster'), roster);
      assert.deepEqual(b.forbiddenCalls, []);
    }
  }
});

if (fc66Baseline) {
  test('FC66 release baseline: authentication boundary and complete legacy responses match original wrapper', () => {
    const original = fc66Baseline['Code.gs'].toString();
    const auth = (source) => source.slice(source.indexOf('function fc66Json_'), source.indexOf("  if (!['capabilities'"));
    assert.equal(auth(fc66Handler), auth(original), 'GET, comparison and authentication code preserved verbatim');
    for (const fixture of ['mixed', 'nonflight', 'dst-spring', 'dst-autumn']) {
      for (const scenario of ['valid', 'expired', 'malformed', 'empty', 'server-error', 'throw']) {
        const props = { FC66_FIXTURE: fixture, FC66_SCENARIO: scenario };
        const candidate = compatibility(props), reference = compatibility(props, NOW, original);
        for (const action of ['capabilities', 'roster', 'history']) {
          const outcome = (b) => { try { return b.post(action); } catch (error) { return { thrown: error.message }; } };
          assert.deepEqual(outcome(candidate), outcome(reference), `${fixture}/${scenario}/${action}`);
        }
      }
    }
  });

  test('FC66 release output: four files, exact legacy bytes, deterministic helpers, no credentials', () => {
    const base = mkdtempSync(join(tmpdir(), 'fc66-output-'));
    try {
      const out = join(base, 'candidate');
      const result = writeFc66Backend(out, process.env.FC66_BASELINE_DIR);
      assert.deepEqual(readdirSync(out).sort(), ['AcceptanceV2.gs', 'Code.gs', 'Fixtures.gs', 'appsscript.json']);
      for (const file of ['Fixtures.gs', 'appsscript.json']) assert.ok(readFileSync(join(out, file)).equals(fc66Baseline[file]));
      assert.equal(readFileSync(join(out, 'AcceptanceV2.gs'), 'utf8'), fc66Acceptance);
      for (const [file, hash] of Object.entries(result.hashes)) assert.equal(createHash('sha256').update(readFileSync(join(out, file))).digest('hex'), hash);
      const manifest = JSON.parse(readFileSync(join(out, 'appsscript.json')));
      assert.deepEqual(manifest.oauthScopes, []); assert.equal(manifest.exceptionLogging, 'NONE');
      const code = readFileSync(join(out, 'Code.gs'), 'utf8');
      assert.ok(!code.includes(FC66_TOKEN) && !fc66Acceptance.includes(FC66_TOKEN));
      assert.equal(compatibility(gateProps, NOW, code).post('roster').ok, true);
      assert.throws(() => writeFc66Backend(out, process.env.FC66_BASELINE_DIR), /empty or absent/);
      assert.throws(() => writeFc66Backend(join(root, 'fc66-output-forbidden'), process.env.FC66_BASELINE_DIR), /outside repository/);
      assert.throws(() => writeFc66Backend(process.env.FC66_BASELINE_DIR, process.env.FC66_BASELINE_DIR), /outside repository/);
      symlinkSync(root, join(base, 'linked-repo'));
      assert.throws(() => writeFc66Backend(join(base, 'linked-repo', 'forbidden'), process.env.FC66_BASELINE_DIR), /outside repository/);
      for (const name of Object.keys(FC66_BASELINE)) {
        const altered = join(base, name.replaceAll('.', '-')); mkdirSync(altered);
        for (const [file, bytes] of Object.entries(fc66Baseline)) writeFileSync(join(altered, file), file === name ? Buffer.concat([bytes, Buffer.from('\n')]) : bytes);
        const destination = join(base, `refused-${name}`);
        assert.throws(() => writeFc66Backend(destination, altered), /baseline differs/);
        assert.equal(existsSync(destination), false, 'no output after invalid baseline');
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}
