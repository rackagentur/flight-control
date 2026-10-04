// "Seen on this device" history (Phase 6 decision D2): retention, identity, corrections,
// expiry and storage failure. Remembered sectors are never current roster data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rememberSectors, withHistory, sectorIdentity, validEntry, authoritativeWindow, KEEP_DAYS, MAX_SECTORS } from '../src/model/history.js';
import { createStore } from '../src/store.js';
import { at } from './helpers.js';

const DAY = 86400000;
const TZ = 'Europe/Berlin';

function sector(flightNumber, origin, destination, depIso, blockMin = 120, extra = {}) {
  const dep = at(depIso);
  return {
    id: `${flightNumber}-${dep}-${dep + blockMin * 60000}`, flightNumber, origin, destination, dep, arr: dep + blockMin * 60000, blockMin,
    originTz: TZ, destTz: TZ, pickup: null, provenance: 'source', legacy: null, ...extra,
  };
}

function snap(sectors, { coverageStart = null, flightCoverageEnd = null, warnings = [], fetchedAt = at('2026-10-04T06:00:00Z') } = {}) {
  return {
    source: { id: 't', label: 't', kind: 'fixture', fetchedAt }, capabilities: {}, sectors, windows: [], offBlocks: [],
    offCoverageEnd: null, coverageStart, flightCoverageEnd, dutyBlock: null, stats: null, map: null, achievements: [], warnings,
  };
}

test('retention: kept while the arrival is within 120 days, dropped after', () => {
  const now = at('2026-10-04T12:00:00Z');
  const inside = sector('XQ100', 'AAA', 'BBB', '2026-06-07T12:00:00Z');   // arrives 118.9 days ago
  const outside = sector('XQ101', 'AAA', 'BBB', '2026-06-05T10:00:00Z');  // arrives > 120 days ago
  const kept = rememberSectors([inside, outside], snap([]), now, TZ);
  assert.equal(KEEP_DAYS, 120);
  assert.deepEqual(kept.map((s) => s.flightNumber), ['XQ100']);
});

test('retention boundary is exact: arrival 120 days ago minus/plus one minute', () => {
  const now = at('2026-10-04T12:00:00Z');
  const edge = (offsetMin) => {
    const arr = now - KEEP_DAYS * DAY + offsetMin * 60000;
    return { ...sector('XQ200', 'AAA', 'BBB', '2026-01-01T00:00:00Z'), dep: arr - 120 * 60000, arr };
  };
  assert.equal(rememberSectors([edge(1)], snap([]), now, TZ).length, 1);
  assert.equal(rememberSectors([edge(0)], snap([]), now, TZ).length, 0);
});

test('capacity: at most 300 sectors, the most recent ones are kept', () => {
  const now = at('2026-10-04T12:00:00Z');
  const many = Array.from({ length: 320 }, (_, i) => ({ ...sector(`XQ${i}`, 'AAA', 'BBB', '2026-09-01T00:00:00Z'), dep: now - (i + 2) * 3 * 3600000, arr: now - (i + 2) * 3 * 3600000 + 3600000 }));
  const kept = rememberSectors(many, snap([]), now, TZ);
  assert.equal(MAX_SECTORS, 300);
  assert.equal(kept.length, 300);
  assert.ok(kept.every((s) => s.dep >= Math.min(...kept.map((k) => k.dep))));
  assert.ok(kept.some((s) => s.flightNumber === 'XQ0'), 'newest kept');
  assert.ok(!kept.some((s) => s.flightNumber === 'XQ319'), 'oldest dropped');
});

