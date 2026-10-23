// The isolated Apps Script test package (backend/apps-script-test/, scripts/gas-test/): two bundles the owner pastes
// by hand into two NEW Apps Script projects to test Crew Intelligence V2.3 against real Apps Script services.
// Everything here runs in Node against fake services (tests/fixtures/gas-test-fakes.mjs) and loads the BUILT
// bundle strings (buildApi / buildSeeder), never the raw files. Synthetic data only; nothing is deployed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  buildApi, buildSeeder, manifestText, checkedOutDir, writePackage, beginBanner, endBanner,
  PRODUCTION_FILES, API_TEST_FILES, SEEDER_TEST_FILES, API_SCOPES, SEEDER_SCOPES, KIND_PRODUCTION, KIND_TEST,
} from '../scripts/gas-test/build-test-package.mjs';
import { hashId } from '../scripts/gas-test/hash-id.mjs';
import { localDate, localIso } from './gs-harness.js';
import {
  makeWorld, servicesFor, loadBundle, apiProps, seederProps, sha, hex, IDS, NAMES, MARKER, OWNER, SELF,
  SCOPE_READ, SCOPE_WRITE, SCOPE_EMAIL, crashAfter, failBefore, afterNth, afterNthRead, beforeOp, clearHooks,
} from './fixtures/gas-test-fakes.mjs';

const ROOT = new URL('../', import.meta.url);
const PROD = new URL('backend/apps-script/', ROOT);
const TESTSRC = new URL('backend/apps-script-test/', ROOT);
const NOW = Date.parse('2026-10-23T09:00:00Z');
const TODAY = '2026-10-23';
const plain = (x) => JSON.parse(JSON.stringify(x));          // values from the vm realm -> this realm
const api = buildApi();
const seeder = buildSeeder();
const API_MANIFEST = JSON.parse(api.manifest);
const SEEDER_MANIFEST = JSON.parse(seeder.manifest);

const API_NAMES = ['doPost', 'doGet', 'getFlightStats', 'fctIsolation_', 'fctCalendar_', 'fctPrepare_', 'fctEnv_', 'fctHandle_', 'fctDeps_', 'fctDenyList_',
  'fctSha256_', 'fctCheckSetup', 'fctFixture_', 'fctSynthId_', 'fctBerlinDayStart_', 'fctSmokeRun_', 'fctSmokeCtx_', 'fctRunSmoke', 'fctRunSmokeAfterChange',
  'fctRunSmokeFinish', 'fctRunSmokeResume', 'fctRestoreState', 'crewPurgeAll', 'fcv2HandlePost_', 'fcv2LiveEnv_', 'fcv2CrewParseLines_', 'fcv2CrewSealableMonths_',
  'FCV2_CONDOR_CONFIG_', 'FCV2_AIRPORT_TZ_', 'fcv2CrewLiveEnv_', 'fcv2ClassifyEvent_', 'fcv2CrewNormalizeEvent_', 'fcv2ParseDescription_'];
const SEEDER_NAMES = ['doPost', 'fctIsolation_', 'fctSeederIsolation_', 'fctCalendar_', 'fctSeedAll', 'fctSeedDryRun', 'fctApplyScheduleChange', 'fctRemoveSeeded',
  'fctSeedAllCounts_', 'fctCheckSetup', 'fctFixture_', 'fctDeps_', 'fcv2HandlePost_', 'fctSeedGuarded_', 'fctSeedOwned_', 'fctSeedProof_',
  'fctSeedMarkerLine_', 'fctSeedDescription_', 'fctSeedRequiredTags_', 'fctSeedTagsComplete_', 'fctSeedKeyStatus_', 'fctCalendar_', 'fctSha256_'];

/** The API project over a world: services with the manifest's scopes, the built bundle loaded. */
function apiProject({ world = makeWorld(), props = apiProps(), clock = { t: NOW }, scopes = API_MANIFEST.oauthScopes, email = OWNER, user = {}, lockBusy = false, tweak = null } = {}) {
  const svc = servicesFor(world, { scopes, script: props, user, email, clock, lockBusy });
  if (tweak) tweak(svc.globals);
  const { t, sandbox } = loadBundle(api.source, svc.globals, API_NAMES);
  const rawPost = (body) => t.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } });
  const post = (body) => JSON.parse(rawPost(body).text);
  const call = (action, extra = {}) => post({ contract: 'fc.roster', version: 2, token: props.FC_V2_TOKEN, action, ...extra });
  return { world, svc, t, sandbox, clock, props, rawPost, post, call, spies: svc.spies, state: () => JSON.parse(svc.scriptProps.map.get('FC_CREW_STATE') ?? 'null') };
}

/** The seeder project over the same world. carry: an earlier seeder project of the SAME installation (its seeder-managed properties persist). */
function seederProject({ world = makeWorld(), props = seederProps(), clock = { t: NOW }, carry = null, lockBusy = false } = {}) {
  if (carry) {
    for (const k of ['FCT_SEED_ANCHOR', 'FCT_SEED_INSTALL']) if (carry.svc.scriptProps.map.has(k)) props = { ...props, [k]: carry.svc.scriptProps.map.get(k) };
  }
  const svc = servicesFor(world, { scopes: SEEDER_MANIFEST.oauthScopes, script: props, clock, lockBusy });
  const { t, sandbox } = loadBundle(seeder.source, svc.globals, SEEDER_NAMES);
  return { world, svc, t, sandbox, spies: svc.spies, props, install: () => svc.scriptProps.map.get('FCT_SEED_INSTALL') };
}

