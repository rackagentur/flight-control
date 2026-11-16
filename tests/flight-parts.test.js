// Step 6A aviation components: route hero, sector card, milestone rows, status chip, and their
// integration into the Flights list (journey rail) and Flight detail. Synthetic data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFlights } from '../src/model/flights.js';
import { sampleSnapshot, sampleProfile } from '../src/sources/sample.js';
import { flights as screen } from '../src/ui/screens/flights.js';
import { today } from '../src/ui/screens/today.js';
import { calendar, resetCalendarUi } from '../src/ui/screens/calendar.js';
import { radar, resetRadarUi } from '../src/ui/screens/radar.js';
import { icon } from '../src/ui/icons.js';
import { milestoneList, milestoneRow, relativeIn, routeHero, sectorCard, sectorLabel, sectorStatus, statusChip } from '../src/ui/flight-parts.js';
import { PROFILE, at, fixtureSnapshot, pipeline } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const NOW = '2026-10-04T06:00:00Z';
const SP = sampleProfile(PROFILE);

function entries(iso = NOW) {
  const snap = fixtureSnapshot();
  const { now, roster, state } = pipeline(snap, iso);
  const f = buildFlights(snap, roster, state, PROFILE, now);
  return { snap, f, first: f.upcoming[0].sectors[0], second: f.upcoming[0].sectors[1] };
}

function render(snapshot, { iso = NOW, profile = PROFILE, param = null, review = false } = {}) {
  const v = pipeline(snapshot, iso, profile);
  const view = { ...v, profile, snapshot, review, loading: false, error: null };
  return screen.render({ view: () => view, param: () => param, weather: () => ({ status: 'unavailable', reason: 'no-destination' }) }).toString();
}

// --- routeHero ------------------------------------------------------------------------------------------

