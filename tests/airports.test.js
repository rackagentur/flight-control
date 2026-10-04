// Tests for the merged airport reference table (src/data/airports.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { AIRPORTS, KNOWN_IATA, airport } from '../src/data/airports.js';

const TONES = new Set(['ocean', 'olive', 'sand', 'stone']);

// Every IATA code that appeared in any legacy lookup table (names, time zones,
// offsets, coordinates, country maps, city lists, home bases).
const EXPECTED_CODES = [
  'ACE', 'ADB', 'AGA', 'AGP', 'AKL', 'ALC', 'AMS', 'ARN', 'ATH', 'ATL', 'AUH', 'AYT',
  'BAH', 'BCN', 'BER', 'BGO', 'BHX', 'BIO', 'BJV', 'BKK', 'BLL', 'BLQ', 'BOJ', 'BOS',
  'BRE', 'BRI', 'BRQ', 'BRU', 'BSL', 'BUD', 'CAG', 'CAI', 'CDG', 'CFU', 'CGN', 'CHQ',
  'CLJ', 'CLT', 'CMB', 'CMN', 'CPH', 'CPT', 'CRL', 'CTA', 'CUN', 'DEN', 'DFW', 'DJE',
  'DLM', 'DOH', 'DPS', 'DUS', 'DXB', 'EDI', 'EVN', 'EZE', 'FAO', 'FCO', 'FMM', 'FNC',
  'FRA', 'FUE', 'GDN', 'GIG', 'GOT', 'GRU', 'GRX', 'GRZ', 'GVA', 'GYD', 'HAJ', 'HAM',
  'HAV', 'HEL', 'HER', 'HKG', 'HKT', 'HND', 'HRG', 'IAD', 'IBZ', 'ICN', 'INN', 'IST',
  'JED', 'JFK', 'JMK', 'JTR', 'KEF', 'KGS', 'KRK', 'KUL', 'KVA', 'KWI', 'LAS', 'LAX',
  'LEJ', 'LGW', 'LHR', 'LIS', 'LPA', 'LXR', 'LYS', 'MAD', 'MAH', 'MAN', 'MBA', 'MBJ',
  'MCO', 'MCT', 'MEL', 'MEX', 'MIA', 'MIR', 'MLA', 'MLE', 'MMX', 'MRS', 'MRU', 'MUC',
  'MXP', 'NAP', 'NCE', 'NRT', 'NUE', 'OLB', 'OPO', 'ORD', 'ORY', 'OSL', 'OTP', 'PDL',
  'PEK', 'PHX', 'PMI', 'PMO', 'PRG', 'PSA', 'PTP', 'PUJ', 'PVG', 'PVK', 'RAK', 'RHO',
  'RTM', 'RUH', 'SAW', 'SDQ', 'SEA', 'SEZ', 'SFO', 'SIN', 'SKG', 'SOF', 'SSH', 'STN',
  'STR', 'SVQ', 'SYD', 'SZG', 'TBS', 'TFS', 'TLS', 'TNG', 'TRD', 'TRS', 'TUN', 'TXL',
  'VAR', 'VCE', 'VIE', 'VLC', 'VRA', 'WAW', 'YEG', 'YHZ', 'YOW', 'YUL', 'YVR', 'YWG',
  'YYC', 'YYZ', 'ZNZ', 'ZRH', 'ZTH',
];

test('every entry is well-formed', () => {
  for (const [key, entry] of Object.entries(AIRPORTS)) {
    assert.match(key, /^[A-Z]{3}$/, `key ${key}`);
    assert.equal(entry.iata, key, `iata of ${key}`);
    assert.doesNotThrow(
      () => new Intl.DateTimeFormat('en', { timeZone: entry.tz }),
      `tz of ${key}: ${entry.tz}`,
    );
    assert.match(entry.cc, /^[A-Z]{2}$/, `cc of ${key}`);
    assert.ok(TONES.has(entry.tone), `tone of ${key}: ${entry.tone}`);
    assert.equal(typeof entry.city, 'string', `city type of ${key}`);
    assert.ok(entry.city.trim().length > 0, `city of ${key}`);
    assert.equal(typeof entry.country, 'string', `country type of ${key}`);
    assert.ok(entry.country.trim().length > 0, `country of ${key}`);
    if (entry.lat !== null) {
      assert.equal(typeof entry.lat, 'number', `lat type of ${key}`);
      assert.ok(entry.lat >= -90 && entry.lat <= 90, `lat of ${key}`);
    }
    if (entry.lon !== null) {
      assert.equal(typeof entry.lon, 'number', `lon type of ${key}`);
      assert.ok(entry.lon >= -180 && entry.lon <= 180, `lon of ${key}`);
    }
    assert.equal(entry.lat === null, entry.lon === null, `lat/lon pair of ${key}`);
  }
});

test('table and entries are frozen', () => {
  assert.ok(Object.isFrozen(AIRPORTS));
  assert.ok(Object.isFrozen(KNOWN_IATA));
  assert.ok(Object.isFrozen(AIRPORTS.FRA));
});

test('KNOWN_IATA lists exactly the keys of AIRPORTS', () => {
  assert.deepEqual([...KNOWN_IATA], Object.keys(AIRPORTS));
});

test('coverage: every legacy IATA code is present', () => {
  assert.equal(new Set(EXPECTED_CODES).size, EXPECTED_CODES.length, 'no duplicates in EXPECTED_CODES');
  const missing = EXPECTED_CODES.filter((code) => !Object.hasOwn(AIRPORTS, code));
  assert.deepEqual(missing, []);
});

test('time zone spot checks', () => {
  const expected = {
    FRA: 'Europe/Berlin',
    YYZ: 'America/Toronto',
    DXB: 'Asia/Dubai',
    BKK: 'Asia/Bangkok',
    PHX: 'America/Phoenix',
    KEF: 'Atlantic/Reykjavik',
    TFS: 'Atlantic/Canary',
    LIS: 'Europe/Lisbon',
  };
  for (const [code, tz] of Object.entries(expected)) {
    assert.equal(AIRPORTS[code].tz, tz, code);
  }
});

test('airport() lookup', () => {
  assert.equal(airport('yyz').city, 'Toronto');
  assert.equal(airport('YYZ'), AIRPORTS.YYZ);
  assert.equal(airport('ZZZ'), null);
  assert.equal(airport(undefined), null);
  assert.equal(airport(null), null);
  assert.equal(airport(42), null);
  assert.equal(airport(''), null);
  assert.equal(airport('constructor'), null);
  assert.equal(airport('__proto__'), null);
});
