import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as time from '../src/lib/time.js';
import {
  zonedParts, offsetMinutes, localDateKey, formatTime, formatDate, formatUtcOffset,
  addDays, diffDays, calendarDaysUntil, relativeDayLabel, dayShift, startOfLocalDay,
  durationMinutes, formatDuration, countdown, isValidTimeZone,
} from '../src/lib/time.js';

const t = (iso) => Date.parse(iso);
const BER = 'Europe/Berlin';
const YYZ = 'America/Toronto';

test('module exports exactly the specified functions', () => {
  assert.deepEqual(Object.keys(time).sort(), [
    'addDays', 'calendarDaysUntil', 'countdown', 'dayShift', 'diffDays', 'durationMinutes',
    'formatDate', 'formatDuration', 'formatTime', 'formatUtcOffset', 'isValidTimeZone',
    'localDateKey', 'offsetMinutes', 'relativeDayLabel', 'startOfLocalDay', 'zonedParts',
  ]);
});

test('zonedParts returns local fields and weekday', () => {
  assert.deepEqual(zonedParts(t('2026-10-10T16:20:00Z'), YYZ), {
    year: 2026, month: 10, day: 10, hour: 12, minute: 20, second: 0, weekday: 6,
  });
  // midnight is hour 0, never 24
  assert.equal(zonedParts(t('2026-10-12T22:00:00Z'), BER).hour, 0);
  assert.equal(zonedParts(t('2026-10-11T12:00:00Z'), 'UTC').weekday, 0);
});

test('formatDate gives short date without commas', () => {
  assert.equal(formatDate(t('2026-10-10T16:20:00Z'), YYZ), 'Sat 10 Oct');
  assert.equal(formatDate(t('2026-10-12T22:30:00Z'), BER), 'Tue 13 Oct');
  assert.equal(formatDate(t('2026-10-12T22:30:00Z'), YYZ), 'Mon 12 Oct');
});

test('formatUtcOffset formats sign, half-hours and zero', () => {
  assert.equal(formatUtcOffset(t('2026-07-01T12:00:00Z'), BER), 'UTC+2');
  assert.equal(formatUtcOffset(t('2026-07-01T12:00:00Z'), YYZ), 'UTC−4');
  assert.equal(formatUtcOffset(t('2026-07-01T12:00:00Z'), 'Asia/Kolkata'), 'UTC+5:30');
  assert.equal(formatUtcOffset(t('2026-07-01T12:00:00Z'), 'Asia/Kathmandu'), 'UTC+5:45');
});

// T1: Europe/Berlin DST end 2026-10-25 (03:00 CEST -> 02:00 CET)
test('T1 Berlin DST end', () => {
  assert.equal(formatTime(t('2026-10-25T08:40:00Z'), BER), '09:40');
  assert.equal(offsetMinutes(t('2026-10-25T08:40:00Z'), BER), 60);
  assert.equal(offsetMinutes(t('2026-10-24T22:00:00Z'), BER), 120);

  const a = t('2026-10-25T00:30:00Z');
  const b = t('2026-10-25T01:30:00Z');
  assert.equal(durationMinutes(a, b), 60);
  assert.equal(formatTime(a, BER), '02:30');
  assert.equal(formatTime(b, BER), '02:30');

  assert.equal(startOfLocalDay('2026-10-25', BER), t('2026-10-24T22:00:00Z'));
  assert.equal(startOfLocalDay('2026-10-26', BER), t('2026-10-25T23:00:00Z'));
});

// T2: Europe/Berlin DST start 2027-03-28 (02:00 -> 03:00)
test('T2 Berlin DST start', () => {
  assert.equal(formatTime(t('2027-03-28T00:59:00Z'), BER), '01:59');
  assert.equal(formatTime(t('2027-03-28T01:00:00Z'), BER), '03:00');
  assert.equal(startOfLocalDay('2027-03-28', BER), t('2027-03-27T23:00:00Z'));
});

