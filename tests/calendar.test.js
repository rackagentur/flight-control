// Calendar: month geometry, coverage honesty, state semantics, rotations, detail, and
// consistency with Today (both use roster.buildDays). Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildMonth, addMonths, daysInMonth, monthLabel, weekdayIndex } from '../src/model/calendar.js';
import { buildDays } from '../src/model/roster.js';
import { sampleSnapshot, sampleProfile } from '../src/sources/sample.js';
import { calendar, resetCalendarUi } from '../src/ui/screens/calendar.js';
import { PROFILE, at, fixtureSnapshot, pipeline } from './helpers.js';

const SP = sampleProfile(PROFILE);
const fx = fixtureSnapshot();

function month(snapshot, iso, monthKey, profile = PROFILE) {
  const { roster, now } = pipeline(snapshot, iso, profile);
  return buildMonth(snapshot, roster, profile, now, monthKey);
}

function renderCalendar(snapshot, iso, { profile = PROFILE, monthKey = null, selected = null, review = false } = {}) {
  const view = snapshot ? { ...pipeline(snapshot, iso, profile), snapshot, profile, review, loading: false, error: null } : { profile, now: at(iso), snapshot: null, roster: null, state: null, review, loading: false };
  resetCalendarUi(monthKey, selected);
  return calendar.render({ view: () => view }).toString();
}

test('month geometry: Monday-first weeks, leading/trailing days, month boundaries', () => {
  const oct = month(fx, '2026-10-04T08:00:00Z', '2026-10');
  assert.equal(oct.label, 'October 2026');
  assert.equal(oct.days[0].date, '2026-09-28');
  assert.equal(oct.days.at(-1).date, '2026-11-01');
  assert.equal(oct.weeks.length, 5);
  assert.ok(oct.weeks.every((w) => w.length === 7));
  assert.equal(oct.days.filter((d) => d.inMonth).length, 31);
  // February 2027 starts on a Monday and has exactly four weeks.
  const feb = month(fx, '2026-10-04T08:00:00Z', '2027-02');
  assert.equal(feb.weeks.length, 4);
  assert.equal(weekdayIndex('2027-02-01'), 0);
  assert.equal(daysInMonth('2028-02'), 29);
});

test('year boundaries: navigation and grids spanning two years', () => {
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2027-01', -1), '2026-12');
  assert.equal(addMonths('2026-10', -22), '2024-12');
  assert.equal(monthLabel('2027-01'), 'January 2027');
  const dec = month(fx, '2026-10-04T08:00:00Z', '2026-12');
  assert.equal(dec.days.at(-1).date, '2027-01-03');
  assert.equal(dec.days.filter((d) => d.date.startsWith('2027')).every((d) => !d.inMonth), true);
});

test('DST months: local days are 25 h / 23 h long and the grid stays aligned', () => {
  const oct = month(fx, '2026-10-04T08:00:00Z', '2026-10');
  const d25 = oct.days.find((d) => d.date === '2026-10-25');
  assert.equal((d25.end - d25.start) / 3600000, 25);
  const mar = month(fx, '2026-10-04T08:00:00Z', '2027-03');
  const d28 = mar.days.find((d) => d.date === '2027-03-28');
  assert.equal((d28.end - d28.start) / 3600000, 23);
  assert.equal(mar.days[0].date, '2027-03-01');
});

test('today highlight: exactly one day, in the home time zone', () => {
  const late = month(fx, '2026-10-04T22:30:00Z', '2026-10'); // 00:30 on 5 Oct in Berlin
  const todays = late.days.filter((d) => d.isToday);
  assert.equal(todays.length, 1);
  assert.equal(todays[0].date, '2026-10-05');
  const html = renderCalendar(fx, '2026-10-04T08:00:00Z');
  assert.equal((html.match(/aria-current="date"/g) ?? []).length, 1);
});

