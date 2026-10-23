// ============================================================================
// FLIGHT CONTROL — ISOLATED APPS SCRIPT TEST PACKAGE: SYNTHETIC FIXTURE (test-only, pure)
// ============================================================================
// NEVER add this file to the production Apps Script project. Pure and deterministic: no Apps Script service,
// no clock, no property. fctFixture_(anchorDateKey) returns the raw calendar events the seeder creates:
//
//   { anchor, selfId, feed: [event], synced: [event], variants: { scheduleChange }, expect, meta }
//   event = { key, sourceId, title, start, end, location, description }   (start/end in epoch ms)
//
// The ANCHOR is the local date ("today") the fixture is built for. Everything before it is the synced copy
// (history, tagged by the seeder with the sync tag), everything from the day after it is the airline feed.
//
// Everything is clearly fake: airports are "SAMPLE AIRPORT", hotels "Sample ... Hotel", phone "+00 ...",
// names are letters-only placeholders (family "TESTCREW<letters>", given "SAMPLE<letters>") and every
// synthetic employee id is BUILT AT RUNTIME as "99" + four digits + "X" (never written as a literal). The
// owner is synthetic person 0; its id is the value Script Property FC_CREW_SELF must hold.
//
// Coverage: flight duties and crew lists; layovers with a hotel block; five months of history before the
// anchor (four of them always sealable) with recurring crews so familiarity counts are non-zero; a flight with
// no crew list; invalid crew records (malformed rank line, digits in a name, duplicate id, an over-long line,
// a line without an id, a crew list without the owner); eastbound, westbound, half-hour-zone and
// local-midnight-crossing flights; daylight-saving dates in Europe and North America; a schedule-change
// variant (same event, time moved, one crew member replaced).
//
// Flight numbers are assigned in a fixed order independent of the anchor, so a flight keeps its number
// whichever day the fixture is built for. All names start with fct and end in "_".
// ============================================================================

const FCT_DAY_MS_ = 86400000;
const FCT_SYNC_PREFIX_ = '✈️✈️✈️ ';
const FCT_GROUPS_ = [[1, 2, 3, 4], [1, 5, 3, 6], [7, 2, 8, 4], [9, 10, 3, 11]];
const FCT_RANKS_ = { 1: 'CP', 2: 'FO', 3: 'PU', 5: 'FO', 7: 'CP', 8: 'PU', 9: 'CP', 10: 'FO' };
const FCT_SHORT_DESTINATIONS_ = ['PMI', 'LPA', 'HER', 'AYT'];
const FCT_HISTORY_MONTHS_ = 5;
// Daylight-saving dates that are fixed in time (UTC instants), independent of the anchor.
const FCT_FIXED_DST_ = [
  { key: 'X1', from: 'FRA', to: 'PMI', start: '2026-10-25T00:30:00Z', end: '2026-10-25T03:15:00Z' },   // Europe: clocks back at 01:00Z
  { key: 'X2', from: 'FRA', to: 'PMI', start: '2027-03-28T00:30:00Z', end: '2027-03-28T03:15:00Z' },   // Europe: clocks forward at 01:00Z
  { key: 'X3', from: 'YYZ', to: 'FRA', start: '2026-11-01T05:30:00Z', end: '2026-11-01T13:00:00Z' },   // North America: clocks back at 06:00Z
  { key: 'X4', from: 'FRA', to: 'YYZ', start: '2027-03-14T06:00:00Z', end: '2027-03-14T14:30:00Z' },   // North America: clocks forward at 07:00Z
];

/** Letters only (bijective base 26): 0 -> A, 25 -> Z, 26 -> AA. Real names contain no digits. */
function fctLetters_(n) {
  let s = '';
  let x = n + 1;
  while (x > 0) { x -= 1; s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26); }
  return s;
}

/** Synthetic employee-number-shaped id, built at runtime: "99" + four digits + "X". Person 0 is the owner. */
function fctSynthId_(n) {
  return '99' + ('0000' + n).slice(-4) + 'X';
}

function fctRank_(n) {
  return FCT_RANKS_[n] || 'FA';
}

function fctPerson_(n) {
  return { n: n, rank: fctRank_(n), id: fctSynthId_(n), family: 'TESTCREW' + fctLetters_(n), given: 'SAMPLE' + fctLetters_(n) };
}