test('startOfLocalDay returns first existing instant when midnight is skipped', () => {
  // America/Sao_Paulo 2018-11-04: clocks went 00:00 -> 01:00
  const start = startOfLocalDay('2018-11-04', 'America/Sao_Paulo');
  assert.equal(localDateKey(start, 'America/Sao_Paulo'), '2018-11-04');
  assert.equal(formatTime(start, 'America/Sao_Paulo'), '01:00');
  assert.equal(localDateKey(start - 1, 'America/Sao_Paulo'), '2018-11-03');
});

// T3: destination DST
test('T3 destination DST', () => {
  assert.equal(offsetMinutes(t('2026-10-30T12:00:00Z'), YYZ), -240);
  assert.equal(offsetMinutes(t('2026-11-02T12:00:00Z'), YYZ), -300);

  // v5 legacy (B1): 10:20
  assert.equal(formatTime(t('2026-10-10T16:20:00Z'), YYZ), '12:20');

  assert.equal(offsetMinutes(t('2026-10-20T12:00:00Z'), 'Asia/Dubai'), 240);
  assert.equal(offsetMinutes(t('2026-10-30T12:00:00Z'), 'Asia/Dubai'), 240);
});

// T4: day shift
test('T4 day shift', () => {
  const bkkDep = t('2026-10-30T20:55:00Z');
  const bkkArr = t('2026-10-31T07:55:00Z');
  assert.equal(formatTime(bkkDep, BER), '21:55');
  assert.equal(formatTime(bkkArr, 'Asia/Bangkok'), '14:55');
  assert.equal(dayShift(bkkDep, BER, bkkArr, 'Asia/Bangkok'), 1);

  const yyzDep = t('2026-10-12T22:30:00Z');
  const frArr = t('2026-10-13T06:00:00Z');
  assert.equal(formatTime(yyzDep, YYZ), '18:30');
  assert.equal(formatTime(frArr, BER), '08:00');
  assert.equal(dayShift(yyzDep, YYZ, frArr, BER), 1);

  assert.equal(dayShift(t('2026-10-10T07:40:00Z'), BER, t('2026-10-10T16:20:00Z'), YYZ), 0);

  // westbound: UTC date changes (10 -> 11 Oct) but local arrival date does not
  const lafDep = t('2026-10-10T12:00:00Z');
  const lafArr = t('2026-10-11T00:30:00Z');
  assert.equal(localDateKey(lafArr, 'America/Los_Angeles'), '2026-10-10');
  assert.equal(dayShift(lafDep, BER, lafArr, 'America/Los_Angeles'), 0);

  // across the date line: arrives on the previous calendar day
  assert.equal(
    dayShift(t('2026-10-10T17:00:00Z'), 'Pacific/Auckland', t('2026-10-11T01:40:00Z'), 'Pacific/Honolulu'),
    -1,
  );
});

// T5: outstation departure
test('T5 outstation departure', () => {
  const dep = t('2026-10-12T22:30:00Z');
  assert.equal(formatTime(dep, YYZ), '18:30');
  // v5 legacy (B5) labelled the Berlin time as local
  assert.equal(formatTime(dep, BER), '00:30');
  assert.equal(localDateKey(dep, YYZ), '2026-10-12');
  assert.equal(localDateKey(dep, BER), '2026-10-13');
});

// T6: overnight duty
test('T6 overnight duty', () => {
  const pickup = t('2026-10-26T22:30:00Z');
  const dep = t('2026-10-27T00:30:00Z');
  assert.equal(formatTime(pickup, BER), '23:30');
  assert.equal(formatTime(dep, BER), '01:30');
  assert.equal(localDateKey(pickup, BER), '2026-10-26');
  assert.equal(localDateKey(dep, BER), '2026-10-27');
  assert.notEqual(localDateKey(pickup, BER), localDateKey(dep, BER));
  assert.equal(durationMinutes(pickup, dep), 120);
});