test('OFF vs UNKNOWN: v5 never yields OFF; unknown days are never labelled or styled as OFF', () => {
  const oct = month(fx, '2026-10-04T08:00:00Z', '2026-10');
  assert.equal(oct.days.filter((d) => d.status === 'off').length, 0);
  const free = oct.days.find((d) => d.date === '2026-10-05');
  assert.equal(free.status, 'unknown');
  assert.equal(free.evidence, 'no-duty-reported');
  const html = renderCalendar(fx, '2026-10-04T08:00:00Z');
  const cell = html.match(/<button[^>]*data-date="2026-10-05"[\s\S]*?<\/button>/)[0];
  assert.ok(cell.includes('is-unknown'));
  assert.ok(!/is-off|>OFF</.test(cell));
});

test('explicit OFF (source states it) renders as OFF with its own mark and text', () => {
  const now = at('2026-10-04T08:00:00Z');
  const sample = sampleSnapshot('flight', null, now, SP);
  const m = month(sample, '2026-10-04T08:00:00Z', '2026-10', SP);
  const off = m.days.filter((d) => d.status === 'off');
  assert.ok(off.length >= 3);
  assert.ok(off.every((d) => d.confidence === 'confirmed' && d.provenance === 'source'));
  const html = renderCalendar(sample, '2026-10-04T08:00:00Z', { profile: SP, review: true });
  const cell = html.match(new RegExp(`<button[^>]*data-date="${off[0].date}"[\\s\\S]*?<\\/button>`))[0];
  assert.ok(cell.includes('is-off') && cell.includes('>OFF<'));
});

test('confirmed vs inferred layover stay distinguishable', () => {
  const now = at('2026-10-04T08:00:00Z');
  const sample = sampleSnapshot('flight', null, now, SP);
  const octAll = month(sample, '2026-10-04T08:00:00Z', '2026-10', SP);
  const confirmed = octAll.days.filter((d) => d.status === 'layover' && d.confidence === 'confirmed');
  assert.ok(confirmed.length >= 1, 'source-stated layover window');
  const oct = month(sample, '2026-10-04T08:00:00Z', '2026-10', SP);
  const inferred = oct.days.filter((d) => d.status === 'layover' && d.confidence === 'inferred');
  assert.ok(inferred.length >= 1);
  assert.ok(inferred.every((d) => d.provenance === 'derived'));
  const html = renderCalendar(sample, '2026-10-04T08:00:00Z', { profile: SP, review: true });
  const cell = html.match(new RegExp(`<button[^>]*data-date="${inferred[0].date}"[\\s\\S]*?<\\/button>`))[0];
  assert.ok(cell.includes('is-inferred') && /kind-layover is-inferred/.test(cell));
  assert.match(cell, /inferred/i);
});

test('standby / reserve only from source windows, with their window times', () => {
  const now = at('2026-10-04T08:00:00Z');
  const sample = sampleSnapshot('flight', null, now, SP);
  const oct = month(sample, '2026-10-04T08:00:00Z', '2026-10', SP);
  assert.equal(oct.summary.standbyDays, 2);
  assert.equal(oct.summary.reserveDays, 2);
  const sb = oct.days.find((d) => d.status === 'standby');
  assert.ok(sb.window && sb.window.kind === 'standby');
  // v5 has no windows: never standby/reserve, the duty day stays "type not given".
  const v5 = month(fx, '2026-10-04T08:00:00Z', '2026-10');
  assert.equal(v5.summary.standbyDays + v5.summary.reserveDays, 0);
  assert.equal(v5.days.find((d) => d.date === '2026-10-06').evidence, 'duty-unspecified');
});

test('duplicate sectors do not produce duplicate calendar entries or counts', () => {
  const dup = fixtureSnapshot((p) => { p.upcoming.splice(1, 0, { ...p.upcoming[0] }); });
  const a = month(fx, '2026-10-04T08:00:00Z', '2026-10');
  const b = month(dup, '2026-10-04T08:00:00Z', '2026-10');
  assert.deepEqual(b.summary, a.summary);
  assert.equal(b.days.find((d) => d.date === '2026-10-10').sectors.length, 1);
});

