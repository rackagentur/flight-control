// S6: removing the access token clears every roster-derived key and the in-memory roster.
// Step 6.6 (owner decision D-011): Sign out keeps non-sensitive preferences (theme, time display,
// endpoint, operational profile fields) and removes the account-specific profile fields (name,
// saved-hotel-list link); Reset removes everything; a token change purges the previous source's data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController, TOKEN_KEY, ENDPOINT_KEY } from '../src/controller.js';
import { createStore } from '../src/store.js';
import { ApiError } from '../src/api/appscript.js';
import { today as todayScreen } from '../src/ui/screens/today.js';
import { calendar } from '../src/ui/screens/calendar.js';
import { flights as flightsScreen } from '../src/ui/screens/flights.js';
import { contractLine } from '../src/ui/screens/settings.js';
import { syncStatusText } from '../src/ui/sync-status.js';
import { PROFILE, loadFixture, at } from './helpers.js';

const NOW = at(loadFixture()._now);
const TOKEN = 'test-token-0123456789abcdef';
const ENDPOINT = `https://script.google.com/macros/s/${'A'.repeat(30)}/exec`;
const ROSTER_KEYS = ['roster.v1', 'cache.v5', 'history.v5', 'cache.v2', 'history.v2'];
const PREFS = { base: 'MUC', homeBases: ['MUC'], wakeupOffsetMin: 45, airlineId: 'condor' };
const PRIVATE_PROFILE = { name: 'Test', hotelListUrl: 'https://example.test/saved-list' };
const HISTORY = [{ id: 'k', flightNumber: 'DE5555', origin: 'FRA', destination: 'BER', dep: NOW - 5 * 86400000, arr: NOW - 5 * 86400000 + 3600000 }];

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}

/** Store holding every roster key plus the preferences that must survive. */
function seeded({ token = TOKEN, storage = memoryStorage() } = {}) {
  const store = createStore(storage);
  store.set(ENDPOINT_KEY, ENDPOINT);
  if (token) store.set(TOKEN_KEY, token);
  store.set('theme', 'dark');
  store.setJSON('profile', { ...PREFS, ...PRIVATE_PROFILE });
  store.set('timeDisplay', 'utc');
  store.setJSON('departures.v2', { cached: true });
  store.setJSON('cache.v5', { payload: loadFixture(), fetchedAt: NOW - 3600000 });
  store.setJSON('history.v5', HISTORY);
  store.setJSON('cache.v2', { payload: { stale: true }, fetchedAt: NOW - 3600000 });
  store.setJSON('history.v2', { fetchedAt: NOW - 3600000, sectors: [] });
  return store;
}

function harness(store, { stats, post, online = true } = {}) {
  const calls = { stats: 0, post: 0 };
  const api = {
    fetchStats: async () => { calls.stats += 1; if (stats) return stats(); return { data: loadFixture(), meta: {} }; },
    postContract: async (...args) => { calls.post += 1; if (post) return post(...args); throw new ApiError('html-response', 'no v2'); },
  };
  let last = null;
  const c = createController({ profile: PROFILE, onChange: (v) => { last = v; }, store, api, clock: () => NOW, isOnline: () => online });
  return { c, calls, view: () => last ?? c.view() };
}