/** A crew-list line in the airline's layout. */
function fctCrewLine_(p) {
  return p.rank + ' ' + p.id + ' ' + p.family + ', ' + p.given + ' (FRA)';
}

function fctDayStart_(key) {
  return Date.parse(key + 'T00:00:00Z');
}

function fctKeyPlus_(key, days) {
  return new Date(fctDayStart_(key) + days * FCT_DAY_MS_).toISOString().slice(0, 10);
}

/** 'YYYY-MM' of the month k months before the anchor's month. */
function fctMonthBefore_(anchorKey, k) {
  const y = Number(anchorKey.slice(0, 4));
  const m = Number(anchorKey.slice(5, 7));
  return new Date(Date.UTC(y, m - 1 - k, 1)).toISOString().slice(0, 7);
}

/** Instant of "dayKey hh:mm" read as UTC, plus whole days. */
function fctAt_(dayKey, hhmm, plusDays) {
  return Date.parse(dayKey + 'T' + hhmm + ':00Z') + (plusDays || 0) * FCT_DAY_MS_;
}

/** European summer time (EU rule): from the last Sunday of March 01:00Z to the last Sunday of October 01:00Z. */
function fctLastSunday1Z_(year, monthIndex) {
  const last = new Date(Date.UTC(year, monthIndex + 1, 0, 1, 0, 0));
  return last.getTime() - last.getUTCDay() * FCT_DAY_MS_;
}

/** First instant of a Berlin local date (day codes are aligned to it; DST days are 23 or 25 hours long). */
function fctBerlinDayStart_(key) {
  const utcMidnight = fctDayStart_(key);
  const year = Number(key.slice(0, 4));
  const cet = utcMidnight - 3600000;
  const summer = cet >= fctLastSunday1Z_(year, 2) && cet < fctLastSunday1Z_(year, 9);
  return utcMidnight - (summer ? 7200000 : 3600000);
}

function fctDescription_(from, to, crew, hotelCity) {
  const lines = [from + ' SAMPLE AIRPORT ' + from, to + ' SAMPLE AIRPORT ' + to, '', 'DTEST (32N)', ''];
  (crew || []).forEach(function (c) { lines.push(typeof c === 'string' ? c : fctCrewLine_(c)); });
  lines.push('', 'Booking code: SAMPLE9');
  if (hotelCity) lines.push('', 'Hotel', 'Sample Riverside Hotel', '99 Sample Street', hotelCity, '+00 000 000000');
  return lines.join('\n');
}

/** One flight event. crew: null = no crew list, otherwise persons and/or raw lines. */
function fctFlight_(key, fn, from, to, start, end, crew, hotelCity) {
  return {
    key: key, sourceId: key, title: fn + ' ' + from + '-' + to, start: start, end: end, location: from,
    description: fctDescription_(from, to, crew, hotelCity),
  };
}

/** The synced-copy form of an event: decorated title and the original text under "Original Notes:". */
function fctSynced_(ev) {
  return {
    key: ev.key, sourceId: ev.sourceId, title: FCT_SYNC_PREFIX_ + ev.title, start: ev.start, end: ev.end, location: ev.location,
    description: '✈️ Flight ' + ev.title + '\n   Weather: sample\n---\nOriginal Notes:\n' + ev.description,
  };
}

/** A whole Berlin local day as the feed encodes a day code. */
function fctDayCode_(key, code, dayKey, note) {
  return {
    key: key, sourceId: key, title: code, start: fctBerlinDayStart_(dayKey), end: fctBerlinDayStart_(fctKeyPlus_(dayKey, 1)), location: 'FRA',
    description: 'FRA SAMPLE AIRPORT FRA\n\n' + note,
  };
}