test('multi-day rotation grouping and outstation return', () => {
  const oct = month(fx, '2026-10-04T08:00:00Z', '2026-10');
  const span = ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13'].map((k) => oct.days.find((d) => d.date === k));
  assert.deepEqual(span.map((d) => d.rotationPos), ['start', 'middle', 'middle', 'end']);
  assert.equal(new Set(span.map((d) => d.rotationId)).size, 1);
  assert.deepEqual(span.map((d) => d.status), ['flight', 'layover', 'layover', 'flight']);
  assert.equal(span[3].label, 'FRA', 'return from the outstation lands at base');
  assert.equal(span[3].rotationOpenEnd, false);
});

test('rotations are never joined across an itinerary gap', () => {
  const gap = fixtureSnapshot((p) => { p.upcoming[1].origin = 'YUL'; });
  const oct = month(gap, '2026-10-04T08:00:00Z', '2026-10');
  const out = oct.days.find((d) => d.date === '2026-10-10');
  const back = oct.days.find((d) => d.date === '2026-10-13');
  assert.notEqual(out.rotationId, back.rotationId);
  assert.ok(oct.days.every((d) => d.status !== 'layover' || d.date < '2026-10-10' || d.date > '2026-10-13'));
});

test('overnight flight crossing midnight: both local days are flight days', () => {
  const oct = month(fx, '2026-10-04T08:00:00Z', '2026-10');
  // DXB→FRA departs 27 Oct 23:30 Berlin, arrives 28 Oct 06:00.
  assert.equal(oct.days.find((d) => d.date === '2026-10-27').status, 'flight');
  assert.equal(oct.days.find((d) => d.date === '2026-10-28').status, 'flight');
});

test('partial source coverage: before / after the window is "no data", never filled in', () => {
  const oct = month(fx, '2026-10-04T08:00:00Z', '2026-10');
  const ev = (k) => oct.days.find((d) => d.date === k).evidence;
  assert.equal(ev('2026-10-01'), 'before-source');
  assert.equal(ev('2026-10-20'), 'no-flight-listed');
  assert.equal(ev('2026-11-01'), 'outside-window');
  assert.equal(oct.coverage.from, '2026-10-04');
  assert.equal(oct.coverage.flightsTo, '2026-10-30');
  assert.equal(oct.coverage.freeListTo, '2026-10-12');
  assert.equal(oct.coverage.complete, false);
  const nov = month(fx, '2026-10-04T08:00:00Z', '2026-11');
  assert.ok(nov.days.filter((d) => d.inMonth).every((d) => d.status !== 'off'));
});

test('no source: Calendar says so instead of drawing an empty roster', () => {
  const html = renderCalendar(null, '2026-10-04T08:00:00Z');
  assert.match(html, /No roster source connected/);
  assert.ok(!html.includes('cal-grid'));
});

test('selected day detail shows only supported fields', () => {
  const html = renderCalendar(fx, '2026-10-04T08:00:00Z', { monthKey: '2026-10', selected: '2026-10-10' });
  const detail = html.slice(html.indexOf('cal-detail-card'));
  assert.match(detail, /day 1 of 4/i);
  assert.match(detail, /DE2074/);
  assert.match(detail, /Wake-up/);
  assert.match(detail, /12:20/, 'corrected local arrival');
  assert.ok(!/Briefing/.test(detail), 'no report time in v5');
  const ret = renderCalendar(fx, '2026-10-04T08:00:00Z', { monthKey: '2026-10', selected: '2026-10-13' });
  const flights = ret.slice(ret.indexOf('cal-sectors'));
  assert.ok(flights.includes('DE2075'));
  assert.ok(!/Wake-up|Pickup/.test(flights.slice(0, flights.indexOf('</section>'))), 'v5 dropped the return pickup; nothing invented');
});

