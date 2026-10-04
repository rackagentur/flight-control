// Profile: the operational crew base drives rotations; the hotel list is display-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROFILE, normalizeProfile } from '../src/config/profile.js';
import { fixtureSnapshot, pipeline, PROFILE } from './helpers.js';

test('default crew base is FRA only; the v5 "no hotel needed" list is separate', () => {
  assert.deepEqual([...DEFAULT_PROFILE.homeBases], ['FRA']);
  assert.ok(DEFAULT_PROFILE.noHotelAirports.includes('BER'));
  assert.ok(!DEFAULT_PROFILE.homeBases.includes('BER'));
});

test('base is configurable and always part of the crew bases; invalid input falls back', () => {
  const p = normalizeProfile({ base: 'MUC', homeBases: ['XYZ1', 'DUS'] });
  assert.equal(p.base, 'MUC');
  assert.deepEqual([...p.homeBases], ['MUC', 'DUS']);
  assert.deepEqual([...normalizeProfile({ homeBases: [] }).homeBases], ['FRA']);
  assert.deepEqual([...normalizeProfile({ noHotelAirports: ['BER', 'bad'] }).noHotelAirports], ['BER']);
});

/** FRA→BER Monday, BER→FRA Thursday (mirrors the live roster shape, synthetic data). */
function berRotation() {
  return fixtureSnapshot((p) => {
    const mon = Date.parse('2026-10-05T06:00:00Z');
    const thu = Date.parse('2026-10-08T15:00:00Z');
    p.upcoming = [
      { ...p.upcoming[0], flightNumber: 'DE9001', origin: 'FRA', destination: 'BER', depTimestamp: mon, endTimestamp: mon + 65 * 60000, pickupTimestamp: null },
      { ...p.upcoming[1], flightNumber: 'DE9002', origin: 'BER', destination: 'FRA', depTimestamp: thu, endTimestamp: thu + 70 * 60000, pickupTimestamp: null },
    ];
    // Tue/Wed are not free in the source (a non-flight duty is listed); Fri is free.
    p.daysOff = [{ count: 1, daysUntil: 5, startDate: 'x', endDate: 'x' }];
  });
}

test('FRA→BER then BER→FRA is one away rotation with an inferred BER layover (BER is not a base)', () => {
  const { roster, state } = pipeline(berRotation(), '2026-10-06T10:00:00Z');
  assert.equal(roster.rotations.length, 1);
  assert.equal(roster.rotations[0].closed, true);
  assert.deepEqual(roster.rotations[0].layovers.map((l) => [l.airport, l.confidence, l.provenance]), [['BER', 'inferred', 'derived']]);
  assert.equal(state.status, 'layover');
  assert.equal(state.location, 'BER');
  assert.ok(state.reasons.some((r) => /non-flight duty/.test(r)), 'source-listed duty stays visible');
});

test('layover days keep the source evidence of a listed duty', () => {
  const { roster } = pipeline(berRotation(), '2026-10-05T05:00:00Z');
  const tue = roster.days.find((d) => d.date === '2026-10-06');
  assert.equal(tue.status, 'layover');
  assert.equal(tue.evidence, 'duty-unspecified');
});

test('with the legacy list as bases, the same itinerary would be two trips (regression guard)', () => {
  const legacy = { ...PROFILE, homeBases: ['FRA', 'CGN', 'DUS', 'MUC', 'HAM', 'BER'] };
  const { roster } = pipeline(berRotation(), '2026-10-06T10:00:00Z', legacy);
  assert.equal(roster.rotations.length, 2);
});

test('another crew member: setting only the base never leaks FRA in as a base', () => {
  const muc = normalizeProfile({ base: 'MUC' });
  assert.equal(muc.base, 'MUC');
  assert.deepEqual([...muc.homeBases], ['MUC']);
  const viaBases = normalizeProfile({ homeBases: ['MUC'] });
  assert.equal(viaBases.base, 'MUC');
  assert.deepEqual([...viaBases.homeBases], ['MUC']);
  const both = normalizeProfile({ base: 'DUS', homeBases: ['MUC'] });
  assert.deepEqual([...both.homeBases], ['DUS', 'MUC']);
  assert.ok(!both.homeBases.includes('FRA'));
});