test('identity: flight number + route + local departure date; a retimed copy replaces, never duplicates', () => {
  const now = at('2026-10-04T06:00:00Z');
  const first = sector('XQ300', 'AAA', 'BBB', '2026-10-06T08:00:00Z');
  const retimed = sector('XQ300', 'AAA', 'BBB', '2026-10-06T09:30:00Z');
  assert.equal(sectorIdentity(first), sectorIdentity(retimed));
  const day1 = rememberSectors([], snap([first], { coverageStart: at('2026-10-03T22:00:00Z'), flightCoverageEnd: '2026-12-01' }), now, TZ);
  const day2 = rememberSectors(day1, snap([retimed], { coverageStart: at('2026-10-03T22:00:00Z'), flightCoverageEnd: '2026-12-01' }), now, TZ);
  assert.equal(day2.length, 1);
  assert.equal(day2[0].dep, retimed.dep);
});

test('corrections: inside the source window, a sector the source no longer lists is dropped', () => {
  const now = at('2026-10-04T06:00:00Z');
  const cancelled = sector('XQ400', 'AAA', 'BBB', '2026-10-08T08:00:00Z');
  const stays = sector('XQ401', 'AAA', 'BBB', '2026-10-09T08:00:00Z');
  const before = rememberSectors([], snap([cancelled, stays], { coverageStart: at('2026-10-03T22:00:00Z'), flightCoverageEnd: '2026-12-01' }), now, TZ);
  const after = rememberSectors(before, snap([stays], { coverageStart: at('2026-10-03T22:00:00Z'), flightCoverageEnd: '2026-12-01' }), now, TZ);
  assert.deepEqual(after.map((s) => s.flightNumber), ['XQ401']);
});

test('corrections: flown sectors before the window and sectors beyond a truncated list are kept', () => {
  const now = at('2026-10-04T06:00:00Z');
  const flown = sector('XQ500', 'AAA', 'BBB', '2026-10-01T08:00:00Z');
  const listed = [1, 2, 3, 4, 5].map((d) => sector(`XQ5${d}0`, 'AAA', 'BBB', `2026-10-0${d + 4}T08:00:00Z`));
  const beyond = sector('XQ599', 'AAA', 'BBB', '2026-10-20T08:00:00Z'); // seen earlier; beyond today's 5-flight list
  const truncated = snap(listed, { coverageStart: at('2026-10-03T22:00:00Z'), flightCoverageEnd: '2026-10-09', warnings: [{ code: 'upcoming-truncated', message: '' }] });
  const win = authoritativeWindow(truncated, TZ);
  assert.equal(win.end, listed.at(-1).dep);
  const kept = rememberSectors([flown, beyond], truncated, now, TZ);
  assert.ok(kept.some((s) => s.flightNumber === 'XQ500'));
  assert.ok(kept.some((s) => s.flightNumber === 'XQ599'), 'the source cannot speak beyond its 5th flight');
});

test('a payload without a flight list prunes nothing', () => {
  const now = at('2026-10-04T06:00:00Z');
  const future = sector('XQ600', 'AAA', 'BBB', '2026-10-08T08:00:00Z');
  const broken = snap([], { coverageStart: at('2026-10-03T22:00:00Z'), flightCoverageEnd: '2026-12-01', warnings: [{ code: 'missing-field', message: 'upcoming flights are missing' }] });
  assert.equal(rememberSectors([future], broken, now, TZ).length, 1);
});

test('expiry also applies when merging: an expired entry is never shown', () => {
  const now = at('2026-10-04T12:00:00Z');
  const old = { ...sector('XQ700', 'AAA', 'BBB', '2026-05-01T08:00:00Z') };
  const merged = withHistory(snap([], { coverageStart: at('2026-10-03T22:00:00Z') }), [old], now);
  assert.equal(merged.sectors.length, 0);
});