// T7: calendar-day arithmetic
test('T7 calendarDaysUntil and relativeDayLabel', () => {
  const now = t('2026-10-04T08:00:00Z');
  assert.equal(formatTime(now, BER), '10:00');

  // v5 legacy (B4) showed 'Tomorrow'
  assert.equal(calendarDaysUntil(now, t('2026-10-04T16:00:00Z'), BER), 0);
  assert.equal(relativeDayLabel(now, t('2026-10-04T16:00:00Z'), BER), 'Today');

  assert.equal(calendarDaysUntil(now, t('2026-10-05T04:00:00Z'), BER), 1);
  assert.equal(relativeDayLabel(now, t('2026-10-05T04:00:00Z'), BER), 'Tomorrow');

  // crosses Berlin midnight (00:30 on 5 Oct)
  assert.equal(calendarDaysUntil(now, t('2026-10-04T22:30:00Z'), BER), 1);

  assert.equal(relativeDayLabel(now, t('2026-10-03T12:00:00Z'), BER), 'Yesterday');
  assert.equal(relativeDayLabel(now, t('2026-10-09T12:00:00Z'), BER), 'In 5 days');
  assert.equal(relativeDayLabel(now, t('2026-09-30T12:00:00Z'), BER), '4 days ago');
});

// T8: zero offsets are values, not missing
test('T8 zero-offset zones', () => {
  const summer = t('2026-07-01T12:00:00Z');
  const winter = t('2026-12-01T12:00:00Z');
  assert.equal(offsetMinutes(summer, 'Atlantic/Reykjavik'), 0);
  assert.equal(formatUtcOffset(summer, 'Atlantic/Reykjavik'), 'UTC±0');
  assert.equal(offsetMinutes(winter, 'Europe/Lisbon'), 0);
  assert.equal(offsetMinutes(winter, 'Europe/London'), 0);
  assert.equal(formatUtcOffset(winter, 'Europe/London'), 'UTC±0');
  assert.equal(offsetMinutes(summer, 'Europe/London'), 60);
});

// T9: invalid input
test('T9 invalid input returns null instead of throwing', () => {
  assert.equal(formatTime(NaN, BER), null);
  assert.equal(formatTime(t('2026-10-10T16:20:00Z'), 'Not/AZone'), null);
  assert.equal(isValidTimeZone('Not/AZone'), false);
  assert.equal(isValidTimeZone(BER), true);
  assert.equal(isValidTimeZone(undefined), false);
  assert.equal(isValidTimeZone(''), false);

  const ms = t('2026-10-10T16:20:00Z');
  assert.equal(zonedParts(Infinity, BER), null);
  assert.equal(zonedParts(ms, undefined), null);
  assert.equal(zonedParts(ms, ''), null);
  assert.equal(zonedParts('x', BER), null);
  assert.equal(zonedParts(8.64e15 + 1, BER), null);
  assert.equal(offsetMinutes(ms, 'Not/AZone'), null);
  assert.equal(localDateKey(NaN, BER), null);
  assert.equal(formatDate(ms, 'Not/AZone'), null);
  assert.equal(formatDate(NaN, BER), null);
  assert.equal(formatUtcOffset(ms, 'Not/AZone'), null);
  assert.equal(calendarDaysUntil(NaN, ms, BER), null);
  assert.equal(relativeDayLabel(ms, ms, 'Not/AZone'), null);
  assert.equal(dayShift(ms, BER, ms, 'Not/AZone'), null);
  assert.equal(startOfLocalDay('2026-10-25', 'Not/AZone'), null);
  assert.equal(startOfLocalDay('2026-13-45', BER), null);
  assert.equal(durationMinutes(NaN, ms), null);
  assert.equal(countdown(ms, NaN), null);
  assert.equal(addDays('garbage', 1), null);
  assert.equal(diffDays('2026-10-01', 'nope'), null);
});

