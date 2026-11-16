// V3 Milestone 1: the offline ICS parser (core/ics/ics.js) feeds the EXISTING Condor adapter and
// roster model unchanged. Fixtures are the synthetic feed; every other value here is invented.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs, icsToRawEvents, icsSourceId } from '../core/ics/ics.js';
import { loadGs, fakeEnv, localDate, localIso } from './gs-harness.js';
import { NOW, BASE_TZ, feedEvents, syncedEvents, hotelRows } from './fixtures/condor-feed.synthetic.mjs';

const gs = loadGs();
const TOKEN = 'test-token-0123456789abcdef';
const plain = (x) => JSON.parse(JSON.stringify(x));
const buildRoster = (feed) => {
  const { env } = fakeEnv(gs, { now: NOW, feed, synced: syncedEvents(), rows: hotelRows(feedEvents()) });
  return plain(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, token: TOKEN, action: 'roster' }), env));
};

// --- Test-local ICS writer (RFC 5545 escaping + UTF-8 aware folding at 75 octets) ---------

const enc = new TextEncoder();
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) {
  const out = []; let cur = ''; let len = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (len + b > 75) { out.push(cur); cur = ' '; len = 1; }
    cur += ch; len += b;
  }
  return [...out, cur].join('\r\n');
}
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const wallStamp = (ms, tz) => `${localIso(ms, tz).slice(0, 16).replace(/[-:]/g, '')}00`;
const midnight = (ms, tz) => localIso(ms, tz).slice(11, 16) === '00:00';