const refuse = () => { throw new ApiError('auth-required', 'This roster backend requires the access token (Settings → Roster contract v2).'); };
const tick = () => new Promise((r) => setTimeout(r, 0));
/** Waits until a condition holds (bounded); never assumes a fixed number of turns of the event loop. */
async function until(condition, message, limitMs = 2000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > limitMs) assert.fail(`timed out waiting: ${message}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

test('Sign out: purges credentials, roster, history and operational caches; keeps non-sensitive preferences', async () => {
  const store = seeded();
  const h = harness(store, { stats: refuse });
  await h.c.load({ force: true });
  assert.ok(h.view().snapshot, 'cached roster shown while the token is stored');
  assert.equal(h.c.removeToken(), true);
  await tick();
  for (const key of ROSTER_KEYS) assert.equal(store.get(key), null, `${key} removed`);
  assert.equal(store.get(TOKEN_KEY), null);
  assert.equal(store.get('theme'), 'dark');
  assert.equal(store.get(ENDPOINT_KEY), ENDPOINT);
  assert.equal(store.get('timeDisplay'), 'utc');
  assert.equal(store.get('departures.v2'), null, 'departures cache removed');
  assert.equal(store.get('signedOut'), 'true', 'tombstone revokes access in other tabs');
  assert.deepEqual(store.getJSON('profile'), PREFS, 'home base, wake-up offset and airline kept; name and saved-list link removed');
  assert.equal(h.c.view().profile.base, 'MUC');
  assert.equal(h.c.view().profile.wakeupOffsetMin, 45);
  assert.equal(h.c.view().profile.name, '');
  assert.equal(h.c.view().profile.hotelListUrl, '');
});

test('Sign out: a profile holding only account-specific fields is removed entirely', async () => {
  const store = seeded();
  store.setJSON('profile', PRIVATE_PROFILE);
  const h = harness(store, { stats: refuse });
  h.c.removeToken();
  assert.equal(store.getJSON('profile'), null);
});

test('Reset: removes credentials, roster, history, preferences and caches, back to initial setup', async () => {
  const store = seeded();
  const h = harness(store, { stats: refuse });
  await h.c.load({ force: true });
  assert.equal(h.c.resetLocalData(), true);
  for (const key of [...ROSTER_KEYS, TOKEN_KEY, ENDPOINT_KEY, 'profile', 'theme', 'timeDisplay', 'departures.v2'])
    assert.equal(store.get(key), null, `${key} removed`);
  const v = h.c.view();
  assert.equal(v.snapshot, null);
  assert.equal(v.error, null, 'initial setup: no endpoint, no error');
  assert.equal(v.profile.base, 'FRA', 'profile back to defaults');
});

test('S6: after token removal view() exposes no roster, and no screen renders roster data', async () => {
  const store = seeded();
  const h = harness(store, { stats: refuse });
  await h.c.load({ force: true });
  h.c.removeToken();
  await tick();
  const v = h.c.view();
  assert.equal(v.snapshot, null);
  assert.equal(v.roster, null);
  assert.equal(v.horizon, null);
  assert.equal(v.error.code, 'auth-required');
  const ctx = { view: () => v, param: () => null, weather: () => null };
  const page = todayScreen.render(ctx).toString();
  assert.match(page, /Access token required/);
  assert.match(page, /Roster contract v2/);
  assert.doesNotMatch(page, /DE\d{3,4}|showing cached/);
  assert.match(calendar.render(ctx).toString(), /Access token required/);
  assert.match(flightsScreen.render(ctx).toString(), /Access token required/);
  assert.doesNotMatch(flightsScreen.render(ctx).toString(), /DE\d{3,4}/);
});

test('S6: removing the token drops a roster that is already on screen, and an in-flight load cannot restore it', async () => {
  const store = seeded();
  let release = null;
  // First read hangs (the pre-removal load); the post-removal read is refused.
  const h = harness(store, { stats: () => (release ? refuse() : new Promise((r) => { release = () => r({ data: loadFixture(), meta: {} }); })) });
  const pending = h.c.load({ force: true });
  await until(() => release, 'the pre-removal live read is in flight');
  assert.ok(h.c.view().snapshot, 'cache visible while the live read is pending');
  h.c.removeToken();
  assert.equal(h.c.view().snapshot, null);
  release();
  await pending;
  await tick();
  assert.equal(h.c.view().snapshot, null, 'stale live result is not shown');
  assert.equal(store.get('roster.v1'), null, 'stale live result is not written back');
  assert.equal(store.get('cache.v5'), null);
  assert.equal(store.get('history.v5'), null);
});

test('S6: start-up with endpoint and cache.v5 but no token shows no cache; auth-required ends empty and purged', async () => {
  const store = seeded({ token: null });
  let shownBeforeLive = 'unset';
  const h = harness(store, { stats: () => { shownBeforeLive = h.c.view().snapshot; return refuse(); } });
  await h.c.load();
  assert.equal(shownBeforeLive, null, 'no cached roster before the live attempt');
  const v = h.c.view();
  assert.equal(v.snapshot, null);
  assert.equal(v.error.code, 'auth-required');
  for (const key of ROSTER_KEYS) assert.equal(store.get(key), null, `${key} purged`);
  assert.equal(store.get('theme'), 'dark');
  assert.equal(store.get(ENDPOINT_KEY), ENDPOINT);
});

test('S6: with a token stored, an auth-required failure keeps the cache (existing behaviour)', async () => {
  const store = seeded();
  const h = harness(store, { stats: refuse });
  await h.c.load({ force: true });
  const v = h.c.view();
  assert.ok(v.snapshot, 'cached roster kept');
  assert.equal(v.error.code, 'auth-required');
  assert.ok(store.getJSON('roster.v1'));
});

test('S6: open backend without a token still works: a successful live read shows and caches the roster', async () => {
  const store = seeded({ token: null });
  const h = harness(store);
  await h.c.load();
  assert.equal(h.c.view().error, null);
  assert.ok(h.c.view().snapshot);
  assert.ok(store.getJSON('roster.v1'));
});

test('S6.6: replacing the token purges all previous-source history', async () => {
  const store = seeded();
  const h = harness(store, { stats: refuse });
  await h.c.load({ force: true });
  h.c.forgetContractData();
  assert.equal(store.getJSON('history.v5'), null);
  assert.equal(store.getJSON('roster.v1'), null);
  assert.equal(store.getJSON('cache.v2'), null);
  assert.equal(store.getJSON('history.v2'), null);
  assert.equal(store.get('departures.v2'), null, 'operational cache of the previous source removed');
  assert.deepEqual(store.getJSON('profile'), { ...PREFS, ...PRIVATE_PROFILE }, 'a token change keeps preferences');
  assert.equal(store.get('theme'), 'dark');
  assert.equal(store.get('timeDisplay'), 'utc');
  assert.equal(store.get(ENDPOINT_KEY), ENDPOINT);
});

test('Token change: an in-flight load under the previous token cannot write its roster back', async () => {
  const store = seeded();
  let release = null;
  const h = harness(store, { stats: () => (release ? refuse() : new Promise((r) => { release = () => r({ data: loadFixture(), meta: {} }); })) });
  const pending = h.c.load({ force: true });
  await until(() => release, 'the old-token live read is in flight');
  store.set(TOKEN_KEY, 'another-token-0123456789abcdef');
  h.c.forgetContractData();
  release();
  await pending;
  await tick();
  assert.equal(store.get('roster.v1'), null, 'no roster from the previous credentials');
  assert.equal(h.c.view().snapshot, null);
});

test('S6: history repopulates after the token is restored', async () => {
  const store = seeded();
  const h = harness(store);
  await h.c.load({ force: true });
  h.c.removeToken();
  await tick();
  store.set(TOKEN_KEY, TOKEN);
  h.c.forgetContractData();
  await h.c.load({ force: true });
  assert.ok(h.c.view().snapshot);
  assert.ok(Array.isArray(store.getJSON('roster.v1')?.history), 'device history written again');
});

test('S6: after token removal and an auth-required rejection, Calendar and Flights say "Access token required", not "No roster source connected"', async () => {
  const store = seeded();
  const h = harness(store, { stats: refuse });
  await h.c.load({ force: true });
  h.c.removeToken();
  await tick();
  const v = h.c.view();
  assert.equal(v.snapshot, null);
  assert.equal(v.error.code, 'auth-required');
  const ctx = { view: () => v, param: () => null, weather: () => null };
  for (const [name, screen] of [['calendar', calendar], ['flights', flightsScreen]]) {
    const page = screen.render(ctx).toString();
    assert.match(page, /Access token required/, `${name} headline`);
    assert.match(page, /Your roster is only shown with the access token\. Add it under Roster contract v2 in Settings\./, `${name} text`);
    assert.doesNotMatch(page, /No roster source connected/, `${name} no source wording`);
    assert.doesNotMatch(page, /DE\d{3,4}/, `${name} no roster data`);
  }
});

test('S6: with no endpoint configured, Calendar and Flights still say "No roster source connected"', async () => {
  const store = createStore(memoryStorage());
  const h = harness(store);
  await h.c.load({ force: true });
  const v = h.c.view();
  assert.equal(v.snapshot, null);
  assert.notEqual(v.error?.code, 'auth-required');
  const ctx = { view: () => v, param: () => null, weather: () => null };
  for (const [name, screen] of [['calendar', calendar], ['flights', flightsScreen]]) {
    const page = screen.render(ctx).toString();
    assert.match(page, /No roster source connected/, `${name} headline`);
    assert.match(page, /Connect it in Settings\./, `${name} text`);
    assert.doesNotMatch(page, /Access token required/, `${name} no token wording`);
  }
});

test('S6: Settings says the access token is required when none is stored and the backend refused; other contract lines are unchanged', async () => {
  const store = seeded();
  const h = harness(store, { stats: refuse });
  await h.c.load({ force: true });
  h.c.removeToken();
  await tick();
  const v = h.c.view();
  assert.equal(v.snapshot, null);
  assert.equal(v.error.code, 'auth-required');
  assert.match(contractLine(v, Boolean(store.get(TOKEN_KEY))), /^Access token required · the roster is only served with the token$/);
  // With a token saved, or with a roster on screen, or with another error, the existing wording stays.
  assert.equal(contractLine(v, true), 'Not loaded yet · token saved');
  assert.equal(contractLine({ ...v, snapshot: {} }, false), 'Not loaded yet');
  assert.equal(contractLine({ ...v, error: { code: 'network' } }, false), 'Not loaded yet');
  assert.equal(contractLine({ ...v, error: null }, false), 'Not loaded yet');
});

// Faults are armed only after the synthetic roster has been stored successfully.
function signOutStorage({ markerFailures = Infinity, endpointFailure = false, tokenFailure = false, silentMarkerFailure = false } = {}) {
  const storage = memoryStorage(), set = storage.setItem, remove = storage.removeItem;
  let armed = false;
  const attempts = [];
  storage.setItem = (key, value) => {
    if (armed && key === 'fc.v2.signedOut') {
      attempts.push(storage.getItem('fc.v2.roster.v1') !== null);
      if (attempts.length <= markerFailures) {
        if (silentMarkerFailure) return;
        throw new Error('Synthetic quota failure');
      }
    }
    set(key, value);
  };
  storage.removeItem = (key) => {
    if (armed && ((endpointFailure && key === 'fc.v2.endpoint') || (tokenFailure && key === 'fc.v2.token.v2'))) throw new Error('Synthetic deletion failure');
    remove(key);
  };
  return { storage, attempts, arm: () => { armed = true; } };
}

async function assertEmptyRestart(store) {
  for (const online of [true, false]) {
    const restarted = harness(store, { online }); // An open legacy source would return a roster if called.
    await restarted.c.load({ force: true });
    assert.equal(restarted.c.view().snapshot, null);
    assert.deepEqual(restarted.calls, { stats: 0, post: 0 });
    assert.equal(store.get('roster.v1'), null);
  }
}

test('durable sign-out: initial quota failure retries after roster cleanup, retains preferences and blocks open-source restart', async () => {
  const fault = signOutStorage({ markerFailures: 1 }), store = seeded({ storage: fault.storage }), h = harness(store);
  await h.c.load(); fault.arm();
  assert.equal(h.c.removeToken(), true);
  assert.deepEqual(fault.attempts, [true, false], 'retry happens after removing the saved roster');
  assert.equal(store.get('signedOut'), 'true');
  assert.equal(h.c.view().storageError, false);
  assert.equal(store.get(ENDPOINT_KEY), ENDPOINT);
  assert.equal(store.get('theme'), 'dark');
  assert.equal(store.get('timeDisplay'), 'utc');
  assert.deepEqual(store.getJSON('profile'), PREFS);
  await assertEmptyRestart(store);
});

for (const silentMarkerFailure of [false, true]) test(`durable sign-out: persistent ${silentMarkerFailure ? 'silent' : 'throwing'} marker failure disconnects, reports failure and cannot restore on restart`, async () => {
  const fault = signOutStorage({ silentMarkerFailure }), store = seeded({ storage: fault.storage }), h = harness(store);
  await h.c.load(); fault.arm();
  assert.equal(h.c.removeToken(), false, 'fallback secures access but marker failure must be reported');
  assert.equal(store.get('signedOut'), null);
  assert.equal(store.get(ENDPOINT_KEY), null);
  assert.equal(store.get(TOKEN_KEY), null);
  for (const key of [...ROSTER_KEYS, 'departures.v2']) assert.equal(store.get(key), null);
  assert.equal(h.c.view().snapshot, null);
  assert.equal(h.c.view().storageError, true);
  assert.match(syncStatusText(h.c.view()), /Clear website data in browser settings/);
  assert.equal(store.get('theme'), 'dark');
  assert.deepEqual(store.getJSON('profile'), PREFS);
  await h.c.refresh(); // The failure remains actionable even with no endpoint.
  assert.equal(h.c.view().error.code, 'storage');
  await assertEmptyRestart(store);
});

for (const tokenFailure of [false, true]) test(`durable sign-out: marker and endpoint removal failures keep current session closed (token deletion blocked: ${tokenFailure})`, async () => {
  const fault = signOutStorage({ endpointFailure: true, tokenFailure }), store = seeded({ storage: fault.storage }), h = harness(store);
  await h.c.load(); fault.arm();
  assert.equal(h.c.removeToken(), false);
  assert.equal(store.get(ENDPOINT_KEY), ENDPOINT);
  assert.equal(store.get('signedOut'), null);
  assert.equal(h.c.view().snapshot, null);
  assert.equal(h.c.view().profile.name, '');
  const before = { ...h.calls };
  await h.c.refresh(); await h.c.tick(); await h.c.connectivityChanged();
  h.c.accessChanged(); await tick(); // A storage event must not lift the failed local logout.
  assert.deepEqual(h.calls, before);
  assert.equal(h.c.view().snapshot, null);
  assert.equal(h.c.view().storageError, true);
  assert.equal(h.c.view().error.code, 'storage');
  assert.match(h.c.view().error.message, /Clear website data/);
});

test('durable sign-out: protected source still rejects missing credentials if persistent storage prevents disconnect', async () => {
  const fault = signOutStorage({ endpointFailure: true }), store = seeded({ storage: fault.storage }), h = harness(store);
  await h.c.load(); fault.arm(); assert.equal(h.c.removeToken(), false);
  const restarted = harness(store, { stats: refuse, post: async () => ({ data: { ok: false, error: 'unauthorized' } }) });
  await restarted.c.load();
  assert.equal(store.get(TOKEN_KEY), null);
  assert.equal(restarted.c.view().snapshot, null);
  assert.equal(store.get('roster.v1'), null);
  assert.equal(restarted.c.view().error.code, 'auth-required');
});

test('reset: marker write failure does not prevent successful namespace removal or recreate preferences', async () => {
  const fault = signOutStorage(), store = seeded({ storage: fault.storage }), h = harness(store);
  fault.storage.setItem('unrelated', 'keep');
  await h.c.load(); fault.arm();
  assert.equal(h.c.resetLocalData(), true);
  assert.equal(h.c.view().storageError, false);
  assert.equal(h.c.view().error, null);
  assert.equal(h.c.view().profile.base, 'FRA');
  assert.equal(fault.storage.length, 1);
  assert.equal(fault.storage.getItem('unrelated'), 'keep');
  await assertEmptyRestart(store);
});

for (const reset of [false, true]) test(`durable ${reset ? 'reset' : 'sign-out'}: same-credential reconnection rejects a pre-cleanup response`, async () => {
  const fault = signOutStorage({ markerFailures: 1 }), store = seeded({ storage: fault.storage });
  let release;
  const h = harness(store, { stats: () => release ? { data: loadFixture() } : new Promise((r) => { release = r; }) });
  const old = h.c.load(); await until(() => release, 'pending roster request'); fault.arm();
  assert.equal(reset ? h.c.resetLocalData() : h.c.removeToken(), true);
  store.set(ENDPOINT_KEY, ENDPOINT); store.set(TOKEN_KEY, TOKEN);
  h.c.forgetContractData(); await h.c.load();
  const saved = store.get('roster.v1'); assert.ok(saved);
  const stale = loadFixture(); stale.upcoming[0].flightNumber = 'DE9998';
  release({ data: stale }); await old; await tick();
  assert.equal(store.get('roster.v1'), saved);
  assert.equal(h.c.view().error, null);
  assert.ok(h.c.view().snapshot);
});
