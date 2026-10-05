// S6: removing the access token clears every roster-derived key and the in-memory roster;
// only non-sensitive preferences (theme, endpoint, profile, schema) stay.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController, TOKEN_KEY, ENDPOINT_KEY } from '../src/controller.js';
import { createStore } from '../src/store.js';
import { ApiError } from '../src/api/appscript.js';
import { today as todayScreen } from '../src/ui/screens/today.js';
import { calendar } from '../src/ui/screens/calendar.js';
import { flights as flightsScreen } from '../src/ui/screens/flights.js';
import { contractLine } from '../src/ui/screens/settings.js';
import { PROFILE, loadFixture, at } from './helpers.js';

const NOW = at(loadFixture()._now);
const TOKEN = 'test-token-0123456789abcdef';
const ENDPOINT = `https://script.google.com/macros/s/${'A'.repeat(30)}/exec`;
const ROSTER_KEYS = ['cache.v5', 'history.v5', 'cache.v2', 'history.v2'];
const HISTORY = [{ id: 'k', flightNumber: 'DE5555', origin: 'FRA', destination: 'BER', dep: NOW - 5 * 86400000, arr: NOW - 5 * 86400000 + 3600000 }];

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}

/** Store holding every roster key plus the preferences that must survive. */
function seeded({ token = TOKEN } = {}) {
  const store = createStore(memoryStorage());
  store.set(ENDPOINT_KEY, ENDPOINT);
  if (token) store.set(TOKEN_KEY, token);
  store.set('theme', 'dark');
  store.setJSON('profile', { name: 'Test' });
  store.setJSON('cache.v5', { payload: loadFixture(), fetchedAt: NOW - 3600000 });
  store.setJSON('history.v5', HISTORY);
  store.setJSON('cache.v2', { payload: { stale: true }, fetchedAt: NOW - 3600000 });
  store.setJSON('history.v2', { fetchedAt: NOW - 3600000, sectors: [] });
  return store;
}

function harness(store, { stats, post } = {}) {
  const calls = { stats: 0 };
  const api = {
    fetchStats: async () => { calls.stats += 1; if (stats) return stats(); return { data: loadFixture(), meta: {} }; },
    postContract: async (...args) => { if (post) return post(...args); throw new ApiError('html-response', 'no v2'); },
  };
  let last = null;
  const c = createController({ profile: PROFILE, onChange: (v) => { last = v; }, store, api, clock: () => NOW });
  return { c, calls, view: () => last ?? c.view() };
}

const refuse = () => { throw new ApiError('auth-required', 'This roster backend requires the access token (Settings → Roster contract v2).'); };
const tick = () => new Promise((r) => setTimeout(r, 0));

test('S6: removing the token purges all four roster keys and keeps theme, endpoint, profile', async () => {
  const store = seeded();
  const h = harness(store, { stats: refuse });
  await h.c.load({ force: true });
  assert.ok(h.view().snapshot, 'cached roster shown while the token is stored');
  h.c.removeToken();
  await tick();
  for (const key of ROSTER_KEYS) assert.equal(store.get(key), null, `${key} removed`);
  assert.equal(store.get(TOKEN_KEY), null);
  assert.equal(store.get('theme'), 'dark');
  assert.equal(store.get(ENDPOINT_KEY), ENDPOINT);
  assert.deepEqual(store.getJSON('profile'), { name: 'Test' });
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
  await tick();
  assert.ok(release, 'the pre-removal live read is in flight');
  assert.ok(h.c.view().snapshot, 'cache visible while the live read is pending');
  h.c.removeToken();
  assert.equal(h.c.view().snapshot, null);
  release();
  await pending;
  await tick();
  assert.equal(h.c.view().snapshot, null, 'stale live result is not shown');
  assert.equal(store.get('cache.v5'), null, 'stale live result is not written back');
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
  assert.ok(store.getJSON('cache.v5'));
});

test('S6: open backend without a token still works: a successful live read shows and caches the roster', async () => {
  const store = seeded({ token: null });
  const h = harness(store);
  await h.c.load();
  assert.equal(h.c.view().error, null);
  assert.ok(h.c.view().snapshot);
  assert.ok(store.getJSON('cache.v5'));
});

test('S6: replacing the token keeps device history (only contract caches are forgotten)', async () => {
  const store = seeded();
  const h = harness(store, { stats: refuse });
  await h.c.load({ force: true });
  h.c.forgetContractData();
  assert.deepEqual(store.getJSON('history.v5'), HISTORY);
  assert.ok(store.getJSON('cache.v5'));
  assert.equal(store.getJSON('cache.v2'), null);
  assert.equal(store.getJSON('history.v2'), null);
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
  assert.ok(Array.isArray(store.getJSON('history.v5')), 'device history written again');
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