test('corrupted storage: junk entries are ignored, never crash, never shown', () => {
  const now = at('2026-10-04T12:00:00Z');
  const good = sector('XQ800', 'AAA', 'BBB', '2026-10-01T08:00:00Z');
  const junk = [null, 42, 'x', {}, { ...good, dep: 'soon' }, { ...good, arr: good.dep - 1 }, { ...good, origin: 'aa' },
    { ...good, flightNumber: '' }, { ...good, arr: good.dep + 30 * 3600000 }, { ...good, flightNumber: 'XQ801', originTz: 'Not/AZone' }];
  for (const j of junk.slice(0, 9)) assert.equal(validEntry(j), false);
  const kept = rememberSectors([...junk, good], snap([]), now, TZ);
  assert.deepEqual(kept.map((s) => s.flightNumber).sort(), ['XQ800', 'XQ801']);
  assert.equal(kept.find((s) => s.flightNumber === 'XQ801').originTz, null, 'an invalid zone is dropped, not trusted');
  assert.deepEqual(rememberSectors({ not: 'a list' }, snap([]), now, TZ), []);
  assert.doesNotThrow(() => withHistory(snap([]), [null, 'x', good], now));
});

test('storage failure: unreadable JSON falls back, failing writes report false', () => {
  const broken = {
    getItem: () => '{not json', setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => { throw new Error('denied'); }, key: () => null, length: 0,
  };
  const s = createStore(broken);
  assert.deepEqual(s.getJSON('history.v5', []), []);
  assert.equal(s.setJSON('history.v5', [1]), false);
  assert.doesNotThrow(() => s.remove('history.v5'));
  const denied = { getItem: () => { throw new Error('SecurityError'); } };
  assert.deepEqual(createStore(denied).getJSON('history.v5', []), []);
});

test('withHistory: remembered sectors keep provenance "history"; the source wins on identity', () => {
  const now = at('2026-10-04T12:00:00Z');
  const flown = sector('XQ900', 'AAA', 'BBB', '2026-10-02T08:00:00Z');
  const listed = sector('XQ901', 'AAA', 'BBB', '2026-10-05T08:00:00Z');
  const remembered = rememberSectors([], snap([flown, listed]), at('2026-10-02T06:00:00Z'), TZ);
  const merged = withHistory(snap([listed], { coverageStart: at('2026-10-03T22:00:00Z') }), remembered, now);
  assert.equal(merged.sectors.length, 2);
  assert.equal(merged.sectors[0].provenance, 'history');
  assert.equal(merged.sectors[0].seenAt, at('2026-10-04T06:00:00Z'));
  assert.equal(merged.sectors[1].provenance, 'source');
});

test('withHistory: an overnight inbound that departed before the window is merged (layover evidence)', () => {
  // Departs 23:00 local the evening before; the source lists only from today 00:00.
  const now = at('2026-10-04T10:00:00Z');
  const overnight = sector('XQ950', 'AAA', 'BBB', '2026-10-03T21:00:00Z', 300);
  const merged = withHistory(snap([], { coverageStart: at('2026-10-03T22:00:00Z') }), [overnight], now);
  assert.equal(merged.sectors.length, 1);
  assert.equal(merged.sectors[0].provenance, 'history');
});

test('regression: the last listed flight retimed earlier across local midnight leaves no duplicate', () => {
  const now = at('2026-10-04T06:00:00Z');
  const cover = { coverageStart: at('2026-10-03T22:00:00Z'), warnings: [{ code: 'upcoming-truncated', message: '' }] };
  const first4 = [5, 6, 7, 8].map((d) => sector(`XQ${d}`, 'AAA', 'BBB', `2026-10-0${d}T08:00:00Z`));
  const before = sector('XQ9', 'AAA', 'BBB', '2026-10-08T22:30:00Z'); // 00:30 Berlin on 9 Oct
  const after = sector('XQ9', 'AAA', 'BBB', '2026-10-08T21:50:00Z');  // 23:50 Berlin on 8 Oct
  assert.notEqual(sectorIdentity(before), sectorIdentity(after));
  const day1 = rememberSectors([], snap([...first4, before], { ...cover, flightCoverageEnd: '2026-10-09' }), now, TZ);
  const day2 = rememberSectors(day1, snap([...first4, after], { ...cover, flightCoverageEnd: '2026-10-08' }), now, TZ);
  assert.equal(day2.filter((s) => s.flightNumber === 'XQ9').length, 1);
  assert.equal(day2.find((s) => s.flightNumber === 'XQ9').dep, after.dep);
  // Days later, after the flight: still one remembered copy.
  const merged = withHistory(snap([], { coverageStart: at('2026-10-10T22:00:00Z') }), day2, at('2026-10-11T10:00:00Z'));
  assert.equal(merged.sectors.filter((s) => s.flightNumber === 'XQ9').length, 1);
});