test('routeHero: codes in order, decorative arrows, a hidden " to " for the accessible name', () => {
  const out = routeHero({ codes: ['AAA', 'BBB', 'CCC', 'BBB'], size: 'title' }).toString();
  assert.match(out, /^<div class="route-hero rh-title"/);
  assert.deepEqual([...out.matchAll(/<span class="rh-code t-airport">([A-Z]{3})<\/span>/g)].map((m) => m[1]), ['AAA', 'BBB', 'CCC', 'BBB']);
  const arrows = [...out.matchAll(/<span class="rh-arrow" aria-hidden="true">→<\/span>/g)];
  assert.equal(arrows.length, 3);
  assert.equal([...out.matchAll(/<span class="visually-hidden"> to <\/span>/g)].length, 3);
  // Read aloud (arrows removed, hidden text kept): "AAA to BBB to CCC to BBB".
  const spoken = out.replace(/<span class="rh-arrow"[^>]*>→<\/span>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  assert.equal(spoken, 'AAA to BBB to CCC to BBB');
});

test('routeHero: cities only when provided; sizes; span root for headings; escaped input', () => {
  const plain = routeHero({ codes: ['AAA', 'BBB'], size: 'hero' }).toString();
  assert.doesNotMatch(plain, /rh-city/);
  assert.match(plain, /rh-hero/);
  const withCities = routeHero({ codes: ['AAA', 'BBB'], cities: ['Alpha', null], size: 'hero' }).toString();
  assert.equal([...withCities.matchAll(/class="rh-city" aria-hidden="true"/g)].length, 1, 'a missing city leaves no empty line');
  assert.match(withCities, /rh-city" aria-hidden="true">Alpha</);
  assert.match(routeHero({ codes: ['AAA', 'BBB'], size: 'inline' }).toString(), /rh-inline/);
  assert.match(routeHero({ codes: ['AAA', 'BBB'], as: 'span', id: 'x' }).toString(), /^<span class="route-hero rh-title" id="x"/);
  assert.match(routeHero({ codes: ['AAA', 'BBB'], size: 'nonsense' }).toString(), /rh-title/);
  assert.doesNotMatch(routeHero({ codes: ['<b>'] }).toString(), /<b>/);
});

// --- statusChip / sectorStatus --------------------------------------------------------------------------

test('statusChip: tones map to data-status; neutral carries none', () => {
  for (const tone of ['positive', 'caution', 'critical']) {
    assert.equal(statusChip({ tone, label: 'X' }).toString(), `<span class="chip-status" data-status="${tone}">X</span>`);
  }
  assert.equal(statusChip({ tone: 'neutral', label: 'Flown' }).toString(), '<span class="chip-status" >Flown</span>');
  assert.doesNotMatch(statusChip({ tone: 'neutral', label: 'Flown' }).toString(), /data-status/);
  assert.doesNotMatch(statusChip({ tone: 'bogus', label: 'Flown' }).toString(), /data-status/);
});

test('sectorStatus: active → In the air, past → Flown, upcoming → nothing; never punctuality, gate or delay', () => {
  const sector = { id: 's' };
  assert.deepEqual(sectorStatus({ sector, status: 'active' }, sector), { tone: 'positive', label: 'In the air' });
  assert.deepEqual(sectorStatus({ sector, status: 'past' }, sector), { tone: 'neutral', label: 'Flown' });
  assert.equal(sectorStatus({ sector, status: 'upcoming' }, sector), null);
  assert.equal(sectorStatus(null), null);
  const forbidden = /on[\s-]?time|gate|stand|delay|boarding|cancel/i;
  for (const status of ['past', 'active', 'upcoming', 'unknown', undefined]) {
    const s = sectorStatus({ sector, status }, sector);
    if (s) assert.doesNotMatch(s.label, forbidden);
  }
});

// --- sectorCard -----------------------------------------------------------------------------------------

test('sectorCard keeps the journey link contract and the exact accessible label', () => {
  const { first, second } = entries();
  const card = sectorCard({ sector: first.sector, entry: first, selected: true, href: '#/flights/x' }).toString();
  assert.match(card, /^<a class="jr-link" href="#\/flights\/x" data-sector="DE2074-1791618000000-1791649200000" aria-label="DE2074, FRA 09:40 to YYZ 12:20 UTC−4, Sat 10 Oct" aria-current="true">/);
  assert.equal(sectorLabel(first), 'DE2074, FRA 09:40 to YYZ 12:20 UTC−4, Sat 10 Oct');
  const plain = sectorCard({ sector: second.sector, entry: second, href: '#/flights/y' }).toString();
  assert.doesNotMatch(plain, /aria-current/);
  assert.match(plain, /aria-label="DE2075, YYZ 18:30 to FRA 08:00 UTC\+2 \(\+1 day\), Mon 12 Oct"/);
  // The visual children are hidden from assistive tech; the link name carries the information.
  assert.match(plain, /<span class="jr-main" aria-hidden="true">/);
  assert.match(plain, /<span class="sc-mark" aria-hidden="true"><svg[^>]*aria-hidden="true"/);
  assert.match(plain, /<span class="jr-chev" aria-hidden="true">›<\/span>/);
});

test('sectorCard: bold codes with regular times, +N marker, flight number, block; status and remembered cues', () => {
  const { f, first, second } = entries('2026-10-10T20:00:00Z');
  const flown = sectorCard({ sector: first.sector, entry: f.upcoming[0].sectors[0], href: '#' }).toString();
  assert.match(flown, /<span class="jr-end"><b>FRA<\/b> 09:40<\/span>/);
  assert.match(flown, /<span class="jr-arrow">→<\/span> <b>YYZ<\/b> 12:20/);
  assert.match(flown, /<span class="t-code">DE2074<\/span><span class="jr-dot">·<\/span><span>8h 40m<\/span>/);
  assert.match(flown, /<span class="jr-status"><span class="chip-status" >Flown<\/span><\/span>/);
  assert.match(flown, /aria-label="[^"]*, flown"/);
  const next = sectorCard({ sector: second.sector, entry: f.upcoming[0].sectors[1], href: '#' }).toString();
  assert.match(next, /<sup class="pass-shift" aria-label="plus 1 day">\+1<\/sup>/);
  assert.doesNotMatch(next, /jr-status|chip-status|Remembered/);
  const remembered = sectorCard({ sector: { ...second.sector, provenance: 'history' }, entry: second, href: '#' }).toString();
  assert.match(remembered, /tag-remembered jr-tag">Remembered/);
  assert.match(remembered, /, remembered on this device"/);
  const active = sectorCard({ sector: second.sector, entry: { ...second, status: 'active' }, href: '#' }).toString();
  assert.match(active, /data-status="positive">In the air</);
});

test('sectorCard compact: smaller tile class, no rail node', () => {
  const { first } = entries();
  const compact = sectorCard({ sector: first.sector, entry: first, href: '#', compact: true }).toString();
  assert.match(compact, /^<a class="jr-link sc-compact"/);
  assert.doesNotMatch(compact, /jr-node/);
  assert.match(sectorCard({ sector: first.sector, entry: first, href: '#' }).toString(), /jr-node/);
});

// --- milestones -----------------------------------------------------------------------------------------

test('relativeIn: only for events still ahead; compact human form', () => {
  const t = 1_000_000_000_000;
  const MIN = 60000;
  assert.equal(relativeIn(t, t), null);
  assert.equal(relativeIn(t, t - MIN), null);
  assert.equal(relativeIn(t, Number.NaN), null);
  assert.equal(relativeIn(t, t + 30000), 'in <1m');
  assert.equal(relativeIn(t, t + 45 * MIN), 'in 45m');
  assert.equal(relativeIn(t, t + (4 * 60 + 20) * MIN + 59000), 'in 4h 20m');
  assert.equal(relativeIn(t, t + 3 * 60 * MIN), 'in 3h');
  assert.equal(relativeIn(t, t + (26 * 60 + 5) * MIN), 'in 1d 2h');
  assert.equal(relativeIn(t, t + 48 * 60 * MIN), 'in 2d');
});

test('milestoneRow: icon tile, time, label; relative and note only when given', () => {
  const row = milestoneRow({ icon: 'bell', time: '05:10', label: 'Wake-up', relative: 'in 4h 20m' }).toString();
  assert.match(row, /^<li class="ms-row">/);
  assert.match(row, /<span class="ms-icon" aria-hidden="true"><svg/);
  assert.match(row, /<span class="ms-time t-tabular">05:10<\/span>/);
  assert.match(row, /<span class="ms-label">Wake-up<\/span>/);
  assert.match(row, /<span class="ms-rel t-tabular">in 4h 20m<\/span>/);
  assert.doesNotMatch(row, /ms-note/);
  const bare = milestoneRow({ icon: 'landing', time: '12:55', label: 'Arrival', note: 'Frankfurt · Sat 10 Oct', emphasis: true }).toString();
  assert.doesNotMatch(bare, /ms-rel/);
  assert.match(bare, /^<li class="ms-row is-emphasis">/);
  assert.match(bare, /<span class="ms-note">Frankfurt · Sat 10 Oct<\/span>/);
  const list = milestoneList([milestoneRow({ icon: 'bell', time: '05:10', label: 'Wake-up' }), milestoneRow({ icon: 'landing', time: '12:55', label: 'Arrival' })]).toString();
  assert.match(list, /^<ol class="ms-list" role="list"><li[\s\S]*<\/li>\s*<li[\s\S]*<\/li><\/ol>$/);
});

test('milestone icons exist (not the info fallback) and carry no colour literals', () => {
  const fallback = icon('info').toString();
  for (const name of ['bell', 'car', 'briefing', 'takeoff', 'landing', 'home']) {
    const svg = icon(name).toString();
    assert.notEqual(svg, fallback, name);
    assert.match(svg, /stroke="currentColor" stroke-width="1.6"/);
    assert.doesNotMatch(svg, /#[0-9a-fA-F]{3,8}\b|rgb\(/);
  }
});

// --- integration ----------------------------------------------------------------------------------------

test('Flights list: the rotation title is a route hero, sectors are cards on the rail', () => {
  const html = render(fixtureSnapshot());
  const list = html.slice(0, html.indexOf('data-fl-detail'));
  assert.match(list, /<h3 class="fl-rot-route t-title-2" id="fl-rot-0"><span class="visually-hidden">Rotation <\/span><span class="route-hero rh-title">/);
  assert.match(list, /<h3 class="fl-rot-route t-headline" id="fl-rot-1">[\s\S]*?rh-inline/, 'later rotations use the inline size');
  const links = [...list.matchAll(/<a class="jr-link"/g)].length;
  assert.ok(links > 0);
  assert.equal([...list.matchAll(/class="sc-mark"/g)].length, links, 'every journey link is a sector card with its aircraft mark');
  assert.match(list, /rh-code t-airport">FRA<\/span>[\s\S]*?rh-code t-airport">YYZ<\/span>[\s\S]*?rh-code t-airport">FRA</);
});

test('Flight detail: hero route with cities, status chip beside the provenance pill, milestone rows', () => {
  const { f, first } = entries();
  const html = render(fixtureSnapshot(), { param: first.sector.id });
  const detail = html.slice(html.indexOf('data-fl-detail'));
  assert.match(detail, /<h2 class="t-title-2 fl-detail-route" id="fl-detail-title" tabindex="-1"><span class="route-hero rh-hero">/);
  assert.match(detail, /rh-city" aria-hidden="true">Frankfurt</);
  assert.match(detail, /rh-city" aria-hidden="true">Toronto</);
  assert.match(detail, /<span class="visually-hidden"> to <\/span>/);
  assert.match(detail, /class="ms-list" role="list"/);
  const labels = [...detail.matchAll(/<span class="ms-label">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['Wake-up', 'Pickup', 'Departure', 'Arrival']);
  assert.match(detail, /Block<\/dt>/);
  assert.ok(f.upcoming[0].sectors[0].wakeup !== null);
  // Upcoming sector: no status chip (nothing true to say), a relative time on events still ahead.
  assert.doesNotMatch(detail.slice(0, detail.indexOf('class="ms-list"')), /chip-status/);
  assert.match(detail, /ms-rel t-tabular">in /);
  // The provenance pill is unchanged.
  assert.match(detail, /status-pill" data-confidence="confirmed">Current roster/);
});

test('Flight detail: flown and in-the-air sectors show a status chip; past events never show "in …"', () => {
  const fx = fixtureSnapshot();
  const { first } = entries();
  const flown = render(fx, { iso: '2026-10-10T20:00:00Z', param: first.sector.id });
  const detail = flown.slice(flown.indexOf('data-fl-detail'));
  assert.match(detail, /status-pill" data-confidence="confirmed">Current roster<\/span><span class="chip-status" >Flown<\/span>/);
  assert.doesNotMatch(detail.slice(0, detail.indexOf('Rotation · day')), /ms-rel/);
  const air = render(fx, { iso: '2026-10-10T14:00:00Z', param: first.sector.id });
  const airDetail = air.slice(air.indexOf('data-fl-detail'));
  assert.match(airDetail, /data-status="positive">In the air</);
  assert.equal([...airDetail.matchAll(/class="ms-rel/g)].length, 1, 'only the arrival is still ahead');
  assert.match(airDetail, /ms-label">Arrival<\/span>[\s\S]*?ms-rel t-tabular">in 2h 20m</);
});

test('aircraft detail row appears only when the roster provides it', () => {
  const { first } = entries();
  const html = render(fixtureSnapshot(), { param: first.sector.id });
  const withAircraft = [...html.matchAll(/<dt class="t-eyebrow">Aircraft<\/dt>/g)].length;
  const sectorHasAircraft = Boolean(first.sector.aircraft);
  assert.equal(withAircraft, sectorHasAircraft ? 1 : 0);
});

test('truthfulness: no punctuality, gate, stand or delay wording anywhere in the rendered Flights screen', () => {
  const forbidden = />[^<]*\b(on[\s-]?time|gate|stand|delayed?|boarding|cancelled)\b[^<]*</i;
  const snaps = [['fixture', fixtureSnapshot(), PROFILE, false]];
  for (const state of ['off', 'flight', 'layover']) snaps.push([state, sampleSnapshot(state, 'ocean', at(NOW), SP, null), SP, true]);
  for (const [name, snap, profile, review] of snaps) {
    for (const iso of [NOW, '2026-10-10T14:00:00Z', '2026-10-10T20:00:00Z']) {
      assert.doesNotMatch(render(snap, { iso, profile, review }), forbidden, `${name} ${iso} list`);
      const v = pipeline(snap, iso, profile);
      const f = buildFlights(snap, v.roster, v.state, profile, v.now);
      const id = f.upcoming[0]?.sectors[0]?.sector.id;
      if (id) assert.doesNotMatch(render(snap, { iso, profile, review, param: id }), forbidden, `${name} ${iso} detail`);
    }
  }
});

// --- CSS colour roles and scope -------------------------------------------------------------------------

function ruleBody(css, selector) {
  const out = [];
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (sel.split(',').map((x) => x.trim().replace(/\s+/g, ' ')).includes(selector)) out.push(body);
  }
  return out.join('\n');
}
const components = strip(read('assets/css/components.css'));
const screens = strip(read('assets/css/screens.css'));

test('colour roles: copper for identity (arrow, aircraft mark, milestone glyph, relative), route blue for the rail', () => {
  assert.match(ruleBody(components, '.rh-arrow'), /color:\s*var\(--accent\)/);
  assert.match(ruleBody(components, '.sc-mark'), /color:\s*var\(--accent\)/);
  assert.match(ruleBody(components, '.sc-mark'), /background:\s*var\(--fill-selected\)/);
  assert.match(ruleBody(components, '.ms-icon'), /color:\s*var\(--accent\)/);
  assert.match(ruleBody(components, '.ms-rel'), /color:\s*var\(--accent\)/);
  assert.match(ruleBody(components, '.t-airport'), /font-weight:\s*var\(--weight-bold\)/);
  assert.match(ruleBody(screens, '.jr-leg::before'), /background:\s*var\(--jr-flight\)/);
  assert.match(ruleBody(screens, '.fl-rot'), /--jr-flight:\s*var\(--mark-flight\)/);
  assert.match(ruleBody(screens, '.jr-sector.is-selected .jr-node'), /var\(--accent\)/);
  assert.match(ruleBody(screens, '.jr-sector.is-active .jr-node'), /var\(--route\)/);
  assert.doesNotMatch(ruleBody(screens, '.jr-sector.is-active .jr-node'), /var\(--accent\)/);
  assert.match(ruleBody(screens, '.jr-link'), /border-radius:\s*var\(--radius-row\)/);
  assert.match(ruleBody(screens, '.jr-link'), /background:\s*var\(--glass-strong\)/);
  // Rail ring tokens come from tokens.css section 9; no `transition: all` in the new rules.
  assert.doesNotMatch(components + screens, /transition:\s*all/);
});

test('route hero sizes come from text tokens (hero clamp 36 → 44, title 28, inline headline)', () => {
  const tokens = strip(read('assets/css/tokens.css'));
  assert.match(tokens, /--text-route-hero:\s*clamp\(2\.25rem,\s*1\.7rem \+ 2\.4vw,\s*2\.75rem\)/);
  assert.match(tokens, /--text-route-title:\s*1\.75rem/);
  assert.match(ruleBody(components, '.rh-hero'), /font-size:\s*var\(--text-route-hero\)/);
  assert.match(ruleBody(components, '.rh-title'), /font-size:\s*var\(--text-route-title\)/);
  assert.match(ruleBody(components, '.rh-inline'), /font-size:\s*var\(--text-headline\)/);
});

// --- Step 6B: Today, Calendar day detail, Radar ------------------------------------------------------------

const ISO_NOW = '2026-10-04T08:00:00Z';
const STATES = ['off', 'flight', 'layover', 'standby', 'reserve', 'unknown'];

function sampleView(state, iso = ISO_NOW) {
  const snapshot = sampleSnapshot(state, 'ocean', at(iso), SP);
  const v = pipeline(snapshot, iso, SP);
  return { ...v, profile: SP, snapshot, review: true, loading: false, error: null, warnings: [], toneOverride: 'ocean', mode: { kind: 'sample' } };
}
const renderToday = (state, iso) => today.render({ view: () => sampleView(state, iso), weather: () => null }).toString();
function renderCalendar(view, selected = null, month = null) {
  resetCalendarUi(month, selected);
  return calendar.render({ view: () => view }).toString();
}
const RADAR_NOW = Date.parse('2026-10-06T20:00:00Z');
function renderRadar() {
  resetRadarUi();
  const snapshot = sampleSnapshot('standby', 'ocean', RADAR_NOW, SP);
  const view = { profile: SP, now: RADAR_NOW, snapshot, review: true, loading: false, error: null };
  return radar.render({ view: () => view, param: () => null, departuresAccess: () => 'ready', loadDepartures: () => { throw new Error('no network'); }, rerender() {} }).toString();
}
/** Every day of the sample month, so the sweep sees each kind of day detail. */
function calendarSweep(state) {
  const view = sampleView(state);
  const base = new Date(Date.parse(ISO_NOW));
  const out = [];
  for (let d = -6; d <= 8; d += 1) {
    const date = new Date(base.getTime() + d * 86400000).toISOString().slice(0, 10);
    out.push(renderCalendar(view, date, date.slice(0, 7)));
  }
  return out;
}

test('Step 6 scope: Today uses routeHero, Calendar uses sectorCard, Radar uses statusChip (and nothing else from flight-parts)', () => {
  const imports = { today: ['routeHero'], calendar: ['sectorCard'], radar: ['statusChip'] };
  for (const [file, names] of Object.entries(imports)) {
    const src = read(`src/ui/screens/${file}.js`);
    const m = src.match(/import \{([^}]*)\} from '\.\.\/flight-parts\.js'/);
    assert.ok(m, `${file}.js imports flight-parts`);
    assert.deepEqual(m[1].split(',').map((x) => x.trim()), names, `${file}.js`);
    assert.doesNotMatch(src, /milestoneRow|milestoneList/, `${file}.js`);
  }
});

test('Today: flight hero is a route hero inside h2#status-title with the same codes as before; lede kept', () => {
  const out = renderToday('flight');
  const h2 = out.match(/<h2 class="pass-state t-display" id="status-title">([\s\S]*?)<\/h2>/)[1];
  assert.match(h2, /^<span class="route-hero rh-hero">/);
  const codes = [...h2.matchAll(/class="rh-code t-airport">([A-Z]+)</g)].map((m) => m[1]);
  assert.deepEqual(codes, ['HOME', 'AWAY', 'HOME']);
  assert.doesNotMatch(h2, /rh-city/, 'the flight hero carries no city line (the lede does)');
  assert.match(out, /<p class="pass-lede">[^<]+ to [^<]+<\/p>/);
});

test('Today: layover hero puts the airport code first and the city under it; local-time lede unchanged', () => {
  const out = renderToday('layover');
  const h2 = out.match(/<h2 class="pass-state t-display" id="status-title">([\s\S]*?)<\/h2>/)[1];
  // The visual hero is aria-hidden; the heading's accessible name stays the city name (as before Step 6).
  assert.match(h2, /^<span aria-hidden="true"><span class="route-hero rh-hero"><span class="rh-stop"><span class="rh-code t-airport">AWAY<\/span>/);
  assert.match(h2, /<span class="visually-hidden">AWAY<\/span>$/);
  assert.equal([...h2.matchAll(/class="rh-code/g)].length, 1, 'one code, no arrows');
  assert.doesNotMatch(h2, /rh-arrow/);
  assert.match(out, /<p class="pass-lede">AWAY · local time <span data-clock-tz="[^"]*">[^<]*<\/span>/);
  // A city that is only the code again would repeat it: no city line then.
  const noCity = routeHero({ codes: ['ZZZ'], cities: undefined, size: 'hero', as: 'span' }).toString();
  assert.doesNotMatch(noCity, /rh-city/);
});

test('Today: other states keep their wording and markup (plain text title, no route hero)', () => {
  for (const state of ['off', 'standby', 'reserve', 'unknown']) {
    const out = renderToday(state);
    const h2 = out.match(/<h2 class="pass-state t-display" id="status-title">([\s\S]*?)<\/h2>/)[1];
    assert.doesNotMatch(h2, /route-hero|<span/, state);
  }
  assert.match(renderToday('standby'), /id="status-title">Standby<\/h2>/);
  assert.match(renderToday('reserve'), /id="status-title">Reserve<\/h2>/);
  assert.match(renderToday('off'), /id="status-title">Off<\/h2>/);
});

test('Today fields: icons on wake-up, pickup, departure, arrival only; order, values and alarm links unchanged', () => {
  const out = renderToday('flight');
  const fields = out.slice(out.indexOf('class="pass-fields"'), out.indexOf('</dl>', out.indexOf('class="pass-fields"')));
  const labels = [...fields.matchAll(/<dt class="t-eyebrow">([\s\S]*?)<\/dt>/g)].map((m) => m[1].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim());
  assert.deepEqual(labels, ['Wake-up', 'Pickup', 'Departure', 'Arrival', 'Block', 'Flight']);
  const iconed = [...fields.matchAll(/<dt class="t-eyebrow"><span class="pf-icon" aria-hidden="true"><svg[\s\S]*?<\/svg><\/span>([^<]+)<\/dt>/g)].map((m) => m[1]);
  assert.deepEqual(iconed, ['Wake-up', 'Pickup', 'Departure', 'Arrival']);
  assert.match(fields, /<dt class="t-eyebrow">Block<\/dt>/);
  assert.match(fields, /<dt class="t-eyebrow">Flight<\/dt>/);
  assert.equal([...fields.matchAll(/class="pass-alarm"/g)].length, 2);
  const css = components;
  assert.match(ruleBody(css, '.pf-icon'), /color:\s*var\(--accent\)/);
  assert.match(ruleBody(css, '.pf-icon svg'), /width:\s*14px;\s*height:\s*14px/);
});

test('Today countdown is brand copper, and brand has >= 4.5:1 on every state atmosphere (atmos-1..3, light and dark)', () => {
  assert.match(ruleBody(components, '.pass-countdown'), /color:\s*var\(--accent\)/);
  const tokens = read('assets/css/tokens.css');
  const lum = (h) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const sec6 = tokens.slice(tokens.search(/\/\*\s*6\.\s*Flight Control brand foundation/));
  const brand = sec6.match(/--brand:\s*light-dark\(\s*(#[0-9A-Fa-f]{6})\s*,\s*(#[0-9A-Fa-f]{6})\s*\)/);
  assert.ok(brand, '--brand in section 6');
  const sec3 = tokens.slice(tokens.search(/\/\*\s*3\.\s*Operational state atmospheres/), tokens.search(/\/\*\s*4\./));
  const atmos = [...sec3.matchAll(/--st-atmos-([123]):\s*light-dark\(\s*(#[0-9A-Fa-f]{6})\s*,\s*(#[0-9A-Fa-f]{6})\s*\)/g)];
  assert.ok(atmos.length >= 24, `parsed ${atmos.length} atmosphere tokens`);
  const min = { light: Infinity, dark: Infinity };
  for (const [, n, light, dark] of atmos) {
    min.light = Math.min(min.light, ratio(brand[1], light));
    min.dark = Math.min(min.dark, ratio(brand[2], dark));
    assert.ok(ratio(brand[1], light) >= 4.5, `brand on atmos-${n} ${light} (light)`);
    assert.ok(ratio(brand[2], dark) >= 4.5, `brand on atmos-${n} ${dark} (dark)`);
  }
  assert.ok(min.light >= 4.5 && min.dark >= 4.5);
});

test('sectorCard with href null: a static div with the same content, no link, no aria-current, no chevron', () => {
  const { first, second } = entries();
  const card = sectorCard({ sector: second.sector, entry: second, selected: true, href: null, compact: true }).toString();
  assert.match(card, /^<div class="jr-link sc-compact is-static" data-sector="[^"]+">/);
  assert.doesNotMatch(card, /<a[\s>]|href=|aria-current|jr-chev|jr-node/);
  assert.doesNotMatch(card.slice(0, card.indexOf('>')), /aria-label|role=/, 'a div with no role takes no accessible name');
  assert.match(card, /<span class="sc-mark" aria-hidden="true">/);
  assert.match(card, /<b>YYZ<\/b> 18:30/);
  assert.match(card, /<b>FRA<\/b> 08:00<sup class="pass-shift" aria-label="plus 1 day">\+1<\/sup>/);
  assert.match(card, /<span class="t-code">DE2075<\/span>/);
  assert.match(card, /<span class="jr-main">/, 'the visible text is not hidden from assistive tech without a link label');
  assert.match(sectorCard({ sector: first.sector, entry: first, href: '#/flights/x' }).toString(), /^<a class="jr-link"/);
});

test('Calendar day detail: each sector is a static compact sector card; flight, date, route, times, +day and block kept', () => {
  const fx = fixtureSnapshot();
  const view = { ...pipeline(fx, ISO_NOW), profile: PROFILE, snapshot: fx, review: false, loading: false, error: null };
  const out = renderCalendar(view, '2026-10-10', '2026-10');
  const list = out.slice(out.indexOf('<ol class="cal-sectors"'), out.indexOf('</ol>', out.indexOf('<ol class="cal-sectors"')));
  assert.match(list, /<li class="cal-sector">/);
  assert.match(list, /<div class="jr-link sc-compact is-static" data-sector=/);
  assert.match(list, /class="sc-mark" aria-hidden="true"/);
  assert.match(list, /t-code">DE2074</);
  assert.match(list, /<b>FRA<\/b> 09:40/);
  assert.match(list, /<b>YYZ<\/b> 12:20/);
  assert.match(list, /9h 40m|[0-9]+h [0-9]+m/);
  assert.doesNotMatch(list, /<a[\s>]|aria-current|href=|jr-chev|jr-node/, 'sector rows are not links');
  const ret = renderCalendar(view, '2026-10-13', '2026-10');
  const retList = ret.slice(ret.indexOf('<ol class="cal-sectors"'), ret.indexOf('</ol>', ret.indexOf('<ol class="cal-sectors"')));
  assert.match(retList, /<b>FRA<\/b> 08:00<sup class="pass-shift" aria-label="plus 1 day">\+1<\/sup>/);
  assert.match(retList, /DE2075/);
  assert.match(retList, /cal-sector-date t-caption">[^<]+<\/span>/, 'the return left on another local date: that date stays visible');
});

test('Calendar month grid carries no sector card or sector mark; summaries and key are not sector cards', () => {
  const fx = fixtureSnapshot();
  const view = { ...pipeline(fx, ISO_NOW), profile: PROFILE, snapshot: fx, review: false, loading: false, error: null };
  const out = renderCalendar(view, '2026-10-10', '2026-10');
  const main = out.slice(out.indexOf('<section class="cal-main"'), out.indexOf('<aside class="cal-side"'));
  assert.ok(main.includes('class="cal-day'), 'the grid is there');
  assert.doesNotMatch(main, /sc-mark|jr-link|sc-compact|route-hero|chip-status|pf-icon/);
  const aside = out.slice(out.indexOf('<aside class="cal-side"'));
  const afterDetail = aside.slice(aside.indexOf('</article>'));
  assert.doesNotMatch(afterDetail, /sc-mark|jr-link|route-hero/);
});

test('Calendar sector rows are never links (no <a>, no aria-current) in any sampled state and day', () => {
  for (const state of STATES) {
    for (const out of calendarSweep(state)) {
      for (const list of out.matchAll(/<ol class="cal-sectors"[\s\S]*?<\/ol>/g)) {
        assert.doesNotMatch(list[0], /<a[\s>]|aria-current|href=/, state);
      }
    }
  }
});

test('Radar: destination code in airport style after a copper arrow; flight number stays t-code; chips are statusChip', () => {
  const out = renderRadar();
  assert.match(out, /<span class="rd-arrow" aria-hidden="true">→<\/span><span class="rd-iata t-airport">EAST<\/span>/);
  assert.match(out, /<span class="rd-flight t-code">SAMPLE 10\d<\/span>/);
  assert.match(out, /<span class="rd-chip is-departed"><span class="chip-status" >Departed<\/span><\/span>/);
  assert.match(out, /<span class="rd-chip is-cancelled"><span class="chip-status" data-status="critical">Cancelled<\/span><\/span>/);
  assert.match(out, /rd-rev t-tabular">[\s\S]*?→ \d\d:\d\d · \+25 min/, 'delay text kept');
  assert.match(ruleBody(screens, '.rd-arrow'), /color:\s*var\(--accent\)/);
});

test('Radar chips show only the words Departed and Cancelled', () => {
  const words = new Set([...renderRadar().matchAll(/<span class="chip-status"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]));
  assert.ok(words.size > 0);
  for (const w of words) assert.ok(['Departed', 'Cancelled'].includes(w), `unexpected chip word: ${w}`);
});

test('truthfulness: Today, Calendar and Radar never show on-time, gate, stand or boarding wording', () => {
  const forbidden = />[^<]*\b(on[\s-]?time|gate|stand|boarding)\b[^<]*</i;
  const outputs = [['radar', renderRadar()]];
  for (const state of STATES) {
    for (const iso of [ISO_NOW, '2026-10-04T14:00:00Z', '2026-10-05T03:00:00Z']) outputs.push([`today ${state} ${iso}`, renderToday(state, iso)]);
    calendarSweep(state).forEach((o, i) => outputs.push([`calendar ${state} ${i}`, o]));
  }
  const fx = fixtureSnapshot();
  for (const iso of [NOW, '2026-10-10T14:00:00Z']) {
    const view = { ...pipeline(fx, iso), profile: PROFILE, snapshot: fx, review: false, loading: false, error: null };
    outputs.push([`today fixture ${iso}`, today.render({ view: () => view, weather: () => null }).toString()]);
    outputs.push([`calendar fixture ${iso}`, renderCalendar(view, '2026-10-10', '2026-10')]);
  }
  for (const [name, out] of outputs) assert.doesNotMatch(out, forbidden, name);
  // Alt-text and labels too: the same words must not hide in attributes.
  for (const [name, out] of outputs) assert.doesNotMatch(out, /(?:aria-label|title)="[^"]*\b(on[\s-]?time|gate|stand|boarding)\b/i, `${name} attributes`);
});

test('polish: the milestone note spans label..rel on its own row; takeoff/landing aircraft reads at 18px', () => {
  assert.match(ruleBody(components, '.ms-text'), /display:\s*contents/);
  assert.match(ruleBody(components, '.ms-note'), /grid-column:\s*3\s*\/\s*-1/);
  assert.match(ruleBody(components, '.ms-note'), /grid-row:\s*2/);
  assert.match(ruleBody(components, '.ms-rel'), /grid-row:\s*1/);
  for (const name of ['takeoff', 'landing']) {
    const svg = icon(name).toString();
    const scale = Number(svg.match(/scale\(([\d.]+)\)/)[1]);
    assert.ok(scale >= 1.0 && scale <= 1.1, `${name} aircraft scale ${scale} fills about 70% of the box`);
    assert.match(svg, /<path d="M3\.5 20\.5h17"\/>/, `${name} keeps its runway line`);
  }
});

test('static (non-selected) sector cards never wear the copper selection fill', () => {
  for (const [css, sel] of [[screens, '.cal-sector .jr-link'], [components, '.jr-link.is-static']]) {
    const body = ruleBody(css, sel);
    assert.ok(!/--fill-selected|--edge-selected/.test(body), `${sel} must stay neutral: copper fill/edge is reserved for selection`);
  }
});