const lines = (spies) => spies.console.map((l) => JSON.parse(l));
const calendarEvents = (world, id) => world.calendars.get(id).events;
/** Independent recomputation of the ownership proof and the first description line (never calls the bundle). */
const proofOf = (install, role, key) => sha(`fct-own|${install}|${role}|${key}`).slice(0, 32);
const markerLine = (install, role, key) => `fct-own:${role}:${key}:${proofOf(install, role, key)}`;
/** A seeded world: the seeder project has run once. */
function seededWorld() {
  const world = makeWorld();
  const s = seederProject({ world });
  const r = s.t.fctSeedAll();
  assert.equal(r.ok, true);
  return { world, seeder: s, seedResult: plain(r) };
}
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`\\])\/\/[^\n]*/g, '$1');

// --- Package structure ---------------------------------------------------------------------------------------

function embedded(bundleSource, kind, name, dir) {
  const text = readFileSync(new URL(name, dir), 'utf8');
  const digest = createHash('sha256').update(text).digest('hex');
  const begin = `${beginBanner(kind, name, digest)}\n`;
  const at = bundleSource.indexOf(begin);
  assert.ok(at >= 0, `${name}: begin banner`);
  const end = bundleSource.indexOf(endBanner(kind, name), at);
  assert.ok(end > at, `${name}: end banner`);
  return { text, body: bundleSource.slice(at + begin.length, end), at };
}

test('API bundle embeds every production file byte-identical, in the stated order, followed by the test-only sources', () => {
  assert.deepEqual([...PRODUCTION_FILES], ['CondorAdapterV2.gs', 'RosterModelV2.gs', 'AirportsV2.gs', 'CondorCodesV2.gs', 'RosterApiV2.gs', 'RouterV2.gs',
    'DeparturesV2.gs', 'FlightInfoV2.gs', 'CrewCoreV2.gs', 'CrewCondorV2.gs', 'CrewApiV2.gs']);
  assert.deepEqual([...API_TEST_FILES], ['TestGuardV2.gs', 'TestFixturesV2.gs', 'TestSmokeV2.gs']);
  let last = -1;
  for (const name of PRODUCTION_FILES) {
    const e = embedded(api.source, KIND_PRODUCTION, name, PROD);
    assert.equal(e.body, e.text, `${name} byte-identical`);
    assert.ok(e.at > last, `${name} in order`);
    last = e.at;
  }
  for (const name of API_TEST_FILES) {
    const e = embedded(api.source, KIND_TEST, name, TESTSRC);
    assert.equal(e.body, e.text, `${name} byte-identical`);
    assert.ok(e.at > last, `${name} after the production files, in order`);
    last = e.at;
  }
  assert.equal(api.source.includes('TestSeederV2.gs'), false, 'no seeder source in the API bundle');
  assert.ok(api.source.startsWith('// ====') && api.source.includes('NEVER paste this into the production Apps Script project'));
});

test('seeder bundle holds only the guard, the fixture and the seeder (no production source)', () => {
  let last = -1;
  for (const name of SEEDER_TEST_FILES) {
    const e = embedded(seeder.source, KIND_TEST, name, TESTSRC);
    assert.equal(e.body, e.text);
    assert.ok(e.at > last);
    last = e.at;
  }
  assert.equal(seeder.source.includes(KIND_PRODUCTION), false);
  for (const name of PRODUCTION_FILES) assert.equal(seeder.source.includes(`: ${name} (`), false, name);
  assert.equal(seeder.source.includes('TestSmokeV2.gs'), false);
});

test('manifests: exact scopes, runtime and web-app settings', () => {
  assert.deepEqual(API_MANIFEST, {
    timeZone: 'Europe/Berlin', runtimeVersion: 'V8', exceptionLogging: 'STACKDRIVER',
    oauthScopes: ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/userinfo.email'],
    webapp: { executeAs: 'USER_DEPLOYING', access: 'MYSELF' },
  });
  assert.deepEqual(SEEDER_MANIFEST, {
    timeZone: 'Europe/Berlin', runtimeVersion: 'V8', exceptionLogging: 'STACKDRIVER',
    oauthScopes: ['https://www.googleapis.com/auth/calendar'],
  });
  assert.deepEqual([...API_SCOPES], API_MANIFEST.oauthScopes);
  assert.deepEqual([...SEEDER_SCOPES], SEEDER_MANIFEST.oauthScopes);
  assert.equal('webapp' in SEEDER_MANIFEST, false, 'the seeder is not a web app');
  assert.equal(API_MANIFEST.oauthScopes.some((s) => /external_request|scriptapp|spreadsheets|\/drive|gmail|mail\.google/.test(s)), false);
});

test('the build is deterministic, and the MANIFEST lists a sha256 for every source and output file', () => {
  const again = buildApi();
  assert.equal(again.source, api.source);
  const text = manifestText(api, seeder);
  assert.equal(manifestText(buildApi(), buildSeeder()), text, 'no timestamps');
  for (const name of PRODUCTION_FILES) {
    const digest = createHash('sha256').update(readFileSync(new URL(name, PROD))).digest('hex');
    assert.ok(text.includes(`${digest}  backend/apps-script/${name}`), name);
  }
  for (const name of [...API_TEST_FILES, ...SEEDER_TEST_FILES]) {
    const digest = createHash('sha256').update(readFileSync(new URL(name, TESTSRC))).digest('hex');
    assert.ok(text.includes(`${digest}  backend/apps-script-test/${name}`), name);
  }
  assert.ok(text.includes(`${createHash('sha256').update(api.source).digest('hex')}  api/FcTestApi.gs`));
  assert.ok(text.includes(`${createHash('sha256').update(seeder.source).digest('hex')}  seeder/FcTestSeeder.gs`));
});

test('the writer refuses an output inside the repository or a non-empty directory, and writes the five files elsewhere', () => {
  const repo = new URL('./', ROOT).pathname;
  assert.throws(() => checkedOutDir(join(repo, 'pkg-out')), /outside the repository/);
  assert.throws(() => checkedOutDir(join(repo, 'tests', 'new', 'deeper')), /outside the repository/);
  assert.throws(() => checkedOutDir(''), /Usage/);
  const dir = mkdtempSync(join(tmpdir(), 'fc-gas-pkg-'));
  try {
    const out = join(dir, 'pkg');
    const written = writePackage(out);
    assert.equal(written.out, out);
    assert.equal(readFileSync(join(out, 'api', 'FcTestApi.gs'), 'utf8'), api.source);
    assert.equal(readFileSync(join(out, 'api', 'appsscript.json'), 'utf8'), api.manifest);
    assert.equal(readFileSync(join(out, 'seeder', 'FcTestSeeder.gs'), 'utf8'), seeder.source);
    assert.equal(readFileSync(join(out, 'seeder', 'appsscript.json'), 'utf8'), seeder.manifest);
    assert.equal(readFileSync(join(out, 'MANIFEST.txt'), 'utf8'), manifestText(api, seeder));
    assert.throws(() => writePackage(out), /empty or absent/);
    // The CLI entry point behaves the same.
    const second = join(dir, 'cli');
    const run = spawnSync(process.execPath, [new URL('scripts/gas-test/build-test-package.mjs', ROOT).pathname, second], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(existsSync(join(second, 'api', 'FcTestApi.gs')));
    const refused = spawnSync(process.execPath, [new URL('scripts/gas-test/build-test-package.mjs', ROOT).pathname, join(repo, 'pkg-out')], { encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.equal(existsSync(join(repo, 'pkg-out')), false, 'nothing created inside the repository');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hash-id: SHA-256 of one id, from stdin only', () => {
  assert.equal(hashId('  some-id \n'), sha('some-id'));
  assert.throws(() => hashId(''), /empty/);
  assert.throws(() => hashId('a\nb'), /one line/);
  const script = new URL('scripts/gas-test/hash-id.mjs', ROOT).pathname;
  const ok = spawnSync(process.execPath, [script], { input: 'fake-id-for-the-test\n', encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), sha('fake-id-for-the-test'));
  const viaArgv = spawnSync(process.execPath, [script, 'fake-id'], { input: '', encoding: 'utf8' });
  assert.equal(viaArgv.status, 2, 'an id on the command line is refused');
  assert.equal(spawnSync(process.execPath, [script], { input: '', encoding: 'utf8' }).status, 1);
});

// --- Static properties of the sources -------------------------------------------------------------------------

test('test sources hold no trigger, mail, drive, spreadsheet, calendar-creation or network call; only the seeder writes events', () => {
  const sources = Object.fromEntries([...API_TEST_FILES, ...SEEDER_TEST_FILES].map((n) => [n, stripComments(readFileSync(new URL(n, TESTSRC), 'utf8'))]));
  for (const [name, code] of Object.entries(sources)) {
    for (const forbidden of ['ScriptApp', 'newTrigger', 'createCalendar', 'MailApp', 'GmailApp', 'DriveApp', 'SpreadsheetApp', 'UrlFetchApp', 'HtmlService', 'CalendarApp.create', 'subscribeToCalendar']) {
      assert.equal(code.includes(forbidden), false, `${name} uses ${forbidden}`);
    }
  }
  const writes = ['createEvent', 'setTag', 'setTime', 'setDescription', 'deleteEvent', 'setTitle', 'setLocation'];
  for (const name of ['TestGuardV2.gs', 'TestFixturesV2.gs', 'TestSmokeV2.gs']) {
    for (const w of writes) assert.equal(sources[name].includes(`.${w}(`), false, `${name} must not call ${w}`);
  }
  for (const w of ['createEvent', 'setTag', 'deleteEvent']) assert.ok(sources['TestSeederV2.gs'].includes(`.${w}(`), `the seeder uses ${w}`);
  // The whole API bundle (production sources included) never writes an event either.
  const apiCode = stripComments(api.source);
  for (const w of writes) assert.equal(apiCode.includes(`.${w}(`), false, `API bundle calls ${w}`);
  assert.equal(/\bScriptApp\b|\bnewTrigger\b|\bMailApp\b|\bDriveApp\b|createCalendar/.test(apiCode), false);
});

test('top level of every test source is declarations only (no service access at load time)', () => {
  // The bundles load in a sandbox that has NO services at all: any top-level service access would throw.
  assert.doesNotThrow(() => loadBundle(api.source, {}, API_NAMES));
  assert.doesNotThrow(() => loadBundle(seeder.source, {}, SEEDER_NAMES));
  for (const name of [...API_TEST_FILES, ...SEEDER_TEST_FILES]) {
    const code = stripComments(readFileSync(new URL(name, TESTSRC), 'utf8'));
    const topLevelCalls = code.split('\n').filter((l) => /^(?!\s|function|const|var|let|\}|\]|\)|\/|$)/.test(l));
    assert.deepEqual(topLevelCalls, [], `${name}: unexpected top-level statements`);
  }
});

test('every test-source name starts with fct and ends in an underscore, except the editor entry points and doPost/getFlightStats', () => {
  const entry = new Set(['fctCheckSetup', 'fctSeedAll', 'fctSeedDryRun', 'fctApplyScheduleChange', 'fctRemoveSeeded', 'fctRunSmoke', 'fctRunSmokeAfterChange',
    'fctRunSmokeFinish', 'fctRunSmokeResume', 'fctRestoreState', 'doPost', 'getFlightStats']);
  for (const name of [...API_TEST_FILES, ...SEEDER_TEST_FILES]) {
    const code = readFileSync(new URL(name, TESTSRC), 'utf8');
    for (const m of code.matchAll(/^function (\w+)\(/gm)) assert.ok(entry.has(m[1]) || /^fct\w*_$/.test(m[1]), `${name}: ${m[1]}`);
    for (const m of code.matchAll(/^(?:const|let) (\w+)/gm)) assert.ok(/^FCT_\w+_$/.test(m[1]), `${name}: ${m[1]}`);
  }
});

test('Script Properties template documents exactly the properties the sources read', () => {
  const template = readFileSync(new URL('script-properties.template.md', TESTSRC), 'utf8');
  const documented = new Set([...template.matchAll(/^\|\s*`((?:FCT|FC)_[A-Z0-9_]+|PLACES_API_KEY)`/gm)].map((m) => m[1]));
  const used = new Set();
  const scan = (code) => { for (const m of code.matchAll(/'((?:FCT|FC)_[A-Z0-9_]+)'/g)) used.add(m[1]); };
  for (const name of [...API_TEST_FILES, ...SEEDER_TEST_FILES]) scan(readFileSync(new URL(name, TESTSRC), 'utf8'));
  for (const name of ['RosterApiV2.gs', 'CrewApiV2.gs', 'RouterV2.gs']) scan(readFileSync(new URL(name, PROD), 'utf8'));
  used.add('PLACES_API_KEY');
  // The Node-only constants of the production sources that are not Script Properties.
  for (const notProperty of ['FCT_ISOLATED_VALUE_']) used.delete(notProperty);
  const missing = [...used].filter((n) => !documented.has(n) && !n.endsWith('_'));
  assert.deepEqual(missing, [], 'used but undocumented');
  const unused = [...documented].filter((n) => !used.has(n));
  assert.deepEqual(unused, [], 'documented but never read');
  assert.ok(template.includes('openssl rand -hex 32') && template.includes('pbcopy'));
  assert.ok(template.includes('owner@example.invalid') && template.includes('fctest_<64 hex>'));
});

// --- Fixture --------------------------------------------------------------------------------------------------

test('fixtures: deterministic, anchor-independent flight numbers, no pattern literals in any source or bundle', () => {
  const p = apiProject();
  const a = plain(p.t.fctFixture_(TODAY));
  assert.deepEqual(plain(p.t.fctFixture_(TODAY)), a, 'deterministic');
  const b = plain(p.t.fctFixture_('2027-05-09'));
  const numbers = (fx) => Object.fromEntries([...fx.feed, ...fx.synced].filter((e) => /^[A-Z]{2}\d/.test(e.title.replace(/^\S*✈️\s/, '').replace(/^✈️+\s*/, '')) && !/^X\d/.test(e.key)).map((e) => [e.key, e.title.replace(/^(✈️)+ /, '')]));
  assert.deepEqual(numbers(a), numbers(b), 'a flight keeps its number whichever day the fixture is built for');
  // Hygiene patterns (copied from tests/repo-hygiene.test.js) over every file of the package and the built bundles.
  const patterns = [
    /script\.google\.com\/(?:a\/macros\/[^/\s]+|macros)\/s\/[A-Za-z0-9_-]{20,}/, /[a-z0-9]{16,}(?:@|%40)(?:import\.|group\.)?calendar\.google\.com/i,
    /docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]{20,}/, /AIza[0-9A-Za-z_-]{35}/, /\b\d{6}[A-Z]\b/, /[A-Za-z0-9._%+-]+@(?:gmail|googlemail)\.com/,
  ];
  const files = [
    ...readdirSync(TESTSRC).map((n) => new URL(n, TESTSRC)),
    ...readdirSync(new URL('scripts/gas-test/', ROOT)).map((n) => new URL(`scripts/gas-test/${n}`, ROOT)),
    new URL('tests/gas-test-package.test.js', ROOT), new URL('tests/fixtures/gas-test-fakes.mjs', ROOT), new URL('docs/CREW-GAS-TEST-SETUP.md', ROOT),
  ];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const re of patterns) assert.equal(re.test(text), false, `${f.pathname}: ${re}`);
    for (const email of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z.]+/g) ?? []) assert.match(email, /@(example|fake)\.invalid$/, `${f.pathname}: ${email}`);
  }
  for (const re of patterns) assert.equal(re.test(api.source), false, `API bundle: ${re}`);
  for (const re of patterns) assert.equal(re.test(seeder.source), false, `seeder bundle: ${re}`);
  // At run time the synthetic ids exist only in the "99 + four digits + X" form, and names are letters only.
  const text = JSON.stringify([a.feed, a.synced]);
  const ids = new Set(text.match(/\b\d{6}[A-Z]\b/g));
  assert.ok(ids.size > 5);
  for (const id of ids) assert.match(id, /^99\d{4}X$/);
  assert.equal(a.selfId, SELF);
  // Names are letters only; the one deliberate exception is the invalid-record line (a digit in a name) in F5 and HA2.
  for (const e of [...a.feed, ...a.synced]) {
    const digits = e.description.match(/(TESTCREW|SAMPLE)[A-Z]+\d/g) ?? [];
    assert.equal(digits.length, ['F5', 'HA2'].includes(e.key) ? 1 : 0, `${e.key}: a name with a digit`);
  }
  assert.equal(/@/.test(text), false, 'no address in any event');
});

test('fixtures: crew lists parse as designed with the production parser (valid, none, invalid records, duplicate, over-long, no owner)', () => {
  const p = apiProject();
  const fx = plain(p.t.fctFixture_(TODAY));
  const byKey = Object.fromEntries([...fx.feed, ...fx.synced].map((e) => [e.key, e]));
  const orig = (e) => (e.description.includes('Original Notes:\n') ? e.description.split('Original Notes:\n')[1] : e.description);
  const parse = (key) => plain(p.t.fcv2CrewParseLines_(orig(byKey[key]), p.t.FCV2_CONDOR_CONFIG_));
  const f1 = parse('F1o');
  assert.equal(f1.length, 6);
  assert.equal(f1[0].id, SELF);
  assert.equal(new Set(f1.map((c) => c.id)).size, 6);
  assert.equal(parse('F4'), null, 'a flight without a crew list');
  assert.equal(parse('HA1'), null);
  const f5 = parse('F5');
  assert.equal(f5.filter((c) => c.parseFailed).length, 2, 'a malformed rank line and a name with a digit');
  assert.equal(f5.filter((c) => !c.parseFailed && c.id === null).length, 1, 'a line without an id');
  assert.equal(f5.filter((c) => c.id === f1[1].id).length, 1, 'the duplicate id is kept once');
  assert.equal(f5.length, 6);
  const longest = Math.max(...orig(byKey.F5).split('\n').map((l) => l.length));
  assert.ok(longest > 120, 'one line is over 120 characters (ignored by the parser)');
  assert.equal(f5.some((c) => c.family === 'TESTCREWAF' || c.given === 'SAMPLEAF'), false, 'the over-long line adds no member');
  const ha3 = parse('HA3');
  assert.equal(ha3.some((c) => c.id === SELF), false, 'a crew list without the owner');
  // The synced copy wraps the original text and decorates the title; the classifier strips the decoration.
  const synced = fx.synced[0];
  assert.ok(synced.title.startsWith('✈️✈️✈️ '));
  assert.ok(synced.description.includes('Original Notes:\n'));
});

test('fixtures: five months of history before the anchor (four always sealable), feed from the day after, no overlaps, any anchor', () => {
  const p = apiProject();
  const berlin = (ms) => localDate(ms, 'Europe/Berlin');
  const anchors = ['2026-10-23', '2026-01-01', '2026-03-28', '2026-10-25', '2027-03-27', '2027-03-29', '2026-11-01', '2028-02-29', '2026-12-31'];
  for (const anchor of anchors) {
    const fx = plain(p.t.fctFixture_(anchor));
    const start = Date.parse(`${anchor}T00:00:00Z`);
    assert.ok(fx.synced.every((e) => e.end < start), `${anchor}: history ends before the anchor day`);
    assert.ok(fx.feed.every((e) => e.start >= start + 86400000 - 3600000 * 2), `${anchor}: feed starts after the anchor day`);
    const flights = [...fx.feed, ...fx.synced].filter((e) => /DE\d{4} /.test(e.title)).sort((x, y) => x.start - y.start);
    for (let i = 1; i < flights.length; i++) assert.ok(flights[i].start >= flights[i - 1].end, `${anchor}: flights ${flights[i - 1].key} and ${flights[i].key} overlap`);
    const months = new Set(fx.synced.map((e) => berlin(e.start).slice(0, 7)));
    const sealable = plain(p.t.fcv2CrewSealableMonths_(p.t.FCV2_CONDOR_CONFIG_, anchor));
    // anchor-2 .. anchor-5 are sealable on any anchor day; each holds several recorded duties.
    for (let k = 2; k <= 5; k++) {
      const month = new Date(Date.UTC(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)) - 1 - k, 1)).toISOString().slice(0, 7);
      assert.ok(months.has(month) && sealable.includes(month), `${anchor}: month ${month}`);
      assert.ok(fx.synced.filter((e) => berlin(e.start).startsWith(month)).length >= 10, `${anchor}: ${month} holds history`);
    }
    assert.ok(fx.synced.some((e) => e.key.startsWith('HR')), 'recent days before the anchor');
    for (const e of [...fx.feed, ...fx.synced]) assert.ok(e.start < e.end, e.key);
    assert.equal(new Set([...fx.feed, ...fx.synced].map((e) => e.key)).size, fx.feed.length + fx.synced.length, `${anchor}: unique keys`);
  }
});

test('fixtures: time zones and daylight saving (east, west, half-hour zone, local midnight, EU and North America dates)', () => {
  const p = apiProject();
  const fx = plain(p.t.fctFixture_(TODAY));
  const all = [...fx.feed, ...fx.synced];
  const tzOf = (iata) => p.t.FCV2_AIRPORT_TZ_[iata];
  const bySector = (flightNumber) => all.find((e) => e.title.endsWith(' ') ? false : e.title.replace(/^(✈️)+ /, '').startsWith(`${flightNumber} `));
  const offset = (iso) => iso.slice(-6);
  for (const z of fx.expect.zones) {
    const e = bySector(z.flightNumber);
    const [, from, to] = e.title.replace(/^(✈️)+ /, '').match(/^\S+ ([A-Z]{3})-([A-Z]{3})/);
    // Independent of the bundle: the Intl-based harness computes the local time of each end.
    if (z.depOffset) assert.equal(offset(localIso(e.start, tzOf(from))), z.depOffset, `${z.key} departure`);
    if (z.arrOffset) assert.equal(offset(localIso(e.end, tzOf(to))), z.arrOffset, `${z.key} arrival`);
    if (z.dayShift !== undefined) assert.equal((Date.parse(`${localDate(e.end, tzOf(to))}T00:00:00Z`) - Date.parse(`${localDate(e.start, tzOf(from))}T00:00:00Z`)) / 86400000, z.dayShift, `${z.key} day shift`);
  }
  const keys = fx.expect.zones.map((z) => z.key);
  assert.ok(['F3o', 'F6r', 'X1', 'X2', 'X3', 'X4'].every((k) => keys.includes(k)));
  // Local dates of the fixed daylight-saving events.
  const x1 = bySector(fx.expect.zones.find((z) => z.key === 'X1').flightNumber);
  assert.equal(localDate(x1.start, 'Europe/Berlin'), '2026-10-25');
  const x2 = bySector(fx.expect.zones.find((z) => z.key === 'X2').flightNumber);
  assert.equal(localDate(x2.start, 'Europe/Berlin'), '2027-03-28');
  const x3 = bySector(fx.expect.zones.find((z) => z.key === 'X3').flightNumber);
  assert.equal(localDate(x3.start, 'America/Toronto'), '2026-11-01');
  // Eastbound (BKK), westbound (YYZ), half-hour zone (CMB) in the history; one flight crosses UTC and Berlin midnight.
  const dests = new Set(fx.synced.map((e) => (e.title.match(/-([A-Z]{3})$/) ?? [])[1]));
  for (const d of ['BKK', 'YYZ', 'CMB']) assert.ok(dests.has(d), d);
  assert.ok(all.some((e) => /DE\d{4} /.test(e.title) && localDate(e.start, 'UTC') !== localDate(e.end, 'UTC') && localDate(e.start, 'Europe/Berlin') !== localDate(e.end, 'Europe/Berlin')));
  // Berlin day starts: 25 h after the autumn change, 23 h after the spring change, 24 h otherwise.
  const day = (a, b) => (p.t.fctBerlinDayStart_(b) - p.t.fctBerlinDayStart_(a)) / 3600000;
  assert.equal(day('2026-10-25', '2026-10-26'), 25);
  assert.equal(day('2027-03-28', '2027-03-29'), 23);
  assert.equal(day('2026-07-01', '2026-07-02'), 24);
  assert.equal(day('2027-01-10', '2027-01-11'), 24);
  for (const e of all.filter((x) => ['OFF', 'U'].includes(x.title))) assert.equal(e.start, p.t.fctBerlinDayStart_(localDate(e.start + 3 * 3600000, 'Europe/Berlin')));
});

// --- Guard ----------------------------------------------------------------------------------------------------

const propsOf = (o) => ({ get: (k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null) });
const bad = (n) => ['31', '0000', 'A'].join('').slice(0, n);   // a production-shaped employee number, built at run time

test('isolation: every refusal has its stable reason code; the configured project passes', () => {
  const { t } = apiProject();
  const ok = apiProps();
  assert.deepEqual(plain(t.fctIsolation_(propsOf(ok))), { ok: true });
  const cases = [
    ['not-isolated', { FCT_ISOLATED: undefined }], ['not-isolated', { FCT_ISOLATED: 'yes' }], ['not-isolated', { FCT_ISOLATED: 'fc-test-isolated-v2' }],
    ['production-property', { FC_ADB_RAPIDAPI_KEY: 'k' }], ['production-property', { PLACES_API_KEY: 'k' }], ['production-property', { FC_V5_GET: 'open' }],
    ['production-property', { FC_ADB_RAPIDAPI_KEY: '' }],
    ['token-format', { FC_V2_TOKEN: undefined }], ['token-format', { FC_V2_TOKEN: hex('t') }], ['token-format', { FC_V2_TOKEN: `fctest_${hex('t').slice(1)}` }],
    ['token-format', { FC_V2_TOKEN: `fctest_${hex('t').toUpperCase()}` }], ['token-format', { FC_V2_TOKEN: `fctest_${hex('t')}0` }],
    ['pepper-format', { FC_CREW_PEPPER: hex('p') }], ['pepper-format', { FC_CREW_PEPPER: 'fctest_pepper_short' }], ['pepper-format', { FC_CREW_PEPPER: `fctest_${hex('p')}` }],
    ['self-format', { FC_CREW_SELF: bad(7) }], ['self-format', { FC_CREW_SELF: '990000x' }], ['self-format', { FC_CREW_SELF: '99000X' }], ['self-format', { FC_CREW_SELF: '' }],
    ['marker-missing', { FCT_MARKER: undefined }], ['marker-missing', { FCT_MARKER: 'abc' }], ['marker-missing', { FCT_MARKER: hex('m', 32).toUpperCase() }],
    ['denylist-missing', { FCT_DENY_SHA256: undefined }], ['denylist-missing', { FCT_DENY_SHA256: sha('a') }], ['denylist-missing', { FCT_DENY_SHA256: `${sha('a')},${sha('a')}` }],
    ['denylist-missing', { FCT_DENY_SHA256: `${sha('a')},${sha('b').toUpperCase()}` }], ['denylist-missing', { FCT_DENY_SHA256: `${sha('a')},not-a-hash` }],
    ['denylist-missing', { FCT_DENY_SHA256: '' }],
  ];
  for (const [reason, over] of cases) {
    const props = { ...ok, ...over };
    for (const k of Object.keys(props)) if (props[k] === undefined) delete props[k];
    assert.deepEqual(plain(t.fctIsolation_(propsOf(props))), { ok: false, reason }, `${reason}: ${JSON.stringify(Object.keys(over))}`);
  }
  // Optional secrets may be absent.
  const noOptional = { ...ok };
  delete noOptional.FC_CREW_PEPPER;
  delete noOptional.FC_CREW_SELF;
  assert.deepEqual(plain(t.fctIsolation_(propsOf(noOptional))), { ok: true });
  // Reasons are checked in a fixed order: not-isolated comes first whatever else is wrong.
  assert.equal(t.fctIsolation_(propsOf({})).reason, 'not-isolated');
});

function guardDeps(project, over = {}) {
  const merged = { ...project.props, ...over };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return { calendarApp: project.sandbox.CalendarApp, props: propsOf(merged), hash: project.t.fctSha256_ };
}
const guardCode = (project, role, over, mutate) => {
  const restore = mutate ? mutate(project.world) : null;
  try {
    project.t.fctCalendar_(role, guardDeps(project, over));
    return null;
  } catch (err) {
    assert.equal(JSON.stringify(err), JSON.stringify({ fctGuard: err.fctGuard }), 'the thrown value holds nothing but the code');
    assert.equal(project.spies.console.length, 0, 'nothing logged');
    return err.fctGuard;
  } finally {
    if (restore) restore();
  }
};

test('calendar guard: each refusal throws a bare code (denied hash, wrong name, no marker, not owned, same id twice, missing id, missing calendar, errors)', () => {
  const p = apiProject();
  for (const role of ['feed', 'synced']) assert.equal(guardCode(p, role, {}), null, `${role} passes`);
  assert.equal(p.t.fctCalendar_('feed', guardDeps(p)).id, IDS.feed);
  assert.equal(p.t.fctCalendar_('synced', guardDeps(p)).id, IDS.synced);
  const rename = (id, name) => (w) => { const c = w.calendars.get(id); const old = c.name; c.name = name; return () => { c.name = old; }; };
  const describe = (id, description) => (w) => { const c = w.calendars.get(id); const old = c.description; c.description = description; return () => { c.description = old; }; };
  const own = (id, owned) => (w) => { const c = w.calendars.get(id); const old = c.owned; c.owned = owned; return () => { c.owned = old; }; };
  const none = {};
  const denyOf = (...ids) => ({ FCT_DENY_SHA256: ids.map(sha).join(',') });
  assert.equal(guardCode(p, 'feed', denyOf(IDS.feed, IDS.prodSynced), null), 'calendar-denied');
  assert.equal(guardCode(p, 'synced', denyOf(IDS.synced, IDS.prodSynced), null), 'calendar-denied');
  assert.equal(guardCode(p, 'feed', denyOf(IDS.synced, IDS.prodSynced), null), 'calendar-denied', 'a denied id in the OTHER slot refuses too');
  assert.equal(guardCode(p, 'feed', { FCT_CAL_FEED_ID: IDS.prodFeed }), 'calendar-denied', 'the production-like id is on the deny list');
  assert.equal(guardCode(p, 'feed', { FCT_CAL_FEED_ID: IDS.prodFeed, ...denyOf(IDS.personal, IDS.prodSynced) }), 'calendar-name', 'a calendar missing from the deny list is still refused by its name');
  assert.equal(guardCode(p, 'feed', none, rename(IDS.feed, 'FC-TEST Airline Feed ')), 'calendar-name');
  assert.equal(guardCode(p, 'feed', none, rename(IDS.feed, 'fc-test airline feed')), 'calendar-name');
  assert.equal(guardCode(p, 'synced', none, rename(IDS.synced, NAMES.feed)), 'calendar-name', 'names are not interchangeable');
  assert.equal(guardCode(p, 'feed', none, describe(IDS.feed, 'no marker here')), 'calendar-marker');
  assert.equal(guardCode(p, 'feed', none, describe(IDS.feed, `fc-test-marker:${hex('other', 32)}`)), 'calendar-marker');
  assert.equal(guardCode(p, 'feed', none, describe(IDS.feed, MARKER)), 'calendar-marker', 'the line prefix is required');
  assert.equal(guardCode(p, 'synced', none, own(IDS.synced, false)), 'calendar-not-owned');
  assert.equal(guardCode(p, 'feed', { FCT_CAL_SYNCED_ID: IDS.feed }), 'calendar-ids-equal');
  assert.equal(guardCode(p, 'feed', { FCT_CAL_FEED_ID: undefined }), 'calendar-id-missing');
  assert.equal(guardCode(p, 'synced', { FCT_CAL_SYNCED_ID: undefined }), 'calendar-id-missing');
  assert.equal(guardCode(p, 'feed', { FCT_CAL_FEED_ID: '' }), 'calendar-id-missing');
  assert.equal(guardCode(p, 'feed', { FCT_CAL_FEED_ID: 'no-such-calendar' }), 'calendar-missing');
  assert.equal(guardCode(p, 'feed', { FCT_DENY_SHA256: undefined }), 'denylist-missing');
  assert.equal(guardCode(p, 'feed', { FCT_MARKER: 'xyz' }), 'marker-missing');
  assert.equal(guardCode(p, 'other', {}), 'bad-role');
  // Service errors become codes and never carry the message (which holds an id).
  p.svc.faults.lookup = true;
  assert.equal(guardCode(p, 'feed', {}), 'calendar-error');
  p.svc.faults.lookup = false;
  const throwing = guardDeps(p);
  throwing.calendarApp = { getCalendarById: () => ({ getName: () => { throw new Error(`secret ${IDS.feed}`); } }) };
  assert.throws(() => p.t.fctCalendar_('feed', throwing), (e) => e.fctGuard === 'calendar-error' && !JSON.stringify(e).includes(IDS.feed));
  throwing.calendarApp = p.sandbox.CalendarApp;
  throwing.hash = () => { throw new Error('digest'); };
  assert.throws(() => p.t.fctCalendar_('feed', throwing), (e) => e.fctGuard === 'hash-error');
  // A read-only scope still permits the guard's reads.
  assert.deepEqual(p.spies.denied, []);
});

test('prepare: the production constants point at nothing until the guard passed, and are assigned only on success', () => {
  const p = apiProject({ props: apiProps({ FCT_MARKER: undefined }) });
  assert.equal(p.sandbox.SOURCE_CALENDAR_ID, 'FCTEST-UNSET');
  assert.equal(p.sandbox.TARGET_CALENDAR_ID, 'FCTEST-UNSET');
  assert.equal(p.sandbox.HOTEL_SPREADSHEET_ID, 'FCTEST-NO-SHEET');
  assert.equal(p.sandbox.HOTEL_SHEET_NAME, 'FCTEST-NO-SHEET');
  assert.equal(p.sandbox.SYNC_PROPERTY_KEY, 'FCTEST_SYNC_SOURCE_ID', 'a distinct tag: a production synced calendar would yield no tagged event');
  assert.throws(() => p.t.fctPrepare_(), (e) => e.fctGuard === 'marker-missing');
  assert.equal(p.sandbox.SOURCE_CALENDAR_ID, 'FCTEST-UNSET');
  // An unguarded production path fails closed: the unset id resolves to no calendar.
  assert.throws(() => p.t.fcv2LiveEnv_().airlineEvents(0, 1));
  assert.throws(() => p.t.fcv2LiveEnv_().syncedEvents(0, 1));
  const ok = apiProject();
  ok.t.fctPrepare_();
  assert.equal(ok.sandbox.SOURCE_CALENDAR_ID, IDS.feed);
  assert.equal(ok.sandbox.TARGET_CALENDAR_ID, IDS.synced);
  // A calendar failure after a valid isolation leaves the constants unset too.
  const failing = apiProject({ world: (() => { const w = makeWorld(); w.calendars.get(IDS.synced).name = 'Something else'; return w; })() });
  assert.throws(() => failing.t.fctPrepare_(), (e) => e.fctGuard === 'calendar-name');
  assert.equal(failing.sandbox.SOURCE_CALENDAR_ID, 'FCTEST-UNSET', 'not even the feed id is assigned when the synced calendar fails');
});

test('doPost: every guard refusal answers not-configured and never says why, leaks no id, name or reason', () => {
  const broken = [
    apiProps({ FCT_ISOLATED: undefined }), apiProps({ FC_ADB_RAPIDAPI_KEY: 'k' }), apiProps({ FC_V2_TOKEN: hex('t') }), apiProps({ FCT_MARKER: undefined }),
    apiProps({ FCT_DENY_SHA256: `${sha(IDS.feed)},${sha(IDS.prodSynced)}` }), apiProps({ FCT_CAL_FEED_ID: 'missing-calendar' }), apiProps({ FCT_CAL_SYNCED_ID: IDS.feed }),
    {},
  ];
  for (const props of broken) {
    const p = apiProject({ props });
    const body = JSON.stringify({ contract: 'fc.roster', version: 2, token: props.FC_V2_TOKEN ?? 'x', action: 'capabilities' });
    const out = p.rawPost(body);
    assert.equal(out.text, '{"ok":false,"error":"not-configured"}');
    assert.equal(out.mime, 'application/json');
    for (const secret of [IDS.feed, IDS.synced, IDS.prodFeed, NAMES.feed, MARKER, 'fctGuard', 'reason']) assert.equal(out.text.includes(secret), false);
    assert.deepEqual(p.spies.console, []);
  }
  for (const bodyText of ['', 'not json', '{"a":1}', 'x'.repeat(9000)]) {
    assert.equal(apiProject({ props: apiProps({ FCT_ISOLATED: undefined }) }).rawPost(bodyText).text, '{"ok":false,"error":"not-configured"}');
  }
  // GET is refused by the unchanged production router and never reaches a calendar.
  const p = apiProject();
  assert.deepEqual(JSON.parse(p.t.doGet({ parameter: { action: 'getStats' } }).text), { success: false, error: 'auth-required', message: 'Authentication required.' });
  assert.deepEqual(JSON.parse(p.t.doGet({ parameter: { action: 'anything' } }).text), { success: false, message: 'Not available.' });
  assert.deepEqual(plain(p.t.getFlightStats()), { success: true, synthetic: true });
  assert.deepEqual(p.spies.reads, []);
});

test('hardening: no network is reachable, provider actions are neither offered nor served, the hotel Sheet is never opened', () => {
  const { world } = seededWorld();
  const p = apiProject({ world });
  const env = p.t.fctEnv_();
  assert.throws(() => env.providerFetch('https://example.invalid', 'key'), /fctest-no-network/);
  assert.equal(env.departuresKey(), null);
  assert.deepEqual(plain(env.stats()), { success: true, synthetic: true });
  assert.equal(env.deps.hotelLookup('src', 'Sample Riverside Hotel', 'CMB'), null);
  const caps = p.call('capabilities');
  assert.equal(caps.ok, true);
  assert.equal(caps.actions.includes('departures') || caps.actions.includes('flight'), false);
  assert.equal(p.call('departures', { airport: 'FRA', from: NOW, to: NOW + 3600000 }).error, 'departures-not-configured');
  assert.equal(p.call('flight', { flightNumber: 'DE9201', date: TODAY, origin: 'FRA' }).error, 'flight-not-configured');
  assert.deepEqual(p.call('stats'), { success: true, synthetic: true });
  // A roster with hotel blocks resolves no hotel lookup through the Sheet.
  const roster = p.call('roster', { from: '2026-10-24', to: '2026-12-20' });
  assert.equal(roster.ok, true);
  assert.ok(roster.stays.length > 0, 'the fixture holds layovers with a hotel block');
  assert.equal(p.spies.fetch, 0);
  assert.equal(p.spies.spreadsheet, 0);
  assert.deepEqual(p.spies.denied, []);
  // A production-only key would break isolation (the provider can never be switched on in this project).
  assert.equal(apiProject({ world, props: apiProps({ FC_ADB_RAPIDAPI_KEY: 'k' }) }).call('capabilities').error, 'not-configured');
  // The roster tags only the synthetic sync tag.
  assert.ok(p.spies.reads.every(([id]) => id === IDS.feed || id === IDS.synced), 'only the two guarded calendars are read');
});

// --- Seeder ---------------------------------------------------------------------------------------------------

test('seeder: refuses without isolation, confirmation or a passing calendar guard, and writes nothing then', () => {
  const cases = [
    [seederProps({ FCT_SEED_CONFIRM: undefined }), 'confirm-missing'], [seederProps({ FCT_SEED_CONFIRM: 'yes' }), 'confirm-missing'],
    [seederProps({ FCT_ISOLATED: undefined }), 'not-isolated'], [seederProps({ FC_V5_GET: 'open' }), 'production-property'],
    [seederProps({ PLACES_API_KEY: 'k' }), 'production-property'], [seederProps({ FCT_MARKER: undefined }), 'marker-missing'],
    [seederProps({ FCT_DENY_SHA256: sha('only-one') }), 'denylist-missing'],
    [seederProps({ FCT_DENY_SHA256: `${sha(IDS.feed)},${sha(IDS.prodSynced)}` }), 'calendar-denied'],
    [seederProps({ FCT_CAL_SYNCED_ID: IDS.feed }), 'calendar-ids-equal'], [seederProps({ FCT_CAL_FEED_ID: IDS.personal }), 'calendar-name'],
    [seederProps({ FCT_CAL_FEED_ID: IDS.prodFeed, FCT_DENY_SHA256: `${sha(IDS.personal)},${sha(IDS.prodSynced)}` }), 'calendar-name'],
  ];
  for (const [props, reason] of cases) {
    const s = seederProject({ props });
    for (const fn of ['fctSeedAll', 'fctSeedDryRun', 'fctApplyScheduleChange', 'fctRemoveSeeded']) {
      const r = plain(s.t[fn]());
      assert.equal(r.ok, false, `${reason}: ${fn}`);
      assert.equal(r.reason, reason, `${reason}: ${fn}`);
    }
    assert.deepEqual(s.world.writes, [], reason);
    assert.ok(s.world.calendars.get(IDS.prodFeed).events.length === 0 && s.world.calendars.get(IDS.personal).events.length === 0);
    for (const line of s.spies.console) for (const secret of [IDS.feed, IDS.synced, IDS.prodFeed, NAMES.feed, MARKER]) assert.equal(line.includes(secret), false);
  }
  // A not-owned test calendar and a wrong marker are refused as well.
  const world = makeWorld();
  world.calendars.get(IDS.feed).owned = false;
  assert.equal(plain(seederProject({ world }).t.fctSeedAll()).reason, 'calendar-not-owned');
  const w2 = makeWorld();
  w2.calendars.get(IDS.synced).description = 'no marker';
  assert.equal(plain(seederProject({ world: w2 }).t.fctSeedAll()).reason, 'calendar-marker');
});

test('seeder: writes only into the two guarded calendars, tags every event, logs counts only, with the one calendar scope', () => {
  const world = makeWorld();
  world.addEvent(IDS.prodFeed, { title: 'production event', start: NOW, end: NOW + 3600000 });
  const s = seederProject({ world });
  const dry = plain(s.t.fctSeedDryRun());
  assert.equal(dry.ok, true);
  assert.equal(dry.feed.toCreate + dry.synced.toCreate, dry.feed.fixture + dry.synced.fixture);
  assert.deepEqual(world.writes, [], 'a dry run writes nothing');
  const r = plain(s.t.fctSeedAll());
  assert.equal(r.ok, true);
  assert.equal(r.created, dry.feed.fixture + dry.synced.fixture);
  assert.equal(r.partial, false);
  assert.ok(world.writes.every(([id]) => id === IDS.feed || id === IDS.synced), 'every write went to a guarded calendar');
  assert.equal(world.calendars.get(IDS.prodFeed).events.length, 1, 'the production-like calendar is untouched');
  assert.equal(world.calendars.get(IDS.prodSynced).events.length, 0);
  assert.equal(world.calendars.get(IDS.personal).events.length, 0);
  assert.deepEqual(s.spies.denied, [], 'every call was within the calendar scope');
  assert.equal(s.spies.sessionDenied + s.spies.fetch + s.spies.spreadsheet, 0);
  const fx = plain(s.t.fctFixture_(TODAY));
  for (const role of ['feed', 'synced']) {
    const events = calendarEvents(world, IDS[role]);
    assert.equal(events.length, fx[role].length, role);
    for (const rec of events) {
      assert.equal(rec.tags.get('fct-seed'), '1');
      const f = fx[role].find((x) => x.key === rec.tags.get('fct-key'));
      assert.ok(f, 'a fixture key tag');
      assert.equal(rec.title, f.title);
      assert.equal(rec.start, f.start);
      assert.equal(rec.end, f.end);
      assert.equal(rec.description, `${markerLine(s.install(), role, f.key)}\n\n${f.description}`, 'ownership line, a blank line, then the fixture text');
      assert.equal(rec.tags.get('fct-own'), proofOf(s.install(), role, f.key));
      if (role === 'synced') assert.equal(rec.tags.get('FCTEST_SYNC_SOURCE_ID'), f.sourceId, 'synced copies carry the sync tag');
      else assert.equal(rec.tags.has('FCTEST_SYNC_SOURCE_ID'), false, 'feed events carry no sync tag');
    }
  }
  // Logs: counts and codes only.
  const log = lines(s.spies);
  assert.ok(log.length >= 2);
  const text = s.spies.console.join('\n');
  for (const secret of [IDS.feed, IDS.synced, NAMES.feed, MARKER, 'TESTCREW', 'Sample']) assert.equal(text.includes(secret), false);
  // Idempotent: nothing is created twice.
  const again = plain(s.t.fctSeedAll());
  assert.equal(again.created, 0);
  assert.equal(again.repaired, 0);
  assert.equal(again.skipped, r.created);
  assert.equal(calendarEvents(world, IDS.feed).length + calendarEvents(world, IDS.synced).length, r.created);
  // Check setup reports a role and booleans only, and never calls Session (the seeder has no email scope).
  const setup = plain(s.t.fctCheckSetup());
  assert.deepEqual(setup, { role: 'seeder', isolation: 'ok', feed: 'ok', synced: 'ok' });
  assert.equal(s.spies.sessionDenied, 0);
});

test('seeder: time-boxed runs continue where they stopped, never duplicate, and remember the anchor and the installation', () => {
  const world = makeWorld();
  const s = seederProject({ world });
  let ticks = 0;
  const clock = () => { ticks += 1; return ticks > 20 ? 1e9 : 0; };       // the budget runs out after a few events
  const first = plain(s.t.fctSeedAllCounts_(null, NOW, clock));
  assert.equal(first.partial, true);
  assert.ok(first.created > 0 && first.created < 40);
  const fx = plain(s.t.fctFixture_(TODAY));
  const second = plain(s.t.fctSeedAll());
  assert.equal(second.ok, true);
  assert.equal(second.partial, false);
  assert.equal(second.skipped, first.created);
  assert.equal(second.created, fx.feed.length + fx.synced.length - first.created);
  assert.equal(calendarEvents(world, IDS.feed).length, fx.feed.length);
  assert.equal(calendarEvents(world, IDS.synced).length, fx.synced.length);
  // The anchor and the installation id are remembered in the seeder project, so a run on another day still builds the same fixture.
  assert.equal(s.svc.scriptProps.map.get('FCT_SEED_ANCHOR'), TODAY);
  assert.match(s.install(), /^[a-f0-9]{32}$/);
  const later = seederProject({ world, carry: s, clock: { t: NOW + 3 * 86400000 } });
  const r = plain(later.t.fctSeedAll());
  assert.equal(r.anchor, TODAY);
  assert.equal(r.created, 0);
  assert.equal(r.skipped, fx.feed.length + fx.synced.length);
  // Without the remembered anchor a different day would build a different fixture (hence fctRemoveSeeded before a re-seed).
  const stranger = plain(seederProject({ world, carry: null, clock: { t: NOW + 3 * 86400000 } }).t.fctSeedDryRun());
  assert.equal(stranger.anchor, '2026-10-26');
});

test('seeder: the schedule change updates the same event in place, once; removal deletes only events whose description proves ownership', () => {
  const world = makeWorld();
  const s = seederProject({ world });
  s.t.fctSeedAll();
  const fx = plain(s.t.fctFixture_(TODAY));
  const f2 = () => calendarEvents(world, IDS.feed).find((r) => r.tags.get('fct-key') === 'F2');
  const before = { id: f2().id, start: f2().start, description: f2().description };
  assert.equal(before.description.split('\n')[0], markerLine(s.install(), 'feed', 'F2'));
  assert.equal(before.start, fx.variants.scheduleChange.before.start);
  const r = plain(s.t.fctApplyScheduleChange());
  assert.deepEqual([r.ok, r.applied], [true, true]);
  assert.equal(f2().id, before.id, 'the same event (the same source id)');
  assert.equal(f2().start, before.start + 90 * 60000);
  assert.notEqual(f2().description, before.description);
  assert.equal(f2().description, `${markerLine(s.install(), 'feed', 'F2')}\n\n${fx.variants.scheduleChange.description}`, 'the ownership line survives the schedule change');
  assert.equal(f2().tags.get('fct-variant'), 'scheduleChange');
  assert.equal(calendarEvents(world, IDS.feed).length, fx.feed.length, 'no event added');
  const second = plain(s.t.fctApplyScheduleChange());
  assert.deepEqual([second.applied, second.reason], [false, 'already-applied']);
  // Personal (untagged) events in the test calendars and events in other calendars survive a removal.
  const mine = world.addEvent(IDS.feed, { title: 'My own note', start: NOW + 86400000, end: NOW + 90000000 });
  const mine2 = world.addEvent(IDS.synced, { title: 'Another note', start: NOW - 86400000, end: NOW - 80000000 });
  const other = world.addEvent(IDS.prodFeed, { title: 'production', start: NOW, end: NOW + 3600000, tags: { 'fct-seed': '1' } });   // even a tagged one in ANOTHER calendar
  const forged = world.addEvent(IDS.feed, { title: 'forged tags', start: NOW + 5 * 86400000, end: NOW + 5 * 86400000 + 3600000, tags: { 'fct-seed': '1', 'fct-key': 'F1o' } });   // tags are not proof
  const personal = world.addEvent(IDS.personal, { title: 'private', start: NOW, end: NOW + 3600000 });
  const gone = plain(s.t.fctRemoveSeeded());
  assert.equal(gone.ok, true);
  assert.equal(gone.deleted, fx.feed.length + fx.synced.length);
  assert.equal(gone.kept, 3);
  assert.deepEqual(calendarEvents(world, IDS.feed), [mine, forged]);
  assert.deepEqual(calendarEvents(world, IDS.synced), [mine2]);
  assert.deepEqual(calendarEvents(world, IDS.prodFeed), [other]);
  assert.deepEqual(calendarEvents(world, IDS.personal), [personal]);
  assert.ok(world.writes.every(([id]) => id === IDS.feed || id === IDS.synced));
  assert.equal(s.svc.scriptProps.map.has('FCT_SEED_ANCHOR'), false, 'the anchor is forgotten');
  assert.match(s.install(), /^[a-f0-9]{32}$/, 'the installation id is kept, so ownership stays provable');
  const reseed = plain(s.t.fctSeedAll());
  assert.equal(reseed.ok, false, 'the forged-tag event looks like fixture key F1o: a conflict, not a claim');
  assert.deepEqual(reseed.conflictList, [{ role: 'feed', key: 'F1o', reason: 'unowned-tagged' }]);
  assert.equal(reseed.created, fx.feed.length + fx.synced.length - 1, 'a clean re-seed works for every other key');
});

test('seeder fails closed: a look-alike with the same title and times is a conflict (never adopted), and odd seed tags are kept', () => {
  const world = makeWorld();
  const s = seederProject({ world });
  const fx = plain(s.t.fctFixture_(TODAY));
  const target = fx.feed[0];
  // Same title and times as a fixture event, but a different (personal) description: ambiguous, so a conflict.
  const lookalike = world.addEvent(IDS.feed, { title: target.title, start: target.start, end: target.end, description: 'my own note' });
  const blank = world.addEvent(IDS.feed, { title: 'blank tag', start: NOW + 86400000, end: NOW + 90000000, tags: { 'fct-seed': '' } });
  const zero = world.addEvent(IDS.synced, { title: 'zero tag', start: NOW - 86400000, end: NOW - 80000000, tags: { 'fct-seed': '0' } });
  const seeded = plain(s.t.fctSeedAll());
  assert.equal(seeded.ok, false);
  assert.deepEqual(seeded.conflictList, [{ role: 'feed', key: target.key, reason: 'unowned-lookalike' }]);
  assert.equal(seeded.created, fx.feed.length + fx.synced.length - 1);
  assert.equal(lookalike.tags.size, 0, 'the look-alike is left untouched');
  assert.equal(lookalike.description, 'my own note');
  assert.equal(calendarEvents(world, IDS.feed).filter((r) => r.title === target.title && r.start === target.start).length, 1, 'nothing created for that key');
  const gone = plain(s.t.fctRemoveSeeded());
  assert.equal(gone.deleted, fx.feed.length + fx.synced.length - 1);
  assert.equal(gone.kept, 3);
  for (const rec of [lookalike, blank, zero]) {
    assert.ok([...calendarEvents(world, IDS.feed), ...calendarEvents(world, IDS.synced)].includes(rec), `${rec.title} survives removal`);
  }
});

// --- Seeder: ownership, required tags, interrupted runs, guard revalidation (ticket T2) ---------------------------------

const DAY = 86400000;
const total = (fx) => fx.feed.length + fx.synced.length;
const MARKED = `fc-test-marker:${MARKER}\nsynthetic`;
const unmark = (world, id) => { world.calendars.get(id).description = 'synthetic'; };
const remark = (world, id) => { world.calendars.get(id).description = MARKED; };
const snapshot = (rec) => JSON.stringify([rec.title, rec.start, rec.end, rec.description, rec.location, [...rec.tags]]);
/** The synced fixture keys the PRODUCTION reader (API bundle, fctEnv_ path) currently sees. */
function syncedKeysSeenByApi(world) {
  const p = apiProject({ world });
  return plain(p.t.fctEnv_().syncedEvents(NOW - 400 * DAY, NOW)).map((e) => e.sourceId);
}
/** Every fixture key exists exactly once per calendar with the exact required tags and the exact description. */
function assertFullySeeded(world, install, fx, label = '') {
  for (const role of ['feed', 'synced']) {
    const events = calendarEvents(world, IDS[role]);
    assert.equal(events.length, fx[role].length, `${label} ${role}: one event per key, none extra`);
    for (const f of fx[role]) {
      const found = events.filter((e) => e.tags.get('fct-key') === f.key);
      assert.equal(found.length, 1, `${label} ${role} ${f.key}`);
      const rec = found[0];
      assert.equal(rec.tags.get('fct-seed'), '1');
      assert.equal(rec.tags.get('fct-own'), proofOf(install, role, f.key));
      if (role === 'synced') assert.equal(rec.tags.get('FCTEST_SYNC_SOURCE_ID'), f.sourceId, `${label} ${f.key} sync tag`);
      else assert.equal(rec.tags.has('FCTEST_SYNC_SOURCE_ID'), false);
      assert.equal(rec.description.split('\n')[0], markerLine(install, role, f.key));
      assert.equal(rec.title, f.title);
    }
  }
}
const lastLine = (spies) => JSON.parse(spies.console[spies.console.length - 1]);

test('fixture facts the seeder relies on: keys are short and unique, no two events of a calendar share title, start and end', () => {
  const fx = plain(apiProject().t.fctFixture_(TODAY));
  const keys = [...fx.feed, ...fx.synced].map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const k of keys) assert.match(k, /^[A-Za-z0-9_-]{1,40}$/, k);
  for (const role of ['feed', 'synced']) {
    const sig = fx[role].map((e) => JSON.stringify([e.title, e.start, e.end]));
    assert.equal(new Set(sig).size, sig.length, `${role}: distinct title+start+end`);
  }
});

test('marker line: production classification and crew parsing are identical with and without the ownership line (every fixture event)', () => {
  const p = apiProject();
  const config = p.t.FCV2_CONDOR_CONFIG_;
  const fx = plain(p.t.fctFixture_(TODAY));
  const install = hex('install-for-parse', 32);
  const variant = fx.variants.scheduleChange;
  const cases = [];
  for (const role of ['feed', 'synced']) for (const f of fx[role]) cases.push([role, f, f.description]);
  cases.push(['feed', fx.feed.find((f) => f.key === variant.key), variant.description]);
  assert.ok(cases.length > 60);
  for (const [role, f, description] of cases) {
    const raw = { sourceId: f.sourceId, title: f.title, start: f.start, end: f.end, location: f.location, description, basis: role === 'feed' ? 'airline-feed' : 'synced-copy' };
    const marked = { ...raw, description: `${markerLine(install, role, f.key)}\n\n${description}` };
    assert.deepEqual(plain(p.t.fcv2ClassifyEvent_(marked, config)), plain(p.t.fcv2ClassifyEvent_(raw, config)), `${f.key} classify`);
    assert.deepEqual(plain(p.t.fcv2CrewNormalizeEvent_(marked, config)), plain(p.t.fcv2CrewNormalizeEvent_(raw, config)), `${f.key} crew normalize`);
    assert.deepEqual(plain(p.t.fcv2ParseDescription_(marked.description)), plain(p.t.fcv2ParseDescription_(description)), `${f.key} description parse`);
    assert.deepEqual(plain(p.t.fcv2CrewParseLines_(marked.description, config)), plain(p.t.fcv2CrewParseLines_(description, config)), `${f.key} crew lines`);
  }
});

test('ownership functions: the first line must parse exactly and its proof must recompute; tags and content prove nothing', () => {
  const s = seederProject();
  const install = hex('own-install', 32);
  const evOf = (description, tags = {}) => ({ getDescription: () => description, getTag: (k) => tags[k] ?? null });
  const good = markerLine(install, 'synced', 'H1');
  assert.deepEqual(plain(s.t.fctSeedOwned_(evOf(`${good}\n\nbody`), install)), { role: 'synced', key: 'H1' });
  assert.equal(s.t.fctSeedProof_(install, 'synced', 'H1'), proofOf(install, 'synced', 'H1'));
  assert.equal(s.t.fctSeedMarkerLine_(install, 'synced', 'H1'), good);
  assert.equal(s.t.fctSeedDescription_(install, 'synced', 'H1', 'body'), `${good}\n\nbody`);
  const bads = [
    ['no install', `${good}\n\nbody`, null], ['another install', `${good}\n\nbody`, hex('other-install', 32)],
    ['not the first line', `body\n${good}`, install], ['leading space', ` ${good}`, install], ['trailing space', `${good} `, install],
    ['upper-case proof', good.replace(/[a-f0-9]{32}$/, (m) => m.toUpperCase()), install], ['unknown role', good.replace(':synced:', ':other:'), install],
    ['key changed', good.replace(':H1:', ':H2:'), install], ['role changed', good.replace(':synced:', ':feed:'), install],
    ['short proof', good.slice(0, -1), install], ['empty', '', install], ['null', null, install],
    ['key too long', `fct-own:feed:${'k'.repeat(41)}:${proofOf(install, 'feed', 'k'.repeat(41))}`, install],
  ];
  for (const [label, description, inst] of bads) {
    const withTags = evOf(description, { 'fct-seed': '1', 'fct-key': 'H1', 'fct-own': proofOf(install, 'synced', 'H1') });
    assert.equal(s.t.fctSeedOwned_(withTags, inst), null, label);
  }
  assert.deepEqual(plain(s.t.fctSeedOwned_(evOf(`${good}\r\nbody`), install)), { role: 'synced', key: 'H1' }, 'CRLF after the first line is fine');
});

test('required tag set: exact values, the sync tag only for the synced role, checked exactly', () => {
  const s = seederProject();
  const install = hex('tag-install', 32);
  const fx = plain(s.t.fctFixture_(TODAY));
  const f = fx.synced[0];
  const proof = proofOf(install, 'synced', f.key);
  assert.deepEqual(plain(s.t.fctSeedRequiredTags_(f, 'synced', proof)), [['fct-seed', '1'], ['fct-key', f.key], ['fct-own', proof], ['FCTEST_SYNC_SOURCE_ID', f.sourceId]]);
  const g = fx.feed[0];
  assert.deepEqual(plain(s.t.fctSeedRequiredTags_(g, 'feed', proofOf(install, 'feed', g.key))).map((t) => t[0]), ['fct-seed', 'fct-key', 'fct-own']);
  const tagged = (tags) => ({ getTag: (k) => tags[k] ?? null });
  const full = { 'fct-seed': '1', 'fct-key': f.key, 'fct-own': proof, FCTEST_SYNC_SOURCE_ID: f.sourceId };
  assert.equal(s.t.fctSeedTagsComplete_(tagged(full), f, 'synced', proof), true);
  for (const k of Object.keys(full)) {
    assert.equal(s.t.fctSeedTagsComplete_(tagged({ ...full, [k]: undefined }), f, 'synced', proof), false, `${k} missing`);
    assert.equal(s.t.fctSeedTagsComplete_(tagged({ ...full, [k]: `${full[k]}x` }), f, 'synced', proof), false, `${k} wrong`);
  }
  assert.equal(s.t.fctSeedTagsComplete_(tagged({ ...full, 'fct-seed': 'true' }), f, 'synced', proof), false);
});

test('Codex repro 1 (interrupted tagging): a failing sync-tag write is reported as a failure, the event is not counted, a rerun repairs it for the production reader', () => {
  const world = makeWorld();
  const s = seederProject({ world });
  const fx = plain(s.t.fctFixture_(TODAY));
  const first = fx.synced[0];
  failBefore(world, (i) => i.op === 'setTag' && i.tag === 'FCTEST_SYNC_SOURCE_ID' && i.calId === IDS.synced);
  const r1 = plain(s.t.fctSeedAll());
  assert.deepEqual([r1.ok, r1.stopped, r1.guard], [false, true, 'write-failed'], 'reported as a failure, never as success');
  assert.equal(r1.created, undefined, 'no success counts at the top level');
  assert.equal(r1.progress.created, fx.feed.length, 'only the fully tagged feed events count; the half-tagged synced event does not');
  assert.deepEqual(lastLine(s.spies), r1);
  const half = calendarEvents(world, IDS.synced);
  assert.equal(half.length, 1);
  assert.deepEqual([...half[0].tags.keys()], ['fct-seed', 'fct-key', 'fct-own'], 'exactly the tags written before the failure');
  assert.equal(syncedKeysSeenByApi(world).includes(first.key), false, 'the production reader cannot use the event yet');
  clearHooks(world);
  const r2 = plain(s.t.fctSeedAll());
  assert.equal(r2.ok, true);
  assert.deepEqual([r2.repaired, r2.created, r2.skipped], [1, fx.synced.length - 1, fx.feed.length]);
  assert.equal(syncedKeysSeenByApi(world).includes(first.key), true, 'the production reader now sees it');
  assert.equal(syncedKeysSeenByApi(world).length, fx.synced.length);
  assertFullySeeded(world, s.install(), fx);
  const r3 = plain(s.t.fctSeedAll());
  assert.deepEqual([r3.ok, r3.created, r3.repaired, r3.skipped], [true, 0, 0, total(fx)]);
});

const CRASH_POINTS = [];
for (const role of ['feed', 'synced']) {
  CRASH_POINTS.push([role, 'right after createEvent (no tag)', (i) => i.op === 'createEvent', false]);
  for (const tag of role === 'feed' ? ['fct-seed', 'fct-key', 'fct-own'] : ['fct-seed', 'fct-key', 'fct-own', 'FCTEST_SYNC_SOURCE_ID']) {
    CRASH_POINTS.push([role, `right after the ${tag} tag`, (i) => i.op === 'setTag' && i.tag === tag, tag === (role === 'feed' ? 'fct-own' : 'FCTEST_SYNC_SOURCE_ID')]);
  }
}
for (const [role, label, pred, completeAtCrash] of CRASH_POINTS) {
  test(`interruption (${role}, ${label}): not counted as seeded, a rerun repairs exactly that event, retries are idempotent`, () => {
    const world = makeWorld();
    const s = seederProject({ world });
    const fx = plain(s.t.fctFixture_(TODAY));
    const key = fx[role][0].key;
    crashAfter(world, (i) => i.calId === IDS[role] && pred(i));
    const r1 = plain(s.t.fctSeedAll());
    assert.deepEqual([r1.ok, r1.stopped, r1.guard], [false, true, 'write-failed']);
    assert.equal(r1.progress.created, role === 'feed' ? 0 : fx.feed.length, 'the interrupted event is never counted as seeded');
    const interrupted = calendarEvents(world, IDS[role]).filter((e) => e.title === fx[role][0].title);
    assert.equal(interrupted.length, 1);
    assert.equal(interrupted[0].description.split('\n')[0], markerLine(s.install(), role, key), 'owned through its creation payload');
    if (role === 'synced') assert.equal(syncedKeysSeenByApi(world).includes(key), completeAtCrash, 'visible to the production reader only when the sync tag exists');
    clearHooks(world);
    const r2 = plain(s.t.fctSeedAll());
    assert.equal(r2.ok, true);
    const already = role === 'feed' ? 0 : fx.feed.length;
    assert.equal(r2.repaired, completeAtCrash ? 0 : 1);
    assert.equal(r2.created, total(fx) - already - 1);
    assert.equal(r2.skipped, already + (completeAtCrash ? 1 : 0));
    assert.equal(r2.created + r2.repaired + r2.skipped, total(fx));
    assertFullySeeded(world, s.install(), fx);
    assert.equal(syncedKeysSeenByApi(world).length, fx.synced.length);
    const r3 = plain(s.t.fctSeedAll());
    assert.deepEqual([r3.ok, r3.created, r3.repaired, r3.skipped, r3.conflicts], [true, 0, 0, total(fx), 0]);
    assertFullySeeded(world, s.install(), fx);
  });
}

test('tag repair: missing or wrong tags on proven-owned events are repaired in place (no new event), counted as repaired', () => {
  const { world, seeder: s } = seededWorld();
  const fx = plain(s.t.fctFixture_(TODAY));
  const byKey = (role, key) => calendarEvents(world, IDS[role]).find((e) => e.tags.get('fct-key') === key);
  const ids = calendarEvents(world, IDS.feed).concat(calendarEvents(world, IDS.synced)).map((e) => e.id);
  byKey('feed', fx.feed[0].key).tags.set('fct-seed', '0');
  byKey('feed', fx.feed[1].key).tags.delete('fct-own');
  byKey('synced', fx.synced[0].key).tags.delete('FCTEST_SYNC_SOURCE_ID');
  byKey('synced', fx.synced[1].key).tags.set('FCTEST_SYNC_SOURCE_ID', 'wrong');
  byKey('synced', fx.synced[2].key).tags.set('fct-key', 'wrong-key');
  const dry = plain(s.t.fctSeedDryRun());
  assert.equal(dry.feed.repair + dry.synced.repair, 5, 'the dry run sees the incomplete events');
  const writesBefore = world.writes.length;
  assert.equal(syncedKeysSeenByApi(world).includes(fx.synced[0].key), false);
  const r = plain(s.t.fctSeedAll());
  assert.deepEqual([r.ok, r.repaired, r.created, r.skipped], [true, 5, 0, total(fx) - 5]);
  assert.equal(world.writes.length - writesBefore, 5, 'one write per incorrect tag, nothing else');
  assert.deepEqual(world.writes.slice(writesBefore).map((w) => w[1]), Array(5).fill('setTag'));
  assert.deepEqual([...calendarEvents(world, IDS.feed), ...calendarEvents(world, IDS.synced)].map((e) => e.id), ids, 'same events, none added');
  assertFullySeeded(world, s.install(), fx);
});

test('Codex repro 2 (guard invalidated after the first mutation): exactly one write, a stopped failure with the guard code, no later writes, a rerun after restoring completes without duplicates', () => {
  const world = makeWorld();
  const s = seederProject({ world });
  const fx = plain(s.t.fctFixture_(TODAY));
  afterNth(world, 1, () => unmark(world, IDS.feed));       // the marker disappears right after the first event was created
  const r1 = plain(s.t.fctSeedAll());
  assert.deepEqual([r1.ok, r1.stopped, r1.guard], [false, true, 'calendar-marker']);
  assert.equal(r1.created, undefined);
  assert.deepEqual(r1.progress, { created: 0, repaired: 0, skipped: 0, partial: false, conflicts: 0 });
  assert.deepEqual(lastLine(s.spies), r1, 'one JSON line, the same value is returned');
  assert.deepEqual(world.writes, [[IDS.feed, 'createEvent']], 'exactly one mutation happened');
  assert.equal(calendarEvents(world, IDS.feed).length, 1);
  assert.equal(calendarEvents(world, IDS.synced).length, 0);
  assert.equal(calendarEvents(world, IDS.feed)[0].tags.size, 0);
  assert.match(s.install(), /^[a-f0-9]{32}$/, 'retry state kept: the installation id');
  assert.equal(s.svc.scriptProps.map.get('FCT_SEED_ANCHOR'), TODAY, 'retry state kept: the anchor');
  const text = s.spies.console.join('\n');
  for (const secret of [IDS.feed, IDS.synced, NAMES.feed, MARKER, s.install()]) assert.equal(text.includes(secret), false);
  clearHooks(world);
  remark(world, IDS.feed);
  const r2 = plain(s.t.fctSeedAll());
  assert.deepEqual([r2.ok, r2.repaired, r2.created, r2.skipped], [true, 1, total(fx) - 1, 0]);
  assertFullySeeded(world, s.install(), fx);
});

test('per-write guard covers BOTH calendars: invalidating the calendar NOT being written also halts the seeder', () => {
  // Synced marker removed right after the first feed write: no further feed write.
  const w1 = makeWorld();
  const s1 = seederProject({ world: w1 });
  afterNth(w1, 1, () => unmark(w1, IDS.synced));
  const r1 = plain(s1.t.fctSeedAll());
  assert.deepEqual([r1.ok, r1.stopped, r1.guard], [false, true, 'calendar-marker']);
  assert.deepEqual(w1.writes, [[IDS.feed, 'createEvent']], 'exactly one mutation, on the feed calendar');
  // Feed calendar renamed after the last feed write: no synced write, and no success.
  const w2 = makeWorld();
  const s2 = seederProject({ world: w2 });
  const fx = plain(s2.t.fctFixture_(TODAY));
  beforeOp(w2, (info) => info.calId === IDS.synced, () => { w2.calendars.get(IDS.feed).name = 'renamed'; });
  const r2 = plain(s2.t.fctSeedAll());
  assert.deepEqual([r2.ok, r2.stopped, r2.guard], [false, true, 'calendar-name']);
  // The hook fires after the first synced write passed its check (the documented check-to-write race): that one
  // write lands, every later one is refused. Before the fix all synced writes ran and the run reported success.
  assert.equal(w2.writes.filter(([id]) => id === IDS.synced).length, 1, 'only the write already past its check');
  assert.equal(calendarEvents(w2, IDS.feed).length, fx.feed.length);
});

test('overlapping seeder executions are serialized: a run that cannot take the script lock is busy and touches nothing', () => {
  const world = makeWorld();
  const s = seederProject({ world, lockBusy: true });
  for (const fn of ['fctSeedAll', 'fctSeedDryRun', 'fctApplyScheduleChange', 'fctRemoveSeeded']) {
    const r = plain(s.t[fn]());
    assert.deepEqual([r.ok, r.reason], [false, 'busy'], fn);
  }
  assert.deepEqual(world.writes, []);
  assert.equal(s.svc.scriptProps.map.has('FCT_SEED_INSTALL'), false, 'no installation id written while busy');
  assert.equal(s.spies.reads.length, 0, 'nothing read');
  // A normal run takes and releases the lock (a second run right after it is not refused).
  const free = seederProject({ world });
  assert.equal(plain(free.t.fctSeedDryRun()).ok, true);
  assert.equal(plain(free.t.fctSeedAll()).ok, true);
  assert.equal(free.spies.lock.nested, 0);
});

test('guard invalidated after the plan but before the first mutation: zero writes, stopped, the retry state is kept', () => {
  const world = makeWorld();
  const s = seederProject({ world });
  afterNthRead(world, 2, () => unmark(world, IDS.feed));      // both calendars were read for the plan; the guard fails at the first write
  const r = plain(s.t.fctSeedAll());
  assert.deepEqual([r.ok, r.stopped, r.guard], [false, true, 'calendar-marker']);
  assert.deepEqual(world.writes, []);
  assert.equal(calendarEvents(world, IDS.feed).length + calendarEvents(world, IDS.synced).length, 0);
  assert.match(s.install(), /^[a-f0-9]{32}$/);
});

test('guard invalidation before cleanup: no delete at all; during cleanup: stops after the first delete; a rerun finishes, a further run deletes 0', () => {
  const { world, seeder: s } = seededWorld();
  const fx = plain(s.t.fctFixture_(TODAY));
  const writes0 = world.writes.length;
  unmark(world, IDS.feed);
  const refused = plain(s.t.fctRemoveSeeded());
  assert.deepEqual([refused.ok, refused.reason], [false, 'calendar-marker']);
  assert.equal(world.writes.length, writes0, 'zero deletes');
  assert.equal(calendarEvents(world, IDS.feed).length + calendarEvents(world, IDS.synced).length, total(fx));
  remark(world, IDS.feed);
  afterNth(world, world.mutations + 1, () => unmark(world, IDS.feed));
  const stopped = plain(s.t.fctRemoveSeeded());
  assert.deepEqual([stopped.ok, stopped.stopped, stopped.guard], [false, true, 'calendar-marker']);
  assert.deepEqual(stopped.progress, { deleted: 1, kept: 0 });
  assert.equal(world.writes.length - writes0, 1, 'exactly one delete happened');
  assert.equal(s.svc.scriptProps.map.has('FCT_SEED_ANCHOR'), true, 'a stopped cleanup keeps the anchor');
  clearHooks(world);
  remark(world, IDS.feed);
  const done = plain(s.t.fctRemoveSeeded());
  assert.deepEqual([done.ok, done.deleted, done.kept], [true, total(fx) - 1, 0]);
  const again = plain(s.t.fctRemoveSeeded());
  assert.deepEqual([again.ok, again.deleted, again.kept], [true, 0, 0], 'idempotent');
  assert.equal(calendarEvents(world, IDS.feed).length + calendarEvents(world, IDS.synced).length, 0);
  assert.match(s.install(), /^[a-f0-9]{32}$/, 'removal never deletes the installation id');
});

test('guard invalidation before the schedule update: no setTime; in the middle: stops after setTime; the retry is idempotent (moved once)', () => {
  const { world, seeder: s } = seededWorld();
  const f2 = () => calendarEvents(world, IDS.feed).find((r) => r.tags.get('fct-key') === 'F2');
  const start0 = f2().start;
  const description0 = f2().description;
  const writes0 = world.writes.length;
  afterNthRead(world, world.reads + 2, () => unmark(world, IDS.feed));    // after the plan's two reads, before the first write
  const early = plain(s.t.fctApplyScheduleChange());
  assert.deepEqual([early.ok, early.stopped, early.guard, early.progress], [false, true, 'calendar-marker', { applied: false, steps: 0 }]);
  assert.equal(world.writes.length, writes0, 'no setTime');
  assert.deepEqual([f2().start, f2().description, f2().tags.has('fct-variant')], [start0, description0, false]);
  clearHooks(world);
  remark(world, IDS.feed);
  afterNth(world, world.mutations + 1, () => unmark(world, IDS.feed));    // after setTime
  const mid = plain(s.t.fctApplyScheduleChange());
  assert.deepEqual([mid.ok, mid.stopped, mid.guard, mid.progress], [false, true, 'calendar-marker', { applied: false, steps: 1 }]);
  assert.deepEqual(world.writes.slice(writes0).map((w) => w[1]), ['setTime']);
  assert.deepEqual([f2().start, f2().description, f2().tags.has('fct-variant')], [start0 + 90 * 60000, description0, false]);
  clearHooks(world);
  remark(world, IDS.feed);
  const retry = plain(s.t.fctApplyScheduleChange());
  assert.deepEqual([retry.ok, retry.applied, retry.steps], [true, true, 3]);
  assert.equal(f2().start, start0 + 90 * 60000, 'moved once, not twice');
  assert.notEqual(f2().description, description0);
  assert.equal(f2().tags.get('fct-variant'), 'scheduleChange');
  assert.deepEqual(plain(s.t.fctApplyScheduleChange()), { action: 'schedule-change', ok: true, applied: false, reason: 'already-applied' });
});

test('guard identity: a swapped calendar id, a deleted calendar, a removed confirmation or a production property stops the run at once', () => {
  const cases = [
    ['calendar id swapped to another valid test calendar', 'handle-identity', (world, s) => {
      world.add('fake-feed-b', { name: NAMES.feed, description: MARKED });
      s.svc.scriptProps.map.set('FCT_CAL_FEED_ID', 'fake-feed-b');
    }],
    ['calendar deleted', 'calendar-missing', (world) => { world.calendars.delete(IDS.feed); }],
    ['calendar renamed', 'calendar-name', (world) => { world.calendars.get(IDS.feed).name = 'Renamed'; }],
    ['calendar no longer owned', 'calendar-not-owned', (world) => { world.calendars.get(IDS.feed).owned = false; }],
    ['seeder confirmation removed', 'confirm-missing', (world, s) => { s.svc.scriptProps.map.delete('FCT_SEED_CONFIRM'); }],
    ['production property appears', 'production-property', (world, s) => { s.svc.scriptProps.map.set('FC_V5_GET', 'open'); }],
    ['deny list now denies the calendar', 'calendar-denied', (world, s) => { s.svc.scriptProps.map.set('FCT_DENY_SHA256', `${sha(IDS.feed)},${sha(IDS.prodSynced)}`); }],
  ];
  for (const [label, code, change] of cases) {
    const world = makeWorld();
    const s = seederProject({ world });
    afterNth(world, 1, () => change(world, s));
    const r = plain(s.t.fctSeedAll());
    assert.deepEqual([r.ok, r.stopped, r.guard], [false, true, code], label);
    assert.deepEqual(world.writes, [[IDS.feed, 'createEvent']], `${label}: no write after the change`);
    assert.equal(world.calendars.get('fake-feed-b')?.events.length ?? 0, 0, `${label}: the swapped-in calendar was not written`);
  }
});

test('fctSeedGuarded_: the calendar object in use must report the validated id, and an event must come from that calendar (mutation never runs otherwise)', () => {
  const world = makeWorld();
  const s = seederProject({ world });
  const deps = () => ({ calendarApp: s.sandbox.CalendarApp, props: propsOf(s.props), hash: s.t.fctSha256_ });
  const cal = (id) => s.sandbox.CalendarApp.getCalendarById(id);
  let ran = 0;
  const run = (role, handle, ev) => {
    try { return { value: s.t.fctSeedGuarded_(deps(), role, handle, () => { ran += 1; return 'done'; }, ev) }; } catch (err) { return { err }; }
  };
  const ok = run('feed', { id: IDS.feed, calendar: cal(IDS.feed) });
  assert.deepEqual([ok.value, ran], ['done', 1]);
  for (const [label, role, handle, code] of [
    ['calendar object of the other role', 'feed', { id: IDS.feed, calendar: cal(IDS.synced) }, 'handle-identity'],
    ['handle id of the other role', 'feed', { id: IDS.synced, calendar: cal(IDS.feed) }, 'handle-identity'],
    ['no handle', 'feed', null, 'handle-identity'],
    ['calendar without getId', 'feed', { id: IDS.feed, calendar: {} }, 'handle-identity'],
    ['bad role', 'other', { id: IDS.feed, calendar: cal(IDS.feed) }, 'bad-role'],
  ]) {
    const r = run(role, handle);
    assert.equal(JSON.stringify(r.err), JSON.stringify({ fctGuard: code, fctStop: true }), label);
  }
  assert.equal(ran, 1, 'the mutation never ran on a failed check');
  const rec = world.addEvent(IDS.feed, { title: 'x', start: NOW, end: NOW + 3600000 });
  const handle = { id: IDS.feed, calendar: cal(IDS.feed) };
  const ev = () => handle.calendar.getEvents(new Date(NOW - 1), new Date(NOW + 3600001))[0];
  assert.equal(run('feed', handle, ev()).value, 'done');
  rec.originalCalendarId = IDS.personal;
  assert.equal(JSON.stringify(run('feed', handle, ev()).err), JSON.stringify({ fctGuard: 'event-calendar', fctStop: true }));
  assert.equal(ran, 2);
  const noMethod = { getTitle: () => 'x' };
  assert.equal(run('feed', handle, noMethod).value, 'done', 'an event without getOriginalCalendarId is not blocked');
  const thrown = (() => { try { s.t.fctSeedGuarded_(deps(), 'feed', handle, () => { throw new Error(`secret ${IDS.feed}`); }, null); } catch (err) { return err; } return null; })();
  assert.equal(JSON.stringify(thrown), JSON.stringify({ fctGuard: 'write-failed', fctStop: true }), 'a failing write carries nothing of its message');
});

test('Codex repro 3 (ownership attack): exact fixture copies, forged tags and a forged proof from another installation are never adopted, tagged or deleted', () => {
  const world = makeWorld();
  const s = seederProject({ world });
  const fx = plain(s.t.fctFixture_(TODAY));
  const clone = (role, f, extra = {}) => world.addEvent(IDS[role], { title: f.title, start: f.start, end: f.end, description: f.description, location: f.location, ...extra });
  const exact = clone('feed', fx.feed[0]);                                                              // the pre-fix defect: adopted by content, later deleted
  const forgedTags = clone('feed', fx.feed[1], { tags: { 'fct-seed': '1', 'fct-key': fx.feed[1].key } });
  const forgedProof = clone('feed', fx.feed[2], { description: `${markerLine(hex('another-install', 32), 'feed', fx.feed[2].key)}\n\n${fx.feed[2].description}` });
  const exactSynced = clone('synced', fx.synced[0]);
  const copies = [exact, forgedTags, forgedProof, exactSynced];
  const before = copies.map(snapshot);
  const r = plain(s.t.fctSeedAll());
  assert.equal(r.ok, false);
  assert.equal(r.conflicts, 4);
  assert.deepEqual(r.conflictList, [
    { role: 'feed', key: fx.feed[0].key, reason: 'unowned-lookalike' }, { role: 'feed', key: fx.feed[1].key, reason: 'unowned-tagged' },
    { role: 'feed', key: fx.feed[2].key, reason: 'unowned-lookalike' }, { role: 'synced', key: fx.synced[0].key, reason: 'unowned-lookalike' },
  ]);
  assert.equal(r.created, total(fx) - 4);
  assert.deepEqual(copies.map(snapshot), before, 'not adopted, not tagged, not touched');
  assert.equal(r.adopted, undefined, 'there is no adoption any more');
  for (const [role, f] of [['feed', fx.feed[0]], ['feed', fx.feed[1]], ['feed', fx.feed[2]], ['synced', fx.synced[0]]]) {
    assert.equal(calendarEvents(world, IDS[role]).filter((e) => e.title === f.title && e.start === f.start).length, 1, `nothing created for ${f.key}`);
  }
  assert.deepEqual(lastLine(s.spies).conflictList, r.conflictList, 'the log line names the keys (not sensitive)');
  // Cleanup deletes only what the installation can prove, and leaves the copies.
  const gone = plain(s.t.fctRemoveSeeded());
  assert.deepEqual([gone.ok, gone.deleted, gone.kept], [true, total(fx) - 4, 4]);
  assert.deepEqual(copies.map(snapshot), before);
  const idOf = (a, b) => a.id.localeCompare(b.id);
  assert.deepEqual([...calendarEvents(world, IDS.feed), ...calendarEvents(world, IDS.synced)].sort(idOf), [...copies].sort(idOf));
  const second = plain(s.t.fctRemoveSeeded());
  assert.deepEqual([second.ok, second.deleted, second.kept], [true, 0, 4], 'cleanup is idempotent');
  // Manual resolution: delete the offending events by hand, rerun.
  for (const [role, rec] of [['feed', exact], ['feed', forgedTags], ['feed', forgedProof], ['synced', exactSynced]]) calendarEvents(world, IDS[role]).splice(calendarEvents(world, IDS[role]).indexOf(rec), 1);
  const resolved = plain(s.t.fctSeedAll());
  assert.deepEqual([resolved.ok, resolved.created, resolved.conflicts], [true, total(fx), 0]);
  assertFullySeeded(world, s.install(), fx);
});

test('a proof valid for the other role never makes an event owned in the wrong calendar', () => {
  const { world, seeder: s } = seededWorld();
  const fx = plain(s.t.fctFixture_(TODAY));
  const sy = calendarEvents(world, IDS.synced)[0];
  const strayRole = world.addEvent(IDS.feed, { title: 'copy of a synced event', start: NOW + 40 * DAY, end: NOW + 40 * DAY + 3600000, description: sy.description });
  const gone = plain(s.t.fctRemoveSeeded());
  assert.deepEqual([gone.ok, gone.deleted, gone.kept], [true, total(fx), 1]);
  assert.deepEqual(calendarEvents(world, IDS.feed), [strayRole], 'the synced proof in the feed calendar proves nothing there');
});

test('duplicate owned events (a person duplicated one in the calendar UI): conflict duplicate-owned, none of the two is touched', () => {
  const { world, seeder: s } = seededWorld();
  const fx = plain(s.t.fctFixture_(TODAY));
  const original = calendarEvents(world, IDS.synced)[3];
  const copy = world.addEvent(IDS.synced, { title: original.title, start: original.start, end: original.end, description: original.description, location: original.location });
  const key = original.tags.get('fct-key');
  const before = [snapshot(original), snapshot(copy)];
  const writes0 = world.writes.length;
  const r = plain(s.t.fctSeedAll());
  assert.deepEqual([r.ok, r.conflicts, r.created, r.repaired, r.skipped], [false, 1, 0, 0, total(fx) - 1]);
  assert.deepEqual(r.conflictList, [{ role: 'synced', key, reason: 'duplicate-owned' }]);
  assert.deepEqual([snapshot(original), snapshot(copy)], before);
  assert.equal(world.writes.length, writes0, 'no write at all');
  const dry = plain(s.t.fctSeedDryRun());
  assert.deepEqual([dry.ok, dry.conflicts], [false, 1]);
  const schedule = plain(s.t.fctApplyScheduleChange());
  assert.equal(schedule.applied, true, 'a duplicate of ANOTHER key does not block the schedule change');
  const gone = plain(s.t.fctRemoveSeeded());
  assert.deepEqual([gone.ok, gone.deleted], [true, total(fx) + 1], 'both copies carry a valid proof and are removed');
});

test('a duplicate of the schedule-change flight blocks the schedule change with a conflict (nothing written)', () => {
  const { world, seeder: s } = seededWorld();
  const f2 = calendarEvents(world, IDS.feed).find((r) => r.tags.get('fct-key') === 'F2');
  world.addEvent(IDS.feed, { title: f2.title, start: f2.start, end: f2.end, description: f2.description });
  const writes0 = world.writes.length;
  const r = plain(s.t.fctApplyScheduleChange());
  assert.deepEqual([r.ok, r.applied, r.reason, r.conflictList], [false, false, 'conflict', [{ role: 'feed', key: 'F2', reason: 'duplicate-owned' }]]);
  assert.equal(world.writes.length, writes0);
});

test('schedule change needs a complete, proven-owned event: unseeded, lost installation and incomplete tags are all failures that write nothing', () => {
  const world = makeWorld();
  const s = seederProject({ world });
  assert.deepEqual(plain(s.t.fctApplyScheduleChange()), { action: 'schedule-change', ok: false, applied: false, reason: 'seed-missing' });
  s.t.fctSeedAll();
  const f2 = calendarEvents(world, IDS.feed).find((r) => r.tags.get('fct-key') === 'F2');
  f2.tags.delete('fct-own');
  const writes0 = world.writes.length;
  const incomplete = plain(s.t.fctApplyScheduleChange());
  assert.deepEqual([incomplete.ok, incomplete.applied, incomplete.reason], [false, false, 'tags-incomplete']);
  assert.equal(world.writes.length, writes0);
  f2.tags.set('fct-own', proofOf(s.install(), 'feed', 'F2'));
  const lost = seederProject({ world, carry: null, props: seederProps({ FCT_SEED_ANCHOR: TODAY }) });
  const r = plain(lost.t.fctApplyScheduleChange());
  assert.deepEqual([r.ok, r.applied, r.reason], [false, false, 'seed-missing'], 'without the installation id nothing is owned');
  assert.equal(world.writes.length, writes0);
});

test('a lost installation id: nothing is owned any more, so seeding reports conflicts for every key and removal deletes nothing', () => {
  const { world, seeder: s } = seededWorld();
  const fx = plain(s.t.fctFixture_(TODAY));
  const snaps = [...calendarEvents(world, IDS.feed), ...calendarEvents(world, IDS.synced)].map(snapshot);
  s.svc.scriptProps.map.delete('FCT_SEED_INSTALL');
  const writes0 = world.writes.length;
  const r = plain(s.t.fctSeedAll());
  assert.deepEqual([r.ok, r.conflicts, r.created, r.repaired, r.skipped], [false, total(fx), 0, 0, 0]);
  assert.equal(world.writes.length, writes0);
  const gone = plain(s.t.fctRemoveSeeded());
  assert.deepEqual([gone.ok, gone.deleted, gone.kept], [true, 0, total(fx)]);
  assert.deepEqual([...calendarEvents(world, IDS.feed), ...calendarEvents(world, IDS.synced)].map(snapshot), snaps);
});

test('cleanup deletes every proven-owned event even after interrupted tagging, is idempotent, and keeps the installation id', () => {
  const world = makeWorld();
  const s = seederProject({ world });
  afterNth(world, 10, () => { throw new Error('the process died'); });
  const r = plain(s.t.fctSeedAll());
  assert.deepEqual([r.ok, r.stopped], [false, true]);
  const partial = calendarEvents(world, IDS.feed).length;
  assert.ok(partial > 0 && calendarEvents(world, IDS.feed).some((e) => e.tags.size < 3), 'some event is only partially tagged');
  clearHooks(world);
  const mine = world.addEvent(IDS.feed, { title: 'personal', start: NOW + 3 * DAY, end: NOW + 3 * DAY + 3600000 });
  const gone = plain(s.t.fctRemoveSeeded());
  assert.deepEqual([gone.ok, gone.deleted, gone.kept], [true, partial, 1]);
  assert.deepEqual(calendarEvents(world, IDS.feed), [mine]);
  assert.deepEqual(calendarEvents(world, IDS.synced), []);
  const again = plain(s.t.fctRemoveSeeded());
  assert.deepEqual([again.ok, again.deleted, again.kept], [true, 0, 1]);
  assert.match(s.install(), /^[a-f0-9]{32}$/);
});

test('dry run: reports conflicts and repairs, writes nothing, and never creates the installation id', () => {
  const world = makeWorld();
  const s = seederProject({ world });
  const fx = plain(s.t.fctFixture_(TODAY));
  world.addEvent(IDS.feed, { title: fx.feed[0].title, start: fx.feed[0].start, end: fx.feed[0].end, description: fx.feed[0].description });
  const dry = plain(s.t.fctSeedDryRun());
  assert.deepEqual([dry.ok, dry.conflicts, dry.feed.conflicts, dry.feed.toCreate, dry.synced.toCreate], [false, 1, 1, fx.feed.length - 1, fx.synced.length]);
  assert.deepEqual(dry.conflictList, [{ role: 'feed', key: fx.feed[0].key, reason: 'unowned-lookalike' }]);
  assert.deepEqual(world.writes, []);
  assert.equal(s.svc.scriptProps.map.has('FCT_SEED_INSTALL'), false);
  assert.equal(s.svc.scriptProps.map.has('FCT_SEED_ANCHOR'), false);
});

test('installation id: generated once in the right format, stable, never logged or written to a calendar, malformed values are refused', () => {
  const world = makeWorld();
  const s = seederProject({ world });
  assert.equal(s.svc.scriptProps.map.has('FCT_SEED_INSTALL'), false);
  s.t.fctSeedAll();
  const install = s.install();
  assert.match(install, /^[a-f0-9]{32}$/);
  s.t.fctSeedAll();
  s.t.fctApplyScheduleChange();
  assert.equal(s.install(), install, 'stable across runs');
  const everything = JSON.stringify([...calendarEvents(world, IDS.feed), ...calendarEvents(world, IDS.synced)].map((e) => ({ ...e, tags: [...e.tags] })));
  assert.equal(everything.includes(install), false, 'the installation id is never written to a calendar');
  assert.equal(s.spies.console.join('\n').includes(install), false, 'never logged');
  assert.equal(s.props.FCT_SEED_INSTALL, undefined, 'not part of the hand-set properties');
  // A malformed value is refused by every entry point; nothing is written.
  for (const bad of ['short', install.toUpperCase(), `${install}0`, 'zz'.repeat(16)]) {
    const t = seederProject({ world, props: seederProps({ FCT_SEED_INSTALL: bad }) });
    const writes0 = world.writes.length;
    for (const fn of ['fctSeedAll', 'fctSeedDryRun', 'fctApplyScheduleChange', 'fctRemoveSeeded']) {
      const r = plain(t.t[fn]());
      assert.deepEqual([r.ok, r.reason], [false, 'install-invalid'], `${fn} ${bad}`);
    }
    assert.equal(world.writes.length, writes0);
  }
});

test('the seeder only mutates through the guarded wrapper: every calendar write in the source sits inside a fctSeedGuarded_ call', () => {
  const code = stripComments(readFileSync(new URL('TestSeederV2.gs', TESTSRC), 'utf8'));
  for (const w of ['createEvent', 'setTag', 'setTime', 'setDescription', 'deleteEvent']) {
    const calls = [...code.matchAll(new RegExp(`\\.${w}\\(`, 'g'))];
    assert.ok(calls.length >= 1, w);
    for (const m of calls) {
      const before = code.slice(0, m.index);
      const lineStart = code.lastIndexOf('\n', m.index) + 1;
      const guardedHere = m.index - before.lastIndexOf('fctSeedGuarded_(') < 200 && before.lastIndexOf('fctSeedGuarded_(') > before.lastIndexOf('\nfunction ');
      assert.ok(guardedHere, `${w} outside fctSeedGuarded_: ${code.slice(lineStart, code.indexOf('\n', m.index)).trim()}`);
    }
  }
});

test('setup guide: requires a fresh rebuild with hash checks before installation, and documents ownership, conflicts, the race and atomicity', () => {
  const doc = readFileSync(new URL('docs/CREW-GAS-TEST-SETUP.md', ROOT), 'utf8');
  const manifest = manifestText(api, seeder).trimEnd().split('\n');
  assert.deepEqual(manifest.slice(-4).map((l) => l.split('  ')[1]), ['api/FcTestApi.gs', 'api/appsscript.json', 'seeder/FcTestSeeder.gs', 'seeder/appsscript.json'],
    'the last four manifest lines are the four output files, as the guide\'s `tail -n 4 | shasum -a 256 -c -` assumes');
  for (const line of manifest.slice(-4)) assert.match(line, /^[a-f0-9]{64} {2}\S+$/, 'shasum -c format');
  for (const phrase of ['fresh', 'empty (or absent) directory', 'mktemp -d', 'tail -n 4 MANIFEST.txt | shasum -a 256 -c -', 'diff "$REVIEWED/MANIFEST.txt" MANIFEST.txt',
    'paste **only** the files of that fresh, hash-checked build']) assert.ok(doc.includes(phrase), phrase);
  for (const phrase of ['FCT_SEED_INSTALL', 'fct-own:<role>:<key>:<proof>', 'duplicate-owned', 'unowned-lookalike', 'unowned-tagged', 'Manual\nresolution', 'reduce but cannot eliminate',
    'UNVERIFIED', 'not** atomic', 'stops at once', 'never adopts a pre-existing exact copy']) assert.ok(doc.includes(phrase), phrase);
  const header = readFileSync(new URL('TestSeederV2.gs', TESTSRC), 'utf8').split('\n').slice(0, 45).join('\n');
  for (const phrase of ['OWNERSHIP', 'REQUIRED TAGS', 'CONFLICTS', 'GUARD REVALIDATION', 'UNVERIFIED', 'reduce but cannot eliminate']) assert.ok(header.includes(phrase), `seeder header: ${phrase}`);
});

test('calendar guard: a production id with other case or stray whitespace is still denied (normalized hash, as hash-id.mjs)', () => {
  const p = apiProject();
  const world = p.world;
  // A production calendar that also carries the test name, ownership and marker: only the deny list stops it.
  const disguised = 'fake-prod-disguised-calendar';
  world.add(disguised, { name: NAMES.feed, description: `fc-test-marker:${MARKER}` });
  const deny = { FCT_DENY_SHA256: [hashId(disguised), sha(IDS.prodSynced)].join(',') };
  for (const variant of [disguised, disguised.toUpperCase(), ` ${disguised} `, `${disguised}\t`]) {
    assert.equal(guardCode(p, 'feed', { FCT_CAL_FEED_ID: variant, ...deny }), 'calendar-denied', JSON.stringify(variant));
  }
  assert.equal(hashId(' Some-ID '), sha('some-id'), 'hash-id normalizes like the guard');
  assert.equal(guardCode(p, 'feed', { FCT_CAL_SYNCED_ID: IDS.feed.toUpperCase() }), 'calendar-ids-equal', 'ids equal after normalization');
});

test('calendar guard: the marker must be the FIRST line of the calendar description, exactly (fails closed otherwise)', () => {
  const p = apiProject();
  const describe = (id, description) => (w) => { const c = w.calendars.get(id); const old = c.description; c.description = description; return () => { c.description = old; }; };
  const line = `fc-test-marker:${MARKER}`;
  const none = {};
  // Accepted: the marker line alone, followed by other lines (LF or CRLF), or with surrounding whitespace on that line.
  for (const ok of [line, `${line}\nsynthetic`, `${line}\r\nsynthetic`, ` ${line}\t\nnotes`]) {
    for (const role of ['feed', 'synced']) assert.equal(guardCode(p, role, none, describe(IDS[role], ok)), null, JSON.stringify(ok));
  }
  // Refused: the marker on a later line, after other text on line 1, with a suffix, truncated, after a blank first line.
  const refused = [
    `synthetic\n${line}`, `notes ${line}`, `${line}extra`, `${line}${hex('more', 8)}`, `${line.slice(0, -1)}`,
    `\n${line}`, `x\r\n${line}`, '', null, undefined, 42,
  ];
  for (const bad of refused) {
    for (const role of ['feed', 'synced']) assert.equal(guardCode(p, role, none, describe(IDS[role], bad)), 'calendar-marker', JSON.stringify(bad));
  }
  // A 32-hex marker property is not satisfied by a longer marker that merely starts with it.
  const shortMarker = MARKER.slice(0, 32);
  assert.equal(guardCode(p, 'feed', { FCT_MARKER: shortMarker }, describe(IDS.feed, `fc-test-marker:${shortMarker}${hex('tail', 32)}`)), 'calendar-marker');
  // The seeder applies the same guard.
  const w = makeWorld();
  w.calendars.get(IDS.feed).description = `synthetic\n${line}`;
  const s = seederProject({ world: w });
  assert.equal(plain(s.t.fctSeedAll()).reason, 'calendar-marker');
  assert.equal(w.writes.length, 0, 'nothing written');
});

test('S12: the denied-calendar case hashes the feed id normalized like the guard (mixed case, surrounding whitespace)', () => {
  for (const variant of ['Fake-Feed-MiXeD-Case', '  fake-feed-padded\t', ' Fake-Feed-Both ']) {
    const world = makeWorld();
    world.add(variant, { name: NAMES.feed, description: `fc-test-marker:${MARKER}` });
    const p = apiProject({ world, props: apiProps({ FCT_CAL_FEED_ID: variant }) });
    const r = plain(p.t.fctSmokeRun_(['S12'], p.t.fctSmokeCtx_(null)));
    assert.deepEqual(r.results.map((x) => [x.id, x.pass, x.failed]), [['S12', true, undefined]], JSON.stringify(variant));
  }
});

// --- API project end to end -------------------------------------------------------------------------------------

test('guarded happy path end to end: every smoke scenario passes against the seeded fake calendars with read-only scopes', () => {
  const { world, seeder: s } = seededWorld();
  const p = apiProject({ world });
  const first = plain(p.t.fctRunSmoke());
  const ids1 = first.results.map((r) => r.id);
  assert.deepEqual(ids1, ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S13']);
  assert.deepEqual(first.results.filter((r) => !r.pass), [], JSON.stringify(first.results.filter((r) => !r.pass)));
  const s4 = first.results.find((r) => r.id === 'S4');
  assert.ok(s4.counts.total >= 50 && s4.counts.indexed === s4.counts.total, 'historical indexing completes over every sealable month');
  assert.ok(s4.counts.keys > 0);
  assert.ok(first.results.find((r) => r.id === 'S13').counts.checked >= 2);
  // The seeder changes the schedule; one hour later the second run sees it and re-verifies every month.
  s.t.fctApplyScheduleChange();
  const writesAfterSeed = world.writes.length;
  p.clock.t += 3600000;
  const after = plain(p.t.fctRunSmokeAfterChange());
  assert.deepEqual(after.results.map((r) => [r.id, r.pass]), [['S6', true]]);
  assert.ok(after.results[0].counts.calls >= 1);
  const finish = plain(p.t.fctRunSmokeFinish());
  assert.deepEqual(finish.results.map((r) => r.id), ['S7', 'S8', 'S9', 'S10', 'S11', 'S12']);
  assert.deepEqual(finish.results.filter((r) => !r.pass), [], JSON.stringify(finish.results.filter((r) => !r.pass)));
  assert.deepEqual(finish.summary, { summary: true, pass: 6, fail: 0, skipped: 0 });
  // Platform-level facts the whole run proves: no write, no denied call, no network, no Sheet, no identity call outside the scope.
  assert.equal(world.writes.length, writesAfterSeed, 'the API project never wrote an event');
  assert.deepEqual(p.spies.denied, []);
  assert.equal(p.spies.fetch + p.spies.spreadsheet + p.spies.sessionDenied, 0);
  assert.ok(p.spies.reads.every(([id]) => id === IDS.feed || id === IDS.synced));
  // Output: one JSON line per scenario, no secret, id, name or URL.
  const out = p.spies.console.join('\n');
  for (const secret of [p.props.FC_V2_TOKEN, p.props.FC_CREW_PEPPER, SELF, IDS.feed, IDS.synced, NAMES.feed, MARKER, OWNER, 'TESTCREW', 'SAMPLE', 'script.google.com']) assert.equal(out.includes(secret), false, secret);
  assert.equal(/\b\d{6}[A-Z]\b/.test(out), false);
  for (const line of p.spies.console) JSON.parse(line);
  // The smoke properties end tidy: no code, no confirmation, no backup, and the token is still intact.
  for (const k of ['FC_CREW_ENROLL', 'FC_CREW_PURGE_CONFIRM', 'FCT_SMOKE_STATE_BACKUP']) assert.equal(p.svc.scriptProps.map.has(k), false, k);
  assert.equal(p.svc.scriptProps.map.get('FC_V2_TOKEN'), p.props.FC_V2_TOKEN);
  assert.equal(p.svc.userProps.map.size, 0, 'no crew record is left in the User Properties');
});

test('smoke scenarios report FAIL by fixed names when the project is mis-set (nothing about the value)', () => {
  const { world } = seededWorld();
  // Crew switched off: capabilities offer no crew action, enrollment is refused.
  const p = apiProject({ world, props: apiProps({ FC_CREW_ENABLED: 'off' }) });
  const r = plain(p.t.fctRunSmoke());
  const s1 = r.results.find((x) => x.id === 'S1');
  assert.equal(s1.pass, false);
  assert.ok(s1.failed.includes('has-crew') && !JSON.stringify(s1).includes(OWNER));
  assert.ok(r.summary.fail >= 2);
  // Unseeded calendars: S0 says so.
  const empty = apiProject({ world: makeWorld() });
  const s0 = plain(empty.t.fctRunSmoke()).results.find((x) => x.id === 'S0');
  assert.equal(s0.pass, false);
  assert.ok(s0.failed.includes('feed-seeded') && s0.failed.includes('synced-seeded'));
  // S6 without a baseline is skipped, not failed.
  const none = plain(apiProject({ world }).t.fctRunSmokeAfterChange());
  assert.deepEqual(none.results, [{ id: 'S6', pass: false, skipped: 'no-baseline' }]);
  assert.deepEqual(none.summary, { summary: true, pass: 0, fail: 0, skipped: 1 });
});

test('S0 names the cross-project tag problem if the sync tag set by the seeder project is invisible to the API project', () => {
  const { world } = seededWorld();
  const p = apiProject({
    world,
    tweak: (g) => {
      const real = g.CalendarApp;
      g.CalendarApp = {
        getCalendarById: (id) => {
          const cal = real.getCalendarById(id);
          if (!cal) return cal;
          return { ...cal, getEvents: (a, b) => cal.getEvents(a, b).map((ev) => ({ ...ev, getTag: () => null })) };   // tags private to the script that set them
        },
      };
    },
  });
  const s0 = plain(p.t.fctSmokeRun_(['S0'], p.t.fctSmokeCtx_(null))).results[0];
  assert.equal(s0.pass, false);
  assert.ok(s0.failed.includes('sync-tag-visible-across-projects'));
  assert.ok(s0.counts.syncedAll > 0 && s0.counts.synced === 0);
});

test('crew lookup answers match the fixture expectations (counts per colleague, no identifiers, redacted unavailable members)', () => {
  const seeded = seededWorld();
  const { world } = seeded;
  const p = apiProject({ world });
  const fx = plain(p.t.fctFixture_(TODAY));
  const grant = 'fctest-grant-for-lookup-0001';
  p.svc.scriptProps.map.set('FC_CREW_ENROLL', `code-lookup|${NOW + 600000}`);
  assert.equal(p.call('crewEnroll', { grant, code: 'code-lookup' }).ok, true);
  let r;
  for (let i = 0; i < 20; i++) { r = p.call('crewIndex', { grant }); if (r.progress.indexed === r.progress.total) break; }
  assert.equal(r.progress.indexed, r.progress.total);
  const env = p.t.fctEnv_();
  const sectorOf = (flightNumber) => {
    const raw = env.airlineEvents(Date.parse('2026-10-23T00:00:00Z'), Date.parse('2027-06-01T00:00:00Z')).find((e) => e.title.startsWith(`${flightNumber} `));
    return { sectorId: `s_${sha(raw.sourceId).slice(0, 16)}`, date: localDate(raw.start, 'Europe/Berlin') };
  };
  const look = (key) => p.call('crew', { grant, ...sectorOf(fx.expect[key].flightNumber) });
  const primary = look('primary');
  assert.equal(primary.ok, true, JSON.stringify(primary));
  assert.deepEqual(primary.members.map((m) => [m.rank, m.family, m.given, m.match, m.count]),
    fx.expect.primary.members.map((m) => [m.rank, m.family, m.given, m.count > 0 ? 'recorded' : 'none', m.count]));
  assert.ok(fx.expect.primary.members.every((m) => m.count !== 1) && fx.expect.primary.members.some((m) => m.count > 10), 'recurring crews: non-trivial counts');
  assert.equal(primary.history.state, 'incomplete');
  assert.deepEqual(primary.history.reasons, ['missing-records']);
  const text = JSON.stringify(primary);
  assert.equal(/\b\d{6}[A-Z]\b/.test(text), false);
  assert.equal(text.includes('"key"'), false);
  const noList = look('noCrewList');
  assert.deepEqual([noList.ok, noList.crewListed, noList.members.length, noList.history], [true, false, 0, null]);
  const invalid = look('invalid');
  assert.equal(invalid.members.length, fx.expect.invalid.members);
  assert.equal(invalid.members.filter((m) => m.match === 'unavailable').length, fx.expect.invalid.unavailable);
  assert.equal(invalid.members.filter((m) => m.rank === null).length, 2, 'unparseable lines are listed without any field');
  // The grant is checked; a wrong one is refused.
  assert.equal(p.call('crew', { grant: 'wrong', ...sectorOf(fx.expect.primary.flightNumber) }).error, 'unauthorized');
  // The sector of the schedule-change flight keeps its id when the seeder moves it and swaps a member.
  const before = sectorOf(fx.expect.scheduleChange.flightNumber);
  const changed = look('scheduleChange');
  assert.deepEqual(changed.members.map((m) => m.family), fx.expect.scheduleChange.before.map((m) => m.family));
  assert.equal(plain(seeded.seeder.t.fctApplyScheduleChange()).applied, true);
  const afterSector = sectorOf(fx.expect.scheduleChange.flightNumber);
  assert.equal(afterSector.sectorId, before.sectorId);
  const swapped = p.call('crew', { grant, ...afterSector });
  assert.deepEqual(swapped.members.map((m) => m.family), fx.expect.scheduleChange.after.map((m) => m.family));
});

test('revocation receipts are grant-specific: another grant never gets a deletion answer from someone else\'s receipt', () => {
  const { world } = seededWorld();
  const p = apiProject({ world });
  const enroll = (grant, code) => { p.svc.scriptProps.map.set('FC_CREW_ENROLL', `${code}|${p.clock.t + 600000}`); return p.call('crewEnroll', { grant, code }); };
  assert.equal(enroll('grant-a-fctest-000000000001', 'code-a').ok, true);
  assert.equal(p.call('crewIndex', { grant: 'grant-a-fctest-000000000001' }).ok, true);
  const first = p.call('crewRevoke', { grant: 'grant-a-fctest-000000000001', revokeId: 'rev-shared-id' });
  assert.deepEqual([first.ok, first.state], [true, 'deleted']);
  assert.ok(first.deletedKeys > 0);
  const replay = p.call('crewRevoke', { grant: 'grant-a-fctest-000000000001', revokeId: 'rev-shared-id' });
  assert.deepEqual([replay.state, replay.recorded], ['deleted', true], 'the same grant gets its own receipt back');
  // Another grant with the SAME revoke id: not answered from A's receipt.
  const other = p.call('crewRevoke', { grant: 'grant-b-fctest-000000000002', revokeId: 'rev-shared-id' });
  assert.deepEqual([other.ok, other.state, other.recorded], [true, 'cancelled', undefined]);
  // A live grant B revoking with A's id really deletes (never a recorded answer).
  assert.equal(enroll('grant-c-fctest-000000000003', 'code-c').ok, true);
  assert.equal(p.call('crewIndex', { grant: 'grant-c-fctest-000000000003' }).ok, true);
  const live = p.call('crewRevoke', { grant: 'grant-c-fctest-000000000003', revokeId: 'rev-shared-id' });
  assert.deepEqual([live.state, live.recorded], ['deleted', undefined]);
  assert.ok(live.deletedKeys > 0);
  // A cancelled grant can never be activated, even with a valid code.
  const cancelled = enroll('grant-b-fctest-000000000002', 'code-b');
  assert.deepEqual([cancelled.ok, cancelled.error], [false, 'enroll-closed']);
  assert.ok(p.svc.scriptProps.map.has('FC_CREW_ENROLL'), 'the outstanding code stays available');
});

test('interrupted owner purge keeps the fence, refuses enrollment, and a retry without confirmation completes it', () => {
  const { world } = seededWorld();
  let failKey = null;
  const p = apiProject({
    world,
    tweak: (g) => {
      const real = g.PropertiesService;
      g.PropertiesService = {
        ...real,
        getUserProperties: () => {
          const u = real.getUserProperties();
          return { getKeys: () => u.getKeys(), getProperty: (k) => u.getProperty(k), setProperty: (k, v) => u.setProperty(k, v),
            deleteProperty: (k) => { if (failKey && k === failKey) throw new Error('injected delete failure'); return u.deleteProperty(k); } };
        },
      };
    },
  });
  const grant = 'grant-purge-fctest-0000000001';
  p.svc.scriptProps.map.set('FC_CREW_ENROLL', `code-p|${NOW + 600000}`);
  assert.equal(p.call('crewEnroll', { grant, code: 'code-p' }).ok, true);
  assert.equal(p.call('crewIndex', { grant }).ok, true);
  const keys = () => [...p.svc.userProps.map.keys()].filter((k) => k.startsWith('fcx.'));
  assert.ok(keys().length > 1);
  failKey = 'fcx.m';                                                       // the manifest is deleted last and fails
  p.svc.scriptProps.map.set('FC_CREW_PURGE_CONFIRM', 'PURGE-ALL-CREW-DATA');
  const first = plain(p.t.crewPurgeAll());
  assert.equal(first.outcome, 'incomplete');
  assert.ok(first.remaining >= 1);
  assert.equal(p.state().purging, true, 'the durable fence stays');
  assert.equal(p.svc.scriptProps.map.has('FC_CREW_PURGE_CONFIRM'), false, 'the confirmation was consumed by the fence');
  assert.equal(p.call('crew', { grant, sectorId: 's_0000000000000000', date: '2026-10-23' }).error, 'crew-not-enrolled', 'access is gone while the purge is incomplete');
  p.svc.scriptProps.map.set('FC_CREW_ENROLL', `code-q|${NOW + 600000}`);
  assert.equal(p.call('crewEnroll', { grant: 'grant-late-fctest-00000001', code: 'code-q' }).error, 'enroll-closed', 'enrollment is closed during an unfinished purge');
  failKey = null;                                                          // the fault is gone: retry, no confirmation needed
  const retry = plain(p.t.crewPurgeAll());
  assert.equal(retry.outcome, 'deleted');
  assert.equal(retry.remaining, 0);
  assert.deepEqual(keys(), []);
  assert.equal(p.state().purging, undefined);
  assert.equal(p.svc.scriptProps.map.has('FC_CREW_ENROLL'), false);
  // Without the fence and without the confirmation a purge is refused.
  assert.equal(plain(p.t.crewPurgeAll()).outcome, 'refused');
});

test('malformed FC_CREW_STATE fails closed, is never overwritten, and is restored byte for byte (also after a run that died)', () => {
  const { world } = seededWorld();
  const p = apiProject({ world });
  const grant = 'grant-state-fctest-000000001';
  p.svc.scriptProps.map.set('FC_CREW_ENROLL', `code-s|${NOW + 600000}`);
  p.call('crewEnroll', { grant, code: 'code-s' });
  const raw = p.svc.scriptProps.map.get('FC_CREW_STATE');
  const ctx = p.t.fctSmokeCtx_(null);
  const run = plain(p.t.fctSmokeRun_(['S10'], ctx));
  assert.deepEqual(run.results, [{ id: 'S10', pass: true }]);
  assert.equal(p.svc.scriptProps.map.get('FC_CREW_STATE'), raw, 'restored exactly');
  assert.equal(p.svc.scriptProps.map.has('FCT_SMOKE_STATE_BACKUP'), false);
  // Absent state stays absent.
  p.svc.scriptProps.map.delete('FC_CREW_STATE');
  assert.equal(plain(p.t.fctSmokeRun_(['S10'], p.t.fctSmokeCtx_(null))).results[0].pass, true);
  assert.equal(p.svc.scriptProps.map.has('FC_CREW_STATE'), false);
  // A run that died between the garbage write and the restore: the editor recovery puts the original back.
  p.svc.scriptProps.map.set('FC_CREW_STATE', raw);
  p.svc.scriptProps.map.set('FCT_SMOKE_STATE_BACKUP', JSON.stringify({ present: true, raw }));
  p.svc.scriptProps.map.set('FC_CREW_STATE', '{ garbage');
  assert.equal(p.call('crew', { grant, sectorId: 's_0000000000000000', date: '2026-10-23' }).error, 'crew-unavailable');
  assert.equal(p.t.fctRestoreState(), true);
  assert.equal(p.svc.scriptProps.map.get('FC_CREW_STATE'), raw);
  assert.equal(p.t.fctRestoreState(), false, 'nothing left to restore');
  // fctRunSmokeFinish also restores first, so a dead run is repaired by simply running again.
  p.svc.scriptProps.map.set('FCT_SMOKE_STATE_BACKUP', JSON.stringify({ present: true, raw }));
  p.svc.scriptProps.map.set('FC_CREW_STATE', '{ garbage');
  p.t.fctRunSmokeFinish();
  assert.equal(p.svc.scriptProps.map.has('FCT_SMOKE_STATE_BACKUP'), false);
});

test('cache cleanup: the live adapter removes entries, counters are cleaned, and a revocation reports no cache problem', () => {
  const { world } = seededWorld();
  const p = apiProject({ world });
  const run = plain(p.t.fctSmokeRun_(['S11'], p.t.fctSmokeCtx_(null)));
  assert.deepEqual(run.results, [{ id: 'S11', pass: true }]);
  assert.equal(p.svc.cache.has('fcv2-crew-enroll-failures'), false);
  assert.equal([...p.svc.cache.keys()].some((k) => k.startsWith('fctest-probe-')), false);
});

test('permission failures: no usable identity or a failing calendar read fails closed, without a leak', () => {
  const { world } = seededWorld();
  const grant = 'grant-perm-fctest-0000000001';
  const crewCalls = (p) => ({
    crew: p.call('crew', { grant, sectorId: 's_0000000000000000', date: '2026-10-23' }), enroll: p.call('crewEnroll', { grant, code: 'x' }),
    index: p.call('crewIndex', { grant }), revoke: p.call('crewRevoke', { grant, revokeId: 'r' }), caps: p.call('capabilities'),
  });
  // getEmail() returns '' (policy): crew is disabled, revocation unavailable, capabilities have no crew part.
  const blank = apiProject({ world, email: '' });
  const a = crewCalls(blank);
  assert.deepEqual([a.crew.error, a.enroll.error, a.index.error], ['crew-disabled', 'crew-disabled', 'crew-disabled']);
  assert.equal(a.revoke.error, 'crew-unavailable');
  assert.equal(a.caps.actions.some((x) => x.startsWith('crew')), false);
  // The manifest lacks userinfo.email: Session throws, the same outcome, and the roster still works.
  const noScope = apiProject({ world, scopes: [SCOPE_READ] });
  const b = crewCalls(noScope);
  assert.deepEqual([b.crew.error, b.enroll.error, b.index.error, b.revoke.error], ['crew-disabled', 'crew-disabled', 'crew-disabled', 'crew-unavailable']);
  assert.ok(noScope.spies.sessionDenied >= 1);
  assert.equal(noScope.call('roster', { from: '2026-10-24', to: '2026-11-30' }).ok, true);
  // Another account: identity mismatch.
  assert.equal(apiProject({ world, email: 'someone-else@example.invalid' }).call('crew', { grant, sectorId: 's_0000000000000000', date: '2026-10-23' }).error, 'crew-disabled');
  // A calendar read that throws after the guard passed: JSON error codes, no id or message.
  const failing = apiProject({ world });
  failing.svc.scriptProps.map.set('FC_CREW_ENROLL', `code-f|${NOW + 600000}`);
  assert.equal(failing.call('crewEnroll', { grant, code: 'code-f' }).ok, true);
  failing.svc.faults.getEvents = true;
  const roster = failing.rawPost({ contract: 'fc.roster', version: 2, token: failing.props.FC_V2_TOKEN, action: 'roster' });
  assert.equal(roster.text, '{"ok":false,"error":"server-error"}');
  const index = failing.call('crewIndex', { grant });
  assert.deepEqual(index, { ok: false, error: 'crew-unavailable' });
  const lookup = failing.call('crew', { grant, sectorId: 's_0000000000000000', date: '2026-10-23' });
  assert.deepEqual(lookup, { ok: false, error: 'crew-unavailable' });
  for (const text of [roster.text, JSON.stringify(index), JSON.stringify(lookup), ...failing.spies.console]) assert.equal(text.includes(IDS.feed) || text.includes('calendar read failed'), false);
  // A calendar lookup that throws inside the guard: not-configured.
  const lookupFault = apiProject({ world });
  lookupFault.svc.faults.lookup = true;
  assert.equal(lookupFault.rawPost({ contract: 'fc.roster', version: 2, token: lookupFault.props.FC_V2_TOKEN, action: 'capabilities' }).text, '{"ok":false,"error":"not-configured"}');
});

test('authentication and contract failures through the guarded doPost', () => {
  const { world } = seededWorld();
  const p = apiProject({ world });
  const token = p.props.FC_V2_TOKEN;
  assert.equal(p.post({ contract: 'fc.roster', version: 2, action: 'capabilities' }).error, 'unauthorized');
  assert.equal(p.post({ contract: 'fc.roster', version: 2, token: `fctest_${hex('wrong')}`, action: 'capabilities' }).error, 'unauthorized');
  assert.equal(p.post({ contract: 'fc.roster', version: 3, token, action: 'capabilities' }).error, 'unsupported-contract');
  assert.equal(p.post({ contract: 'x', version: 2, token, action: 'capabilities' }).error, 'unsupported-contract');
  assert.equal(p.call('nope').error, 'unknown-action');
  assert.equal(p.call('crewPurgeAll').error, 'unknown-action', 'the purge is an editor function, never routable');
  assert.equal(p.post('not json').error, 'bad-request');
  assert.equal(p.post('x'.repeat(9000)).error, 'bad-request');
  assert.equal(p.call('crew', { grant: 'g', sectorId: 's_0000000000000000', date: '2026-10-23' }).error, 'crew-not-enrolled');
  // The failure limiter counts wrong tokens, and the right token is unaffected.
  const answers = [];
  for (let i = 0; i < 25; i++) answers.push(p.post({ contract: 'fc.roster', version: 2, token: 'wrong', action: 'capabilities' }).error);
  assert.ok(answers.includes('rate-limited'));
  assert.equal(p.call('capabilities').ok, true);
});

test('capabilities: the crew block is present under the gate, the provider actions are absent, nothing else is added', () => {
  const { world } = seededWorld();
  const caps = apiProject({ world }).call('capabilities');
  assert.deepEqual(caps.actions, ['capabilities', 'roster', 'history', 'stats', 'crewEnroll', 'crewIndex', 'crew', 'crewRevoke']);
  assert.equal(caps.limits.crewCancel, 1);
  assert.equal(caps.source.adapter, 'condor-calendar');
  // Crew switched off: revocation only.
  const off = apiProject({ world, props: apiProps({ FC_CREW_ENABLED: 'off' }) }).call('capabilities');
  assert.deepEqual(off.actions.filter((a) => a.startsWith('crew')), ['crewRevoke']);
});

test('platform model: the API manifest grants no write scope, so a write attempt is refused at the (faked) platform level', () => {
  const { world } = seededWorld();
  const p = apiProject({ world });
  const cal = p.sandbox.CalendarApp.getCalendarById(IDS.feed);
  assert.throws(() => cal.createEvent('x', new Date(NOW), new Date(NOW + 1), {}), /scope/);
  const ev = cal.getEvents(new Date(NOW), new Date(NOW + 400 * 86400000))[0];
  assert.throws(() => ev.setTag('a', 'b'), /scope/);
  assert.throws(() => ev.deleteEvent(), /scope/);
  assert.deepEqual(p.spies.denied.sort(), ['createEvent', 'deleteEvent', 'setTag']);
  assert.equal(world.writes.filter((w) => w[1] === 'createEvent').length, calendarEvents(world, IDS.feed).length + calendarEvents(world, IDS.synced).length);   // only the seeder's creates
  // The seeder's manifest has the write scope and the API's has not; the two are the only differences that matter.
  assert.equal(API_MANIFEST.oauthScopes.includes(SCOPE_WRITE), false);
  assert.equal(SEEDER_MANIFEST.oauthScopes.includes(SCOPE_WRITE), true);
  assert.equal(SEEDER_MANIFEST.oauthScopes.includes(SCOPE_EMAIL), false);
});