test('mobile layout assumptions: seven flexible columns, no fixed cell widths, short codes', () => {
  const css = readFileSync(new URL('../assets/css/screens.css', import.meta.url), 'utf8');
  assert.match(css, /\.cal-row \{[^}]*grid-template-columns: repeat\(7, minmax\(0, 1fr\)\)/);
  const dayRule = css.match(/\.cal-day \{[^}]*\}/)[0];
  assert.ok(!/(?:^|[;\s])width:\s*\d/.test(dayRule) && !/min-width:\s*[1-9]/.test(dayRule));
  const oct = month(fx, '2026-10-04T08:00:00Z', '2026-10');
  assert.ok(oct.days.every((d) => (d.label ?? '').length <= 4));
});

test('Today and Calendar agree: same classifier, and the hero never contradicts the day', () => {
  const instants = [];
  for (let h = 0; h < 24 * 30; h += 11) instants.push(new Date(at('2026-10-04T00:00:00Z') + h * 3600000).toISOString());
  const check = (snapshot, profile, label) => {
    for (const iso of instants) {
      const { roster, state, now } = pipeline(snapshot, iso, profile);
      const [todayDay] = buildDays(snapshot, roster, profile, now, { count: 1 });
      // 7-day strip (Today) and the Calendar month are the same objects for the same dates.
      const m = buildMonth(snapshot, roster, profile, now, todayDay.date.slice(0, 7));
      const calDay = m.days.find((d) => d.date === todayDay.date);
      assert.equal(calDay.status, roster.days[0].status, `${label} ${iso}`);
      if (state.status === 'flight') assert.equal(todayDay.status, 'flight', `${label} ${iso}: hero FLIGHT, day ${todayDay.status}`);
      if (state.status === 'off') assert.equal(todayDay.status, 'off', `${label} ${iso}`);
      if (todayDay.status === 'flight') assert.ok(['flight', 'layover', 'standby', 'reserve'].includes(state.status), `${label} ${iso}: day FLIGHT, hero ${state.status}`);
      if (todayDay.status === 'off') assert.equal(state.status, 'off', `${label} ${iso}`);
    }
  };
  check(fx, PROFILE, 'v5 fixture');
  for (const s of ['off', 'flight', 'standby', 'reserve', 'layover', 'unknown']) {
    check(sampleSnapshot(s, 'ocean', at('2026-10-04T08:00:00Z'), SP), SP, `sample ${s}`);
  }
});

test('edge: a duty landing exactly at home midnight does not make the next day FLIGHT anywhere', () => {
  const midnight = fixtureSnapshot((p) => {
    const arr = Date.parse('2026-10-14T22:00:00Z'); // 00:00 on 15 Oct, Berlin
    p.upcoming = [{ ...p.upcoming[0], flightNumber: 'DE9100', origin: 'LIS', destination: 'FRA', depTimestamp: arr - 3 * 3600000, endTimestamp: arr, pickupTimestamp: null }];
  });
  for (const iso of ['2026-10-15T06:00:00Z', '2026-10-15T13:00:00Z', '2026-10-15T21:30:00Z']) {
    const { roster, state, now } = pipeline(midnight, iso);
    const [day] = buildDays(midnight, roster, PROFILE, now, { count: 1 });
    assert.notEqual(state.status, 'flight', iso);
    assert.notEqual(day.status, 'flight', iso);
  }
});

function windowed(windows) {
  return { ...fx, sectors: fx.sectors, windows, capabilities: { ...fx.capabilities, explicitOff: true, standbyWindows: true } };
}

test('edge: off and standby windows on the same day → STANDBY in both Today and Calendar', () => {
  const s = at('2026-10-06T22:00:00Z'); // 7 Oct 00:00 Berlin
  const snap = windowed([
    { kind: 'off', start: s, end: s + 86400000, label: 'OFF' },
    { kind: 'standby', start: s + 5 * 3600000, end: s + 17 * 3600000, label: 'SB' },
  ]);
  const { roster, state, now } = pipeline(snap, '2026-10-07T08:00:00Z');
  const [day] = buildDays(snap, roster, PROFILE, now, { count: 1 });
  assert.equal(day.status, 'standby');
  assert.equal(state.status, 'standby');
});