test('countdown boundaries', () => {
  const now = t('2026-10-04T08:00:00Z');
  const c = (delta) => countdown(now, now + delta);

  assert.deepEqual(c(0), { totalMs: 0, past: true, days: 0, hours: 0, minutes: 0, seconds: 0, label: 'Now' });
  assert.equal(c(1).label, '0s');
  assert.equal(c(1).past, false);
  assert.equal(c(45000).label, '45s');
  assert.equal(c(59999).label, '59s');
  assert.equal(c(60000).label, '1m 00s');
  assert.equal(c(7 * 60000 + 5000).label, '7m 05s');
  assert.equal(c(3599999).label, '59m 59s');
  assert.equal(c(3600000).label, '1h 00m');
  assert.equal(c(4 * 3600000 + 7 * 60000).label, '4h 07m');
  assert.equal(c(86399999).label, '23h 59m');
  assert.equal(c(86400000).label, '1d 00h');
  assert.equal(c(2 * 86400000 + 4 * 3600000).label, '2d 04h');
  assert.deepEqual(c(2 * 86400000 + 4 * 3600000 + 5 * 60000 + 6000), {
    totalMs: 2 * 86400000 + 4 * 3600000 + 5 * 60000 + 6000,
    past: false, days: 2, hours: 4, minutes: 5, seconds: 6, label: '2d 04h',
  });
});

test('countdown past target', () => {
  const now = t('2026-10-04T08:00:00Z');
  const past = countdown(now, now - 5000);
  assert.equal(past.past, true);
  assert.equal(past.label, 'Now');
  assert.equal(past.days, 0);
  assert.equal(past.seconds, 0);
});

test('formatDuration', () => {
  assert.equal(formatDuration(520), '8h 40m');
  assert.equal(formatDuration(45), '45m');
  assert.equal(formatDuration(720), '12h');
  assert.equal(formatDuration(60), '1h');
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(-1), '—');
  assert.equal(formatDuration(NaN), '—');
  assert.equal(formatDuration(Infinity), '—');
  assert.equal(formatDuration(undefined), '—');
});

test('durationMinutes rounds to whole minutes', () => {
  assert.equal(durationMinutes(0, 90000), 2);
  assert.equal(durationMinutes(0, 89000), 1);
  assert.equal(durationMinutes(0, 0), 0);
  assert.equal(Object.is(durationMinutes(0, -1000), 0), true);
  assert.equal(durationMinutes(t('2026-10-10T07:40:00Z'), t('2026-10-10T16:20:00Z')), 520);
});

test('addDays across month, year and leap boundaries', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2027-01-01', -1), '2026-12-31');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2028-02-29', 1), '2028-03-01');
  assert.equal(addDays('2027-02-28', 1), '2027-03-01');
  assert.equal(addDays('2026-10-04', 0), '2026-10-04');
  assert.equal(addDays('2026-10-04', 400), '2027-11-08');
});

test('diffDays is signed calendar days', () => {
  assert.equal(diffDays('2026-10-04', '2026-10-04'), 0);
  assert.equal(diffDays('2026-10-04', '2026-10-05'), 1);
  assert.equal(diffDays('2026-10-05', '2026-10-04'), -1);
  assert.equal(diffDays('2026-12-31', '2027-01-02'), 2);
  assert.equal(diffDays('2028-02-28', '2028-03-01'), 2);
  assert.equal(diffDays('2027-02-28', '2027-03-01'), 1);
  assert.equal(diffDays('2026-10-30', '2026-09-30'), -30);
});

test('localDateKey and formatTime zero-pad', () => {
  const ms = t('2026-01-05T03:04:05Z');
  assert.equal(localDateKey(ms, 'UTC'), '2026-01-05');
  assert.equal(formatTime(ms, 'UTC'), '03:04');
  assert.equal(formatTime(t('2026-10-12T22:00:00Z'), BER), '00:00');
});