test('the same flight number on the same route on different days stays two flights', () => {
  const now = at('2026-10-04T06:00:00Z');
  const a = sector('XQ10', 'AAA', 'BBB', '2026-10-05T08:00:00Z');
  const b = sector('XQ10', 'AAA', 'BBB', '2026-10-06T08:00:00Z');
  assert.equal(rememberSectors([], snap([a, b]), now, TZ).length, 2);
});

test('merged ids come from content, so corrupt copies with a shared id cannot collide', () => {
  const now = at('2026-10-04T12:00:00Z');
  const x = { ...sector('XQ11', 'AAA', 'BBB', '2026-10-01T08:00:00Z'), id: 'same' };
  const y = { ...sector('XQ12', 'AAA', 'BBB', '2026-10-02T08:00:00Z'), id: 'same' };
  const merged = withHistory(snap([], { coverageStart: at('2026-10-03T22:00:00Z') }), [x, y], now);
  assert.equal(new Set(merged.sectors.map((s) => s.id)).size, 2);
});

test('stored copies of one retimed flight from an earlier build collapse to the newest seen', () => {
  const now = at('2026-10-11T10:00:00Z');
  const a = { ...sector('XQ9', 'AAA', 'BBB', '2026-10-08T22:30:00Z'), seenAt: at('2026-10-05T06:00:00Z') };
  const b = { ...sector('XQ9', 'AAA', 'BBB', '2026-10-08T21:50:00Z'), seenAt: at('2026-10-07T06:00:00Z') };
  const kept = rememberSectors([a, b], snap([]), now, TZ);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].dep, b.dep);
});

test('regression: the cached start-up path also collapses retimed copies (withHistory)', () => {
  const now = at('2026-10-04T12:00:00Z');
  const a = { ...sector('XQ9', 'AAA', 'BBB', '2026-09-20T21:30:00Z'), seenAt: 1 };
  const b = { ...sector('XQ9', 'AAA', 'BBB', '2026-09-20T22:30:00Z'), seenAt: 2 };
  const merged = withHistory(snap([], { coverageStart: at('2026-10-03T22:00:00Z') }), [a, b], now);
  assert.equal(merged.sectors.length, 1);
  assert.equal(merged.sectors[0].dep, b.dep);
});

test('regression: same identity far apart in time: the most recently seen copy wins', () => {
  const now = at('2026-10-04T12:00:00Z');
  const older = { ...sector('XQ9', 'AAA', 'BBB', '2026-09-20T04:00:00Z'), seenAt: 1 };
  const newer = { ...sector('XQ9', 'AAA', 'BBB', '2026-09-20T17:00:00Z'), seenAt: 9 };
  const kept = rememberSectors([older, newer], snap([]), now, TZ);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].dep, newer.dep);
});

test('regression: a stored copy never sits next to the source copy retimed across midnight', () => {
  const now = at('2026-10-04T12:00:00Z');
  const listed = sector('XQ13', 'AAA', 'BBB', '2026-10-03T22:30:00Z'); // 00:30 Berlin, 4 Oct
  const stored = { ...sector('XQ13', 'AAA', 'BBB', '2026-10-03T21:30:00Z'), seenAt: 1 }; // 23:30 Berlin, 3 Oct
  const merged = withHistory(snap([listed], { coverageStart: at('2026-10-03T22:00:00Z') }), [stored], now);
  assert.equal(merged.sectors.length, 1);
  assert.equal(merged.sectors[0].provenance, 'source');
});