test('edge: an off window during an inferred layover → LAYOVER in both (away is the operational fact)', () => {
  const s = at('2026-10-10T22:00:00Z'); // 11 Oct 00:00 Berlin, inside the YYZ layover
  const snap = windowed([{ kind: 'off', start: s, end: s + 86400000, label: 'OFF' }]);
  const { roster, state, now } = pipeline(snap, '2026-10-11T15:00:00Z');
  const [day] = buildDays(snap, roster, PROFILE, now, { count: 1 });
  assert.equal(day.status, 'layover');
  assert.equal(state.status, 'layover');
  assert.equal(day.window?.kind, 'off', 'the stated off day stays attached for the detail panel');
});

test('review sample month shows every state in one month (for visual review)', () => {
  const now = at('2026-10-04T08:00:00Z');
  const m = month(sampleSnapshot('flight', null, now, SP), '2026-10-04T08:00:00Z', '2026-10', SP);
  const kinds = new Set(m.days.filter((d) => d.inMonth).map((d) => (d.status === 'unknown' ? (d.evidence === 'duty-unspecified' ? 'duty' : ['before-source', 'outside-window'].includes(d.evidence) ? 'nodata' : 'unknown') : d.status === 'layover' ? `layover-${d.confidence}` : d.status)));
  for (const k of ['flight', 'layover-confirmed', 'layover-inferred', 'standby', 'reserve', 'off', 'duty', 'unknown', 'nodata']) assert.ok(kinds.has(k), k);
});

test('a roster-stated layover day never also claims to be inferred in the detail', () => {
  const now = at('2026-10-04T08:00:00Z');
  const sample = sampleSnapshot('flight', null, now, SP);
  const confirmed = month(sample, '2026-10-04T08:00:00Z', '2026-10', SP).days.find((d) => d.status === 'layover' && d.confidence === 'confirmed');
  const html = renderCalendar(sample, '2026-10-04T08:00:00Z', { profile: SP, review: true, monthKey: '2026-10', selected: confirmed.date });
  const detail = html.slice(html.indexOf('cal-detail-card'));
  assert.match(detail, /from roster/i);
  assert.ok(!/Away from base · inferred/.test(detail));
});

test('D1: flight, roster layover and inferred layover use three different line shapes', () => {
  const css = readFileSync(new URL('../assets/css/screens.css', import.meta.url), 'utf8');
  const rule = (sel) => (css.match(new RegExp(`${sel.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`)) ?? [])[1] ?? '';
  const flight = rule('.cal-band');
  const roster = rule('.cal-band.kind-layover.is-confirmed');
  const inferred = rule('.cal-band.kind-layover.is-inferred');
  assert.match(flight, /background: var\(--journey\)/);           // solid line
  assert.match(roster, /linear-gradient\(var\(--layover-tone\) 0 2px, transparent/); // double rail
  assert.match(inferred, /repeating-linear-gradient\(90deg/);      // dotted
});

test('D2: every month has exactly one keyboard-reachable cell', () => {
  for (const mk of ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01']) {
    const html = renderCalendar(fx, '2026-10-04T08:00:00Z', { monthKey: mk });
    assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1, mk);
  }
});

test('D4: away-from-base times are in the outstation\'s local time and labelled', () => {
  const html = renderCalendar(fx, '2026-10-04T08:00:00Z', { monthKey: '2026-10', selected: '2026-10-11' });
  const away = html.slice(html.indexOf('Away from base'));
  assert.match(away.slice(0, 400), /Sat 10 Oct 12:20 → Mon 12 Oct 18:30 local time/);
});