function toIcs(events, { allDayZone = BASE_TZ, tzidZone = BASE_TZ, uidPrefix = '' } = {}) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SAMPLE//TEST//EN'];
  let timed = 0;
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${uidPrefix}${e.sourceId}`, 'DTSTAMP:20261001T000000Z', 'SEQUENCE:0', 'STATUS:CONFIRMED');
    if (midnight(e.start, allDayZone) && midnight(e.end, allDayZone)) {
      lines.push(`DTSTART;VALUE=DATE:${localDate(e.start, allDayZone).replaceAll('-', '')}`, `DTEND;VALUE=DATE:${localDate(e.end, allDayZone).replaceAll('-', '')}`);
    } else if (timed++ % 2) {
      lines.push(`DTSTART;TZID=${tzidZone}:${wallStamp(e.start, tzidZone)}`, `DTEND;TZID=${tzidZone}:${wallStamp(e.end, tzidZone)}`);
    } else {
      lines.push(`DTSTART:${stamp(e.start)}`, `DTEND:${stamp(e.end)}`);
    }
    lines.push(`SUMMARY:${esc(e.title)}`);
    if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
    if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

// Hand-written snippets for edge cases.
const CAL = (...body) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SAMPLE//TEST//EN', ...body, 'END:VCALENDAR'].join('\r\n') + '\r\n';
const VEV = (uid, ...props) => ['BEGIN:VEVENT', ...(uid ? [`UID:${uid}`] : []), ...(props.some((x) => x.startsWith('DTSTAMP')) ? [] : ['DTSTAMP:20261001T000000Z']), ...props, 'END:VEVENT'].join('\r\n');
const T = (iso) => Date.parse(iso);
const BERLIN = { allDayTimeZone: BASE_TZ };
const codes = (list) => list.map((x) => x.code);

// --- Compatibility with the existing Condor parser and roster model -------------------------

test('feed fixture round-trips through ICS (UTC, TZID and DATE forms) to the identical raw events', () => {
  const fixture = feedEvents();
  const r = icsToRawEvents(toIcs(fixture), BERLIN);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.events.length, fixture.length);
  for (const f of fixture) {
    const e = r.events.find((x) => x.sourceId === f.sourceId);
    assert.ok(e, f.sourceId);
    assert.deepEqual({ ...e, ics: undefined }, { ...f, ics: undefined });
  }
  assert.deepEqual([...new Set(r.events.map((e) => e.ics.timeForm))].sort(), ['date', 'tzid', 'utc']);
  assert.deepEqual(r.events.map((e) => e.start), [...r.events.map((e) => e.start)].sort((a, b) => a - b));
});

test('the roster contract built from parsed ICS equals the one built from the fixture, and keeps every spot fact', () => {
  const direct = buildRoster(feedEvents());
  const parsed = icsToRawEvents(toIcs(feedEvents()), BERLIN);
  const viaIcs = buildRoster(parsed.events);
  assert.deepEqual(viaIcs, direct);

  const bkk = viaIcs.stays.find((s) => s.airport === 'BKK');
  assert.equal(bkk.hotel.name, 'Sample Riverside Hotel');
  assert.equal(bkk.hotel.location.status, 'verified');
  const sector = (n) => viaIcs.sectors.find((s) => s.flightNumber === n);
  const dutyOf = (n) => viaIcs.duties.find((d) => d.sectorIds.includes(sector(n).id));
  assert.equal(dutyOf('DE9201').report.provenance, 'source');
  assert.ok(dutyOf('DE9202').report && dutyOf('DE9202').pickup, 'C/I report and P/U pickup attach to the return duty');
  const sb = viaIcs.windows.find((w) => w.code === 'SB90');
  assert.deepEqual([sb.kind, sb.start, sb.end], ['standby', T('2026-10-13T02:55:00Z'), T('2026-10-13T14:55:00Z')]);
  const day = (d) => viaIcs.coverage.days.find((x) => x.date === d);
  assert.deepEqual(day('2026-10-04').codes.map((c) => [c.subtype, c.protected]), [['ort', true]]);
  assert.equal(viaIcs.events.find((e) => e.code === '-').kind, 'unassigned');
  assert.deepEqual(day('2026-10-25').codes.map((c) => c.subtype), ['leave']);
  assert.equal(viaIcs.events.find((e) => e.code === 'XYZ7').kind, 'unknown');
  assert.ok(viaIcs.warnings.some((w) => w.code === 'unknown-code'));
  assert.ok(viaIcs.warnings.some((w) => w.code === 'unknown-airport' && w.message.startsWith('QQQ')));
});

test('crew-shaped lines inside a folded description never reach the roster; the hotel block still parses', () => {
  const crew = (rank, k, name) => `${rank} ${String(k).repeat(6)}A ${name}`;   // employee-shaped numbers built at runtime, never stored
  const desc = `FRA SAMPLE AIRPORT FRA\nBKK SAMPLE AIRPORT BKK\n\nDABCD (339)\n\nHotel\nSample Riverside Hotel\n99 Sample Street\nBangkok\n+66 2 000 0000\n\n${crew('CP', 1, 'SAMPLE PERSON')}\n${crew('FO', 2, 'OTHER PERSON')}`;
  const text = CAL(VEV('crew-1', 'DTSTART:20261008T080000Z', 'DTEND:20261008T190000Z', 'SUMMARY:DE9201 FRA-BKK', 'LOCATION:FRA - BKK', fold(`DESCRIPTION:${esc(desc)}`)));
  assert.match(text, /\r\n [^\r]/, 'the description is folded');
  const r = icsToRawEvents(text, BERLIN);
  assert.equal(r.events[0].description, desc);
  const roster = buildRoster(r.events);
  assert.equal(roster.stays.find((s) => s.airport === 'BKK').hotel.name, 'Sample Riverside Hotel');
  const json = JSON.stringify(roster);
  for (const s of ['SAMPLE PERSON', 'OTHER PERSON', '1'.repeat(6), '2'.repeat(6)]) assert.ok(!json.includes(s), s);
});

// --- Identity and source metadata -----------------------------------------------------------

test('identity is the ICS UID (plus RECURRENCE-ID); roster ids follow it and no Google id is involved', () => {
  assert.equal(icsSourceId('abc'), 'abc');
  assert.equal(icsSourceId('abc', null), 'abc');
  assert.equal(icsSourceId('abc', '2026-10-08T06:00:00.000Z'), 'abc#2026-10-08T06:00:00.000Z');
  const a = buildRoster(icsToRawEvents(toIcs(feedEvents()), BERLIN).events);
  const b = buildRoster(icsToRawEvents(toIcs(feedEvents(), { uidPrefix: 'moved-' }), BERLIN).events);
  const ids = (r) => r.events.filter((e) => e.basis === 'airline-feed').map((e) => e.id);
  assert.equal(ids(a).length, ids(b).length);
  assert.ok(ids(a).every((id, i) => id !== ids(b)[i]), 'a different UID is a different event');
  assert.deepEqual(ids(a), ids(buildRoster(icsToRawEvents(toIcs(feedEvents()), BERLIN).events)), 'same UIDs give the same ids');
});

test('UID, RECURRENCE-ID, SEQUENCE and STATUS are kept as source metadata', () => {
  const text = CAL(VEV('meta-1', 'RECURRENCE-ID;TZID=Europe/Berlin:20261008T100000', 'SEQUENCE:3', 'STATUS:confirmed', 'LAST-MODIFIED:20261002T101500Z', 'DTSTART;TZID=Europe/Berlin:20261008T110000', 'DTEND;TZID=Europe/Berlin:20261008T120000', 'summary:lower-case name'));
  const r = icsToRawEvents(text);
  assert.equal(r.ok, true);
  const e = r.events[0];
  assert.equal(e.sourceId, 'meta-1#2026-10-08T08:00:00.000Z');
  assert.equal(e.title, 'lower-case name');
  assert.deepEqual(e.ics, { uid: 'meta-1', recurrenceId: '2026-10-08T08:00:00.000Z', sequence: 3, status: 'CONFIRMED', dtstamp: '2026-10-01T00:00:00.000Z', lastModified: '2026-10-02T10:15:00.000Z', timeForm: 'tzid', allDay: false });
  assert.equal(e.start, T('2026-10-08T09:00:00Z'));
  const d = icsToRawEvents(CAL(VEV('meta-2', 'RECURRENCE-ID;VALUE=DATE:20261008', 'DTSTART;VALUE=DATE:20261008')), BERLIN);
  assert.equal(d.events[0].ics.recurrenceId, '2026-10-08');
  assert.equal(d.events[0].ics.sequence, 0);
  assert.equal(d.events[0].ics.status, null);
});

// --- Parsing details -------------------------------------------------------------------------

test('text escapes, quoted parameters with colons, BOM, LF-only endings, nested components and VTIMEZONE', () => {
  const body = [
    'BEGIN:VTIMEZONE', 'TZID:W. Europe Standard Time', 'BEGIN:STANDARD', 'DTSTART:16011028T030000', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:esc-1', 'DTSTAMP:20261001T000000Z',
    'DTSTART;X-LABEL="a:b;c";TZID=Europe/Berlin:20261008T100000', 'DTEND;TZID=Europe/Berlin:20261008T110000',
    'SUMMARY:One\\, two\\; three \\\\ four\\nfive\\Nsix', 'LOCATION;ALTREP="https://sample.invalid/x:y":FRA',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:alarm text', 'TRIGGER:-PT15M', 'END:VALARM',
    'DESCRIPTION:real', '\tdescription', 'END:VEVENT',
  ];
  const text = `\uFEFF${CAL(...body).replaceAll('\r\n', '\n')}`;
  const r = parseIcs(text);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.calendar.vtimezoneCount, 1);
  assert.equal(r.events.length, 1);
  const e = r.events[0];
  assert.equal(e.summary, 'One, two; three \\ four\nfive\nsix');
  assert.equal(e.location, 'FRA');
  assert.equal(e.description, 'realdescription');
  assert.equal(e.start, T('2026-10-08T08:00:00Z'));
});

test('DST: a nonexistent local time is an error; an ambiguous one takes the earlier instant with a warning', () => {
  const gap = parseIcs(CAL(VEV('gap', 'DTSTART;TZID=Europe/Berlin:20260329T023000')));
  assert.equal(gap.ok, false);
  assert.deepEqual(codes(gap.errors), ['nonexistent-local-time']);
  assert.equal(gap.errors[0].event, 1, 'diagnostics name the event by position, not UID');
  const overlap = parseIcs(CAL(VEV('dup', 'DTSTART;TZID=Europe/Berlin:20261025T023000')));
  assert.equal(overlap.ok, true);
  assert.equal(overlap.events[0].start, T('2026-10-25T00:30:00Z'));
  assert.deepEqual(codes(overlap.warnings), ['ambiguous-local-time']);
});

test('floating time resolves only through a valid X-WR-TIMEZONE, never by guessing', () => {
  const ev = VEV('fl', 'DTSTART:20261008T100000', 'DTEND:20261008T110000');
  const withZone = parseIcs(CAL('X-WR-TIMEZONE:Europe/Berlin', ev));
  assert.equal(withZone.ok, true);
  assert.equal(withZone.calendar.xWrTimezone, 'Europe/Berlin');
  assert.equal(withZone.events[0].start, T('2026-10-08T08:00:00Z'));
  assert.deepEqual(codes(parseIcs(CAL(ev)).errors), ['floating-time']);
  const bad = parseIcs(CAL('X-WR-TIMEZONE:Not/AZone', ev));
  assert.equal(bad.calendar.xWrTimezone, null);
  assert.deepEqual(codes(bad.warnings), ['invalid-calendar-timezone']);
  assert.deepEqual(codes(bad.errors), ['floating-time']);
});

test('Windows and unknown TZIDs are rejected explicitly', () => {
  for (const tz of ['W. Europe Standard Time', 'Nowhere/Land', '/sample.invalid/Europe/Berlin']) {
    const r = parseIcs(CAL(VEV('tz', `DTSTART;TZID=${tz}:20261008T100000`)));
    assert.deepEqual(codes(r.errors), ['unsupported-tzid'], tz);
    assert.equal(r.events.length, 0);
  }
});

test('RRULE, RDATE and EXDATE fail explicitly and leave no partial schedule', () => {
  const plainEvent = VEV('ok-1', 'DTSTART:20261008T080000Z', 'DTEND:20261008T090000Z');
  for (const prop of ['RRULE:FREQ=WEEKLY;COUNT=3', 'RDATE:20261015T080000Z', 'EXDATE:20261015T080000Z']) {
    const name = prop.split(':')[0];
    const r = icsToRawEvents(CAL(plainEvent, VEV('rec-1', 'DTSTART:20261008T080000Z', 'DTEND:20261008T090000Z', prop)));
    assert.equal(r.ok, false, name);
    assert.deepEqual(r.events, [], name);
    assert.deepEqual(codes(r.errors), ['unsupported-recurrence']);
    assert.equal(r.errors[0].property, name);
    assert.equal(r.errors[0].event, 2);
    assert.ok(r.errors[0].message.includes(name) && !r.errors[0].message.includes('rec-1'));
  }
});

test('a RECURRENCE-ID instance without a master is kept as a concrete event with a warning', () => {
  const r = icsToRawEvents(CAL(VEV('series-1', 'RECURRENCE-ID:20261008T080000Z', 'DTSTART:20261008T090000Z', 'DTEND:20261008T100000Z', 'SUMMARY:moved instance')));
  assert.equal(r.ok, true);
  assert.deepEqual(codes(r.warnings), ['orphan-recurrence-instance']);
  assert.equal(r.events[0].sourceId, 'series-1#2026-10-08T08:00:00.000Z');
  assert.equal(r.events[0].start, T('2026-10-08T09:00:00Z'));
});

test('STATUS:CANCELLED events go to cancelled, never into events or the roster', () => {
  const live = VEV('live-1', 'DTSTART:20261012T060000Z', 'DTEND:20261012T070500Z', 'SUMMARY:DE9203 FRA-BER', 'LOCATION:FRA - BER');
  const dead = VEV('dead-1', 'DTSTART:20261014T145500Z', 'DTEND:20261014T160500Z', 'SUMMARY:DE9204 BER-FRA', 'LOCATION:BER - FRA', 'STATUS:CANCELLED', 'SEQUENCE:2');
  const r = icsToRawEvents(CAL(live, dead));
  assert.deepEqual(r.events.map((e) => e.sourceId), ['live-1']);
  assert.deepEqual(r.cancelled.map((e) => [e.sourceId, e.ics.status, e.ics.sequence]), [['dead-1', 'CANCELLED', 2]]);
  const roster = buildRoster(r.events);
  assert.deepEqual(roster.sectors.filter((s) => s.basis === 'airline-feed').map((s) => s.flightNumber), ['DE9203'], 'the cancelled DE9204 is absent');
});

test('duplicates: higher SEQUENCE wins, identical copies collapse, conflicts and cancellations are explicit', () => {
  const v = (seq, title, ...more) => VEV('dup-1', 'DTSTART:20261008T080000Z', 'DTEND:20261008T090000Z', `SEQUENCE:${seq}`, `SUMMARY:${title}`, ...more);
  const hi = icsToRawEvents(CAL(v(1, 'old'), v(2, 'new'), v(0, 'older')));
  assert.equal(hi.events.length, 1);
  assert.equal(hi.events[0].title, 'new');
  assert.deepEqual(codes(hi.warnings), ['superseded-duplicate']);
  const same = icsToRawEvents(CAL(v(1, 'same'), v(1, 'same')));
  assert.equal(same.ok, true);
  assert.equal(same.events.length, 1);
  assert.deepEqual(codes(same.warnings), ['identical-duplicate']);
  const restamped = icsToRawEvents(CAL(v(1, 'same', 'DTSTAMP:20261001T000000Z'), v(1, 'same', 'DTSTAMP:20261002T000000Z')));
  assert.equal(restamped.ok, true, 'copies differing only in DTSTAMP are identical');
  assert.deepEqual(codes(restamped.warnings), ['identical-duplicate']);
  const conflict = icsToRawEvents(CAL(v(1, 'one'), v(1, 'two')));
  assert.equal(conflict.ok, false);
  assert.deepEqual(codes(conflict.errors), ['conflicting-duplicate']);
  assert.deepEqual(conflict.events, []);
  const cancel = icsToRawEvents(CAL(v(1, 'kept?'), v(2, 'kept?', 'STATUS:CANCELLED')));
  assert.deepEqual([cancel.events.length, cancel.cancelled.length], [0, 1]);
  assert.equal(parseIcs(CAL(VEV('x', 'DTSTART:20261008T080000Z', 'SEQUENCE:one'))).errors[0].code, 'invalid-sequence');
});

test('missing UID, non-ICS bodies and oversize input fail closed', () => {
  const noUid = icsToRawEvents(CAL(VEV(null, 'DTSTART:20261008T080000Z'), VEV('fine', 'DTSTART:20261008T080000Z')));
  assert.equal(noUid.ok, false);
  assert.deepEqual(codes(noUid.errors), ['missing-uid']);
  assert.deepEqual(noUid.events, []);
  for (const body of ['<!DOCTYPE html><html><body>Sign in</body></html>', '', '   \n', undefined]) {
    const r = icsToRawEvents(body);
    assert.equal(r.ok, false);
    assert.deepEqual(codes(r.errors), ['not-ics']);
    assert.deepEqual(r.events, []);
  }
  const big = parseIcs(CAL(VEV('big', 'DTSTART:20261008T080000Z')), { maxBytes: 50 });
  assert.deepEqual(codes(big.errors), ['too-large']);
  assert.equal(parseIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:cut\r\n').ok, false, 'truncated body');
});

test('missing DTEND: DATE gets +1 calendar day (25 h across DST), DATE-TIME uses DURATION, otherwise a zero-length event', () => {
  const r = icsToRawEvents(CAL(
    VEV('d-date', 'DTSTART;VALUE=DATE:20261025'),
    VEV('d-dur', 'DTSTART:20261008T080000Z', 'DURATION:PT1H30M'),
    VEV('d-week', 'DTSTART:20261008T080000Z', 'DURATION:P1W'),
    VEV('d-days', 'DTSTART;VALUE=DATE:20261024', 'DURATION:P2D'),
    VEV('d-none', 'DTSTART:20261008T080000Z'),
  ), BERLIN);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const e = (id) => r.events.find((x) => x.sourceId === id);
  assert.equal(e('d-date').end - e('d-date').start, 25 * 3600000);
  assert.equal(e('d-dur').end - e('d-dur').start, 90 * 60000);
  assert.equal(e('d-week').end - e('d-week').start, 7 * 86400000);
  assert.equal(e('d-days').end, T('2026-10-25T23:00:00Z'));
  assert.equal(e('d-none').end, e('d-none').start);
  assert.deepEqual(codes(parseIcs(CAL(VEV('bad', 'DTSTART:20261008T080000Z', 'DTEND:20261008T070000Z'))).errors), ['invalid-range']);
});

test('all-day events need options.allDayTimeZone', () => {
  const r = icsToRawEvents(CAL(VEV('ad', 'DTSTART;VALUE=DATE:20261008')));
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r.errors), ['missing-all-day-zone']);
  assert.deepEqual(r.events, []);
  assert.equal(icsToRawEvents(CAL(VEV('ad', 'DTSTART;VALUE=DATE:20261008')), BERLIN).events[0].start, T('2026-10-07T22:00:00Z'));
});

test('errors and warnings never contain a UID, TZID value or SUMMARY, DESCRIPTION or LOCATION text', () => {
  const secret = ['SUMMARY:SECRETTITLE', 'DESCRIPTION:SECRETDESC', 'LOCATION:SECRETPLACE'];
  const bad = [
    VEV('SECRETUID-1', 'DTSTART;TZID=Europe/Berlin:20260329T023000', ...secret),
    VEV('SECRETUID-2', 'DTSTART;TZID=Windows/Zone:20261008T100000', ...secret),
    VEV('SECRETUID-3', 'DTSTART:20261008T100000', ...secret),
    VEV('SECRETUID-4', 'DTSTART:20261008T080000Z', 'RRULE:FREQ=DAILY', ...secret),
    VEV('SECRETUID-5', 'DTSTART;VALUE=DATE:20261008', ...secret),
    VEV('SECRETUID-6', 'DTSTART:20261008T080000Z', 'DTEND:20261008T070000Z', ...secret),
    VEV('SECRETUID-7', 'DTSTART:20261008T080000Z', 'SEQUENCE:1', ...secret),
    VEV('SECRETUID-7', 'DTSTART:20261008T080000Z', 'SEQUENCE:1', 'SUMMARY:SECRETOTHER'),
    VEV('SECRETUID-8', 'RECURRENCE-ID;TZID=Europe/Berlin:20261025T023000', 'DTSTART:20261008T080000Z', ...secret),
    VEV(null, 'DTSTART:20261008T080000Z', ...secret),
  ];
  const r = parseIcs(CAL(...bad));
  assert.ok(r.errors.length >= 8 && r.warnings.length >= 1);
  const text = JSON.stringify([r.errors, r.warnings]);
  assert.ok(r.errors.every((e) => !('uid' in e)) && r.warnings.every((w) => !('uid' in w)));
  assert.ok(r.errors.every((e) => Number.isInteger(e.event) && e.event >= 1));
  for (const s of ['SECRETTITLE', 'SECRETDESC', 'SECRETPLACE', 'SECRETOTHER', 'SECRETUID', 'Windows/Zone']) assert.ok(!text.includes(s), s);
  assert.ok(!JSON.stringify(parseIcs('<html>SECRETTITLE</html>').errors).includes('SECRETTITLE'));
});

// --- Verifier fixes (D1-D8) --------------------------------------------------------------------

test('D1: a RECURRENCE-ID override of a master in the file fails closed, even when the master itself errored or the override is cancelled', () => {
  const master = VEV('ser-1', 'DTSTART:20261008T080000Z', 'DTEND:20261008T090000Z');
  const override = VEV('ser-1', 'RECURRENCE-ID:20261008T080000Z', 'DTSTART:20261008T100000Z', 'DTEND:20261008T110000Z');
  const cancelledOverride = VEV('ser-1', 'RECURRENCE-ID:20261008T080000Z', 'DTSTART:20261008T080000Z', 'STATUS:CANCELLED');
  for (const [name, text] of [['master + override', CAL(master, override)], ['master + cancelled override', CAL(master, cancelledOverride)]]) {
    const r = icsToRawEvents(text);
    assert.equal(r.ok, false, name);
    assert.deepEqual(r.events, [], name);
    assert.deepEqual(codes(r.errors), ['unsupported-recurrence'], name);
    assert.equal(r.errors[0].event, 2);
    assert.equal(r.errors[0].property, 'RECURRENCE-ID');
  }
  // D7: the master fails on its own (RRULE); the override is still recognised as having a master, no orphan warning.
  const rruleMaster = VEV('ser-1', 'DTSTART:20261008T080000Z', 'RRULE:FREQ=DAILY');
  const r = icsToRawEvents(CAL(rruleMaster, override));
  assert.deepEqual(codes(r.errors), ['unsupported-recurrence', 'unsupported-recurrence']);
  assert.ok(!codes(r.warnings).includes('orphan-recurrence-instance'));
  // A different UID is still an orphan instance.
  assert.deepEqual(codes(icsToRawEvents(CAL(VEV('other', 'DTSTART:20261008T080000Z'), override)).warnings), ['orphan-recurrence-instance']);
});

test('D2: two distinct events with the same ICS identity are an explicit error', () => {
  const a = VEV('s#2026-10-08T08:00:00.000Z', 'DTSTART:20261008T080000Z', 'DTEND:20261008T090000Z');
  const b = VEV('s', 'RECURRENCE-ID:20261008T080000Z', 'DTSTART:20261008T100000Z', 'DTEND:20261008T110000Z');
  const r = icsToRawEvents(CAL(a, b));
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r.errors), ['identity-collision']);
  assert.deepEqual(r.events, []);
});

test('D3: a non-blank content line without a colon is malformed and its text is not echoed', () => {
  for (const [name, bad] of [['missing colon', 'DTEND 20261008T200000Z'], ['raw break in a description', 'DESCRIPTION:first part\r\nSECRETTAIL second part']]) {
    const r = icsToRawEvents(CAL(VEV('mal-1', 'DTSTART:20261008T080000Z', bad)));
    assert.equal(r.ok, false, name);
    assert.deepEqual(codes(r.errors), ['malformed'], name);
    assert.deepEqual(r.events, [], name);
    assert.ok(!JSON.stringify(r.errors).includes('SECRETTAIL') && !JSON.stringify(r.errors).includes('20261008T200000Z'));
  }
});

test('D4: type mismatch, DTEND with DURATION, repeated single properties, EXRULE and trailing content are explicit errors', () => {
  const ok = ['DTSTART:20261008T080000Z', 'DTEND:20261008T090000Z'];
  const one = (...props) => parseIcs(CAL(VEV('d4', ...props)), BERLIN);
  assert.deepEqual(codes(one('DTSTART;VALUE=DATE:20261008', 'DTEND:20261009T000000Z').errors), ['invalid-range']);
  assert.deepEqual(codes(one('DTSTART:20261008T080000Z', 'DTEND;VALUE=DATE:20261009').errors), ['invalid-range']);
  assert.deepEqual(codes(one(...ok, 'DURATION:PT1H').errors), ['malformed']);
  for (const prop of ['DTSTART:20261008T090000Z', 'DTEND:20261008T100000Z', 'SEQUENCE:1', 'STATUS:CONFIRMED', 'SUMMARY:again', 'DESCRIPTION:again', 'LOCATION:FRA', 'DTSTAMP:20261002T000000Z', 'RECURRENCE-ID:20261008T080000Z']) {
    const name = prop.split(':')[0];
    const props = name === 'DTSTART' || name === 'DTEND' ? [...ok, prop] : [...ok, prop, prop];   // DTSTART/DTEND are already in `ok`
    const r = one(...props);
    assert.deepEqual(codes(r.errors), ['malformed'], name);
    assert.equal(r.errors[0].property, name);
  }
  assert.deepEqual(codes(one('DURATION:PT1H', 'DURATION:PT2H', ...ok.slice(0, 1)).errors), ['malformed']);
  assert.deepEqual(codes(parseIcs(CAL(VEV('d4', ...ok), VEV('d4', ...ok).replace('UID:d4', 'UID:d4\r\nUID:d4-b'))).errors), ['malformed']);
  const ex = icsToRawEvents(CAL(VEV('d4', ...ok, 'EXRULE:FREQ=DAILY')));
  assert.deepEqual([ex.errors[0].code, ex.errors[0].property], ['unsupported-recurrence', 'EXRULE']);
  const trailing = icsToRawEvents(`${CAL(VEV('d4', ...ok))}BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:late\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`);
  assert.equal(trailing.ok, false);
  assert.deepEqual(codes(trailing.errors), ['malformed']);
  assert.deepEqual(trailing.events, []);
  assert.equal(parseIcs(`${CAL(VEV('d4', ...ok))}\r\n  \r\n`).ok, true, 'trailing blank lines are fine');
});

test('D5: DURATION days on a TZID start are calendar days in that zone; UTC starts are exact', () => {
  const r = icsToRawEvents(CAL(
    VEV('z-1', 'DTSTART;TZID=Europe/Berlin:20261024T120000', 'DURATION:P1D'),
    VEV('z-2', 'DTSTART;TZID=Europe/Berlin:20261024T120000', 'DURATION:P1DT1H30M'),
    VEV('z-3', 'DTSTART:20261024T100000Z', 'DURATION:P1D'),
    VEV('z-4', 'DTSTART;TZID=Europe/Berlin:20261024T120000', 'DURATION:PT24H'),
  ));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const end = (id) => r.events.find((e) => e.sourceId === id).end;
  assert.equal(end('z-1'), T('2026-10-25T11:00:00Z'), '12:00 local the next day, across the DST change');
  assert.equal(end('z-2'), T('2026-10-25T12:30:00Z'));
  assert.equal(end('z-3'), T('2026-10-25T10:00:00Z'));
  assert.equal(end('z-4'), T('2026-10-25T10:00:00Z'), 'PT24H is exact time');
});

test('D8: unbalanced END lines do not echo file text', () => {
  const r = parseIcs(CAL(VEV('end-1', 'DTSTART:20261008T080000Z').replace('END:VEVENT', 'END:SECRETCOMPONENT')));
  assert.ok(codes(r.errors).includes('malformed'));
  assert.ok(!JSON.stringify(r.errors).includes('SECRETCOMPONENT'));
});
