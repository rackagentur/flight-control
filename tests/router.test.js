import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROUTES, parseHash, hrefFor, activeTabFor, DEFAULT_ROUTE } from '../src/router.js';

test('mobile tab bar is exactly Today / Calendar / Flights / Map / More', () => {
  assert.deepEqual(ROUTES.filter((r) => r.tab).map((r) => r.title), ['Today', 'Calendar', 'Flights', 'Map', 'More']);
});

test('More contains exactly Weather / Statistics / Controls / Settings', () => {
  assert.deepEqual(ROUTES.filter((r) => r.parent === 'more').map((r) => r.title), ['Weather', 'Statistics', 'Controls', 'Settings']);
});

test('every destination is reachable from the desktop sidebar (More itself is mobile-only)', () => {
  const sidebar = ROUTES.filter((r) => r.group !== 'hidden').map((r) => r.id);
  assert.deepEqual(sidebar.sort(), ['calendar', 'controls', 'flights', 'map', 'settings', 'statistics', 'today', 'weather']);
});

test('parseHash resolves known routes and falls back to Today', () => {
  assert.equal(parseHash('#/flights'), 'flights');
  assert.equal(parseHash('#/Settings'), 'settings');
  assert.equal(parseHash('#/map?x=1'), 'map');
  assert.equal(parseHash('#/nope'), DEFAULT_ROUTE);
  assert.equal(parseHash(''), DEFAULT_ROUTE);
  assert.equal(parseHash(undefined), DEFAULT_ROUTE);
  assert.equal(parseHash('#/<script>'), DEFAULT_ROUTE);
});

test('hrefFor and activeTabFor', () => {
  assert.equal(hrefFor('calendar'), '#/calendar');
  assert.equal(activeTabFor('weather'), 'more');
  assert.equal(activeTabFor('settings'), 'more');
  assert.equal(activeTabFor('today'), 'today');
});

test('flights detail: one sub-path, decoded; other routes ignore sub-paths', async () => {
  const { parseParam, hrefFor, parseHash } = await import('../src/router.js');
  assert.equal(parseHash('#/flights/SAMPLE%2001-1-2'), 'flights');
  assert.equal(parseParam('#/flights/SAMPLE%2001-1-2'), 'SAMPLE 01-1-2');
  assert.equal(hrefFor('flights', 'SAMPLE 01-1-2'), '#/flights/SAMPLE%2001-1-2');
  assert.equal(parseParam('#/flights'), null);
  assert.equal(parseParam('#/flights/'), null);
  assert.equal(parseParam('#/today/x'), null);
  assert.equal(parseParam('#/flights/%E0%A4%A'), null, 'malformed encoding is ignored');
});