function fctFixture_(anchorKey) {
  if (typeof anchorKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(anchorKey) || fctKeyPlus_(anchorKey, 0) !== anchorKey) {
    throw new Error('fctest-bad-anchor');
  }
  const anchor = fctDayStart_(anchorKey);
  const owner = fctPerson_(0);
  let counter = 7100;
  const nextFn = function () { counter += 1; return 'DE' + counter; };
  const crewOf = function (ns) { return [owner].concat(ns.map(fctPerson_)); };

  // --- History (synced copy): everything ends before the anchor day ---------------------------------
  const synced = [];
  const duties = [];            // { ids: [person n], indexable }: what a correct index records, for the expectations
  const addDuty = function (ids, indexable) { duties.push({ ids: ids, indexable: indexable !== false }); };

  // An out-and-back day: one duty of two sectors with the same crew.
  const pair = function (key, dayKey, dest, ns) {
    const crew = crewOf(ns);
    synced.push(fctSynced_(fctFlight_(key + 'o', nextFn(), 'FRA', dest, fctAt_(dayKey, '06:00'), fctAt_(dayKey, '08:30'), crew)));
    synced.push(fctSynced_(fctFlight_(key + 'r', nextFn(), dest, 'FRA', fctAt_(dayKey, '09:30'), fctAt_(dayKey, '12:00'), crew)));
    addDuty(ns);
  };
  const LONG = {
    1: { dest: 'BKK', out: ['08:00', '19:00'], back: ['17:30', '05:00'] },     // east
    2: { dest: 'YYZ', out: ['09:00', '17:30'], back: ['22:00', '05:30'] },     // west
    3: { dest: 'CMB', out: ['09:00', '18:40'], back: ['20:00', '06:30'] },     // half-hour zone (UTC+05:30)
    4: { dest: 'BKK', out: ['08:00', '19:00'], back: ['17:30', '05:00'] },
    5: { dest: 'YYZ', out: ['09:00', '17:30'], back: ['22:00', '05:30'] },
  };
  const LONG_CREW = [1, 2, 3, 12, 13, 14];
  for (let k = 1; k <= FCT_HISTORY_MONTHS_; k++) {
    const month = fctMonthBefore_(anchorKey, k);
    const day = function (d) { return month + '-' + ('0' + d).slice(-2); };
    [3, 14, 19, 25].forEach(function (d, i) {
      pair('H' + k + 'd' + d, day(d), FCT_SHORT_DESTINATIONS_[(k + i) % 4], FCT_GROUPS_[(k + i) % 4]);
    });
    const lh = LONG[k];
    const crew = crewOf(LONG_CREW);
    synced.push(fctSynced_(fctFlight_('H' + k + 'lo', nextFn(), 'FRA', lh.dest, fctAt_(day(7), lh.out[0]), fctAt_(day(7), lh.out[1]), crew, 'Sampletown')));
    synced.push(fctSynced_(fctFlight_('H' + k + 'lr', nextFn(), lh.dest, 'FRA', fctAt_(day(9), lh.back[0]), fctAt_(day(9), lh.back[1], 1), crew)));
    addDuty(LONG_CREW);
    addDuty(LONG_CREW);
  }
  // Anomalies in the oldest month: no crew list, invalid crew records, a crew list without the owner.
  const oldest = fctMonthBefore_(anchorKey, FCT_HISTORY_MONTHS_);
  const oldDay = function (d) { return oldest + '-' + ('0' + d).slice(-2); };
  synced.push(fctSynced_(fctFlight_('HA1', nextFn(), 'FRA', 'PMI', fctAt_(oldDay(27), '06:00'), fctAt_(oldDay(27), '08:30'), null)));
  addDuty([], false);
  const p1 = fctPerson_(1);
  const p2 = fctPerson_(2);
  const invalidLines = function () {
    return [owner, p1, 'CP ### broken line', 'FA ' + fctSynthId_(30) + ' TESTCREW' + fctLetters_(30) + '1, SAMPLE' + fctLetters_(30) + ' (FRA)',
      p2, p2, 'FA ' + fctSynthId_(31) + ' TESTCREW' + fctLetters_(31) + ', SAMPLE' + new Array(120).join('X') + ' (FRA)',
      'FA TESTCREW' + fctLetters_(32) + ', SAMPLE' + fctLetters_(32) + ' (FRA)'];
  };
  synced.push(fctSynced_(fctFlight_('HA2', nextFn(), 'FRA', 'LPA', fctAt_(oldDay(28), '06:00'), fctAt_(oldDay(28), '10:00'), invalidLines())));
  addDuty([1, 2]);
  synced.push(fctSynced_(fctFlight_('HA3', nextFn(), 'FRA', 'HER', fctAt_(oldDay(21), '06:00'), fctAt_(oldDay(21), '09:30'), [p1, p2])));
  addDuty([], false);
  // The last two days before the anchor (the previous month may still be open when it is early in the month).
  pair('HR1', fctKeyPlus_(anchorKey, -2), 'PMI', FCT_GROUPS_[0]);
  pair('HR2', fctKeyPlus_(anchorKey, -1), 'LPA', FCT_GROUPS_[1]);

  // --- Fixed daylight-saving events: feed when still ahead, otherwise the synced copy -------------------
  const fixedNumbers = {};
  FCT_FIXED_DST_.forEach(function (f) { fixedNumbers[f.key] = nextFn(); });
  const histMs = synced.map(function (e) { return e.start; });
  const fixedFeed = [];
  const fixedFutureStarts = [];
  FCT_FIXED_DST_.forEach(function (f) {
    const ev = fctFlight_(f.key, fixedNumbers[f.key], f.from, f.to, Date.parse(f.start), Date.parse(f.end), crewOf([1, 2, 3]));
    if (ev.start >= anchor + FCT_DAY_MS_) { fixedFeed.push(ev); fixedFutureStarts.push(ev.start); return; }
    // In the past: only when no history flight is within 36 h (it would change the grouping); otherwise dropped.
    const clear = histMs.every(function (t) { return Math.abs(t - ev.start) > 36 * 3600000; });
    if (ev.end < anchor && clear) { synced.push(fctSynced_(ev)); addDuty([1, 2, 3]); }
  });

  // --- Feed block: moved later when a fixed future event would sit close to it ------------------------------
  let base = 1;
  const near = function (b) {
    return fixedFutureStarts.some(function (t) { return t >= anchor + (b - 3) * FCT_DAY_MS_ && t <= anchor + (b + 18) * FCT_DAY_MS_; });
  };
  while (near(base) && base < 400) base += 1;
  const dayAt = function (offset) { return fctKeyPlus_(anchorKey, base + offset); };

  const feed = [];
  feed.push(fctDayCode_('OFF1', 'OFF', fctKeyPlus_(anchorKey, 1), 'Off Day (sample)'));
  // F1: the primary lookup target, an out-and-back duty (with a check-in before it).
  const f1Ns = [1, 2, 3, 4, 20];
  const f1Crew = crewOf(f1Ns);
  const f1o = nextFn();
  const f1r = nextFn();
  feed.push({ key: 'CI1', sourceId: 'CI1', title: 'C/I', start: fctAt_(dayAt(2), '04:30'), end: fctAt_(dayAt(2), '06:00'), location: 'FRA', description: 'FRA SAMPLE AIRPORT FRA\n\nCheck-in' });
  feed.push(fctFlight_('F1o', f1o, 'FRA', 'PMI', fctAt_(dayAt(2), '06:00'), fctAt_(dayAt(2), '08:30'), f1Crew));
  feed.push(fctFlight_('F1r', f1r, 'PMI', 'FRA', fctAt_(dayAt(2), '09:30'), fctAt_(dayAt(2), '12:00'), f1Crew));
  // F2: the schedule-change target.
  const f2fn = nextFn();
  const f2Base = fctFlight_('F2', f2fn, 'FRA', 'LPA', fctAt_(dayAt(3), '05:00'), fctAt_(dayAt(3), '09:30'), crewOf([1, 5, 3, 6]));
  feed.push(f2Base);
  const f2Changed = fctFlight_('F2', f2fn, 'FRA', 'LPA', fctAt_(dayAt(3), '06:30'), fctAt_(dayAt(3), '11:00'), crewOf([1, 5, 3, 22]));
  // F4: a flight without a crew list.
  const f4fn = nextFn();
  feed.push(fctFlight_('F4', f4fn, 'FRA', 'PMI', fctAt_(dayAt(4), '05:30'), fctAt_(dayAt(4), '08:00'), null));
  // F5: invalid crew records.
  const f5fn = nextFn();
  feed.push(fctFlight_('F5', f5fn, 'FRA', 'PMI', fctAt_(dayAt(5), '06:00'), fctAt_(dayAt(5), '08:30'), invalidLines()));
  // F3: long-haul to a half-hour zone with a layover (hotel block) and a return that crosses local midnight.
  const f3o = nextFn();
  const f3r = nextFn();
  const f3Crew = crewOf([1, 2, 3, 12, 13, 14]);
  feed.push({ key: 'CI3', sourceId: 'CI3', title: 'C/I', start: fctAt_(dayAt(7), '07:00'), end: fctAt_(dayAt(7), '08:30'), location: 'FRA', description: 'FRA SAMPLE AIRPORT FRA\n\nCheck-in' });
  feed.push(fctFlight_('F3o', f3o, 'FRA', 'CMB', fctAt_(dayAt(7), '09:00'), fctAt_(dayAt(7), '18:40'), f3Crew, 'Sampletown'));
  feed.push(fctFlight_('F3r', f3r, 'CMB', 'FRA', fctAt_(dayAt(9), '20:00'), fctAt_(dayAt(9), '06:30', 1), f3Crew));
  // F6: westbound out, return across midnight.
  const f6Crew = crewOf([7, 8, 3, 9]);
  const f6o = nextFn();
  const f6r = nextFn();
  feed.push(fctFlight_('F6o', f6o, 'FRA', 'YYZ', fctAt_(dayAt(11), '09:00'), fctAt_(dayAt(11), '17:30'), f6Crew, 'Sampletown'));
  feed.push(fctFlight_('F6r', f6r, 'YYZ', 'FRA', fctAt_(dayAt(13), '22:00'), fctAt_(dayAt(13), '05:30', 1), f6Crew));
  fixedFeed.forEach(function (ev) { feed.push(ev); });
  // Day codes around the daylight-saving dates (Berlin local days: 25 h after the autumn change).
  [['OFF2', 'OFF', '2026-10-26', 'Off Day (sample)'], ['U1', 'U', '2027-03-29', 'Leave (sample)']].forEach(function (d) {
    if (fctDayStart_(d[2]) >= anchor + FCT_DAY_MS_) feed.push(fctDayCode_(d[0], d[1], d[2], d[3]));
  });
  const byStart = function (a, b) { return a.start - b.start || (a.key < b.key ? -1 : 1); };
  feed.sort(byStart);
  synced.sort(byStart);

  // --- Expectations: what a correct index and lookup report for this fixture ---------------------------------
  const recorded = function (n) {
    return duties.filter(function (d) { return d.indexable && d.ids.indexOf(n) >= 0; }).length;
  };
  const member = function (n) { const p = fctPerson_(n); return { rank: p.rank, family: p.family, given: p.given, count: recorded(n) }; };
  const expect = {
    primary: { key: 'F1o', flightNumber: f1o, members: f1Ns.map(member) },
    scheduleChange: { key: 'F2', flightNumber: f2fn, before: crewOf([1, 5, 3, 6]).slice(1).map(function (p) { return member(p.n); }),
      after: crewOf([1, 5, 3, 22]).slice(1).map(function (p) { return member(p.n); }), shiftMinutes: 90 },
    noCrewList: { key: 'F4', flightNumber: f4fn },
    // F5: one valid member (1), two unparseable lines, one listed twice (kept once, member 2), one line without an id.
    invalid: { key: 'F5', flightNumber: f5fn, members: 5, unavailable: 3 },
    // Local-time facts of the roster answer (offsets and local-date shift), for the live time-zone check.
    zones: [
      { key: 'F3o', flightNumber: f3o, arrOffset: '+05:30', dayShift: 1 },                 // half-hour zone, lands after local midnight
      { key: 'F6r', flightNumber: f6r, dayShift: 1 },                                      // westbound origin, lands the next local day
      { key: 'X1', flightNumber: fixedNumbers.X1, depOffset: '+02:00', arrOffset: '+01:00' },
      { key: 'X2', flightNumber: fixedNumbers.X2, depOffset: '+01:00', arrOffset: '+02:00' },
      { key: 'X3', flightNumber: fixedNumbers.X3, depOffset: '-04:00', arrOffset: '+01:00' },
      { key: 'X4', flightNumber: fixedNumbers.X4, depOffset: '+01:00', arrOffset: '-04:00' },
    ],
    historyEvents: synced.length,
    sealedFullMonths: 4,
  };
  return {
    anchor: anchorKey,
    selfId: owner.id,
    feed: feed,
    synced: synced,
    variants: {
      scheduleChange: {
        key: 'F2', start: f2Changed.start, end: f2Changed.end, description: f2Changed.description,
        before: { start: f2Base.start, end: f2Base.end },
      },
    },
    expect: expect,
    meta: { feedBaseDays: base, fixedFeed: fixedFeed.length, version: 1 },
  };
}
