// Today: operational-state-first.
// Order: status → next operational event → countdown → Duty Horizon → intelligence.
// Renders only normalized data (RosterSnapshot → roster → OperationalState → horizon);
// nothing here knows about v5. Missing fields are omitted, never invented.

import { html } from '../../lib/html.js';
import { formatTime, formatUtcOffset, offsetMinutes, relativeDayLabel, countdown, formatDate, localDateKey, addDays } from '../../lib/time.js';
import { airport } from '../../data/airports.js';
import { hrefFor } from '../../router.js';
import { pageHeader, previewBadge } from '../components.js';
import { horizonView } from '../horizon.js';
import { clock, city, field, dutyFields, sectorList, routeTitle } from '../duty.js';
import { weekView } from '../week.js';
import { buildDestination } from '../../model/destination.js';
import { OFF_SUBTYPE } from '../../model/roster.js';
import { weatherText } from '../destination.js';

const CONFIDENCE_LABEL = { confirmed: 'Confirmed', inferred: 'Inferred', unknown: 'Unknown' };
const PHASE_LABEL = {
  airborne: 'Airborne', 'pre-departure': 'Flight duty', 'duty-today': 'Flight duty', turnaround: 'On the ground', 'post-duty': 'Duty complete',
  layover: 'Layover', window: null, off: 'Off', 'no-duty-reported': 'Status', 'insufficient-evidence': 'Status', 'no-source': 'Status',
};

function greeting(now, tz) {
  const hour = Number(formatTime(now, tz)?.slice(0, 2) ?? 12);
  if (hour < 5) return 'Good night';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function nextEventBlock(state, now, tz) {
  const ev = state.nextEvent;
  if (!ev) return '';
  const zone = ev.sector ? (ev.kind === 'arrival' ? ev.sector.destTz : ev.sector.originTz) : (state.duty?.sectors[0].originTz ?? tz);
  const cd = countdown(now, ev.at);
  return html`
    <div class="pass-next">
      <div class="pass-next-head">
        <span class="t-eyebrow">Next · ${ev.label}</span>
        <span class="t-caption">${relativeDayLabel(now, ev.at, zone ?? tz)} · ${clock(ev.at, zone)}</span>
      </div>
      <p class="pass-countdown t-tabular" data-countdown-to="${ev.at}" aria-live="off">${cd.past ? 'Now' : `in ${cd.label}`}</p>
    </div>`;
}

function kicker(eyebrow, state, review) {
  return html`
    <div class="pass-kicker">
      <span class="t-eyebrow">${eyebrow}</span>
      ${review ? previewBadge('Sample · not your roster') : html`<span class="status-pill" data-confidence="${state.confidence}">${CONFIDENCE_LABEL[state.confidence]}</span>`}
    </div>`;
}

function statusPass(view) {
  const { state, horizon, profile, now, review } = view;
  const tz = profile.homeTz;
  const duty = state.duty;
  const hz = horizon ? horizonView(horizon) : '';

  if (state.status === 'flight' && duty) {
    const day = state.phase === 'post-duty'
      ? (state.nextDuty ? `Next duty ${relativeDayLabel(now, state.nextDuty.sectors[0].dep, tz).toLowerCase()}` : 'No further duties visible')
      : relativeDayLabel(now, duty.sectors[0].dep, duty.sectors[0].originTz ?? tz);
    return html`
      <section class="pass" aria-labelledby="status-title">
        <div class="pass-head">
          ${kicker(`${PHASE_LABEL[state.phase] ?? 'Flight'} · ${day}`, state, review)}
          <h2 class="pass-state t-display" id="status-title">${routeTitle(duty)}</h2>
          <p class="pass-lede">${city(duty.sectors[0].origin)} to ${city(duty.sectors.at(-1).destination)}</p>
        </div>
        ${nextEventBlock(state, now, tz)}
        <dl class="pass-fields">${dutyFields(duty, profile)}</dl>
        ${sectorList(duty)}
        ${hz}
      </section>`;
  }

  if (state.status === 'layover') {
    const here = state.location;
    const tzHere = airport(here)?.tz ?? null;
    return html`
      <section class="pass" aria-labelledby="status-title">
        <div class="pass-head">
          ${kicker('Layover · derived from your itinerary', state, review)}
          <h2 class="pass-state t-display" id="status-title">${city(here)}</h2>
          <p class="pass-lede">${here} · local time <span data-clock-tz="${tzHere ?? ''}">${tzHere ? formatTime(now, tzHere) : '—'}</span>${tzHere ? ` (${formatUtcOffset(now, tzHere)})` : ''}</p>
        </div>
        ${nextEventBlock(state, now, tz)}
        ${duty ? html`<dl class="pass-fields">${dutyFields(duty, profile)}</dl>` : ''}
        ${hz}
      </section>`;
  }

  if (state.status === 'standby' || state.status === 'reserve') {
    const w = state.window;
    const word = state.status === 'standby' ? 'Standby' : 'Reserve';
    return html`
      <section class="pass" aria-labelledby="status-title">
        <div class="pass-head">
          ${kicker(`${word} · armed`, state, review)}
          <h2 class="pass-state t-display" id="status-title">${word}</h2>
          <p class="pass-lede">Window ${clock(w.start, tz)} – ${clock(w.end, tz)}</p>
        </div>
        ${nextEventBlock(state, now, tz)}
        ${duty ? html`<dl class="pass-fields">
          ${field('Next known duty', routeTitle(duty), `${formatDate(duty.sectors[0].dep, duty.sectors[0].originTz ?? tz)} · ${clock(duty.sectors[0].dep, duty.sectors[0].originTz)}`)}
        </dl>` : ''}
        ${hz}
      </section>`;
  }

  if (state.status === 'off') {
    const kind = OFF_SUBTYPE[state.offSubtype];
    const ort = state.offSubtype === 'ort';
    return html`
      <section class="pass" aria-labelledby="status-title">
        <div class="pass-head">
          ${kicker(ort ? 'Protected free day' : kind && state.offSubtype !== 'off' ? kind.name : 'Off today', state, review)}
          <h2 class="pass-state t-display" id="status-title">${ort ? 'ORT' : state.offSubtype === 'leave' ? 'Leave' : 'Off'}</h2>
          ${ort ? html`<p class="pass-lede">Assigned by the company; it cannot be taken away or reassigned.</p>` : ''}
          ${duty ? html`<p class="pass-lede">Next duty ${routeTitle(duty)} · ${relativeDayLabel(now, duty.sectors[0].dep, tz)}</p>` : ''}
        </div>
        ${nextEventBlock(state, now, tz)}
        ${duty ? html`<dl class="pass-fields">${dutyFields(duty, profile)}</dl>` : ''}
        ${hz}
      </section>`;
  }

  // UNKNOWN: say why, and still show what is known about the next duty.
  const noSource = state.phase === 'no-source';
  const needsToken = noSource && !view.snapshot && view.error?.code === 'auth-required';   // S6
  return html`
    <section class="pass" aria-labelledby="status-title">
      <div class="pass-head">
        ${kicker('Operational status', state, review)}
        <h2 class="pass-state t-display" id="status-title">${needsToken ? 'Access token required' : noSource ? 'Not yet known' : 'Status unknown'}</h2>
        <p class="pass-lede">${needsToken ? 'Your roster is only shown with the access token. Add it under Roster contract v2 in Settings.' : state.reasons[0] ?? ''}</p>
        ${noSource && !review ? html`<p><a class="btn btn-quiet" href="${hrefFor('settings')}">${needsToken ? 'Open Settings' : 'Connect roster source'}</a></p>` : ''}
      </div>
      ${duty ? html`
        ${nextEventBlock(state, now, tz)}
        <dl class="pass-fields">
          ${field('Next known duty', routeTitle(duty), `${formatDate(duty.sectors[0].dep, duty.sectors[0].originTz ?? tz)} · ${duty.sectors.map((s) => s.flightNumber).join(' · ')}`)}
          ${dutyFields(duty, profile)}
        </dl>` : ''}
      ${hz}
    </section>`;
}

function loadingPass(view) {
  return html`
    <section class="pass is-loading" aria-busy="true" aria-labelledby="status-title">
      <div class="pass-head">
        ${kicker('Operational status', { confidence: 'unknown' }, view.review)}
        <h2 class="pass-state t-display" id="status-title">Loading roster…</h2>
      </div>
    </section>`;
}

// --- Intelligence rail ------------------------------------------------------------------

function relevantOutstation(view) {
  const { state, profile } = view;
  if (state.location && !profile.homeBases.includes(state.location)) return state.location;
  const dest = state.duty?.sectors[0]?.destination;
  return dest && !profile.homeBases.includes(dest) ? dest : null;
}

function clocksSection(view) {
  const { profile, now } = view;
  const other = relevantOutstation(view);
  const otherTz = other ? airport(other)?.tz : null;
  const row = (label, tz) => html`
    <div class="intel-row">
      <span class="intel-label">${label}</span>
      <span class="intel-value intel-clock"><span class="t-tabular" data-clock-tz="${tz}">${formatTime(now, tz)}</span> · ${formatUtcOffset(now, tz)}</span>
    </div>`;
  return html`
    <section class="section">
      <div class="section-head"><h2 class="t-eyebrow">Local time</h2></div>
      <div class="intel">
        ${row(`Home · ${city(profile.base)}`, profile.homeTz)}
        ${otherTz && offsetMinutes(now, otherTz) !== offsetMinutes(now, profile.homeTz) ? row(`${city(other)} · ${other}`, otherTz) : ''}
      </div>
    </section>`;
}

/** Consecutive explicit free days (any rest subtype) from v2 off windows, as {start, days}. */
function explicitBlocks(snapshot, tz, todayKey) {
  const dates = [...new Set(snapshot.windows.filter((w) => w.kind === 'off')
    .map((w) => localDateKey(w.start + (w.end - w.start) / 2, tz)))].filter((d) => d >= todayKey).sort();
  const blocks = [];
  for (const d of dates) {
    const last = blocks.at(-1);
    if (last && addDays(last.start, last.days) === d) last.days += 1;
    else blocks.push({ start: d, days: 1 });
  }
  return blocks;
}

function restSection(view) {
  const { snapshot, profile, now } = view;
  if (!snapshot) return '';
  const todayKey = localDateKey(now, profile.homeTz);
  // v2 states free days explicitly (off windows); v5 lists blocks by absence.
  const blocks = snapshot.offBlocks.length ? snapshot.offBlocks.filter((b) => addDays(b.start, b.days - 1) >= todayKey).slice(0, 3)
    : explicitBlocks(snapshot, profile.homeTz, todayKey).slice(0, 3);
  const explicit = snapshot.capabilities.explicitOff;
  const db = snapshot.dutyBlock;
  return html`
    <section class="section">
      <div class="section-head"><h2 class="t-eyebrow">Rest</h2></div>
      <div class="intel">
        ${blocks.length ? blocks.map((b) => {
          const startMs = Date.parse(`${b.start}T12:00:00Z`);
          return html`<div class="intel-row"><span class="intel-label">${formatDate(startMs, 'UTC')}${b.days > 1 ? ` + ${b.days - 1}` : ''}</span><span class="intel-value">${b.days} ${b.days === 1 ? 'day' : 'days'} ${explicit ? 'off' : 'free of duty'}</span></div>`;
        }) : html`<div class="intel-row"><span class="intel-label">Free days</span><span class="intel-value">None listed</span></div>`}
        ${db ? html`<div class="intel-row"><span class="intel-label">Duty days in a row</span><span class="intel-value">${db.current} · max ${db.maxThisMonth} this month</span></div>` : ''}
      </div>
      ${blocks.length && !explicit ? html`<p class="intel-note">As listed by the roster source: no flight, standby or reserve starts on these days. Not a confirmed day off.</p>` : ''}
    </section>`;
}

function hotelSection(view) {
  if (view.review) return '';
  const iata = relevantOutstation(view);
  if (!iata || view.profile.noHotelAirports.includes(iata)) return '';
  const name = city(iata);
  const search = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`hotels in ${name}`)}`;
  return html`
    <section class="section">
      <div class="section-head"><h2 class="t-eyebrow">Hotels</h2></div>
      <div class="intel">
        <a class="intel-row intel-link" href="${search}" target="_blank" rel="noopener noreferrer"><span class="intel-label">Hotels in ${name}</span><span class="intel-value">Maps ↗</span></a>
        ${view.profile.hotelListUrl ? html`<a class="intel-row intel-link" href="${view.profile.hotelListUrl}" target="_blank" rel="noopener noreferrer"><span class="intel-label">My saved hotels</span><span class="intel-value">↗</span></a>` : ''}
      </div>
    </section>`;
}

function sourceSection(view) {
  const { snapshot, error, now } = view;
  const updated = snapshot ? Math.max(0, Math.round((now - snapshot.source.fetchedAt) / 60000)) : null;
  const warnings = view.warnings ?? [];
  return html`
    <section class="section">
      <div class="section-head"><h2 class="t-eyebrow">Source</h2></div>
      <div class="intel">
        <div class="intel-row"><span class="intel-label">${snapshot?.source.label ?? 'No roster source'}</span>
          <span class="intel-value">${snapshot ? (updated < 1 ? 'Updated just now' : `Updated ${updated} min ago`) : (error ? 'Unavailable' : 'Not connected')}</span></div>
        ${error ? html`<div class="intel-row"><span class="intel-label">Last attempt</span><span class="intel-value intel-wrap">${error.message}</span></div>` : ''}
      </div>
      ${warnings.length ? html`<ul class="intel-notes" role="list">${warnings.slice(0, 3).map((w) => html`<li>${w.message}</li>`)}</ul>` : ''}
    </section>`;
}

/** Destination weather (shared destination model, D5): the outstation that matters now. */
function weatherSection(view, weatherFor) {
  const iata = relevantOutstation(view);
  if (!iata) return '';
  const { state, profile, now } = view;
  const layover = state.layover?.airport === iata ? state.layover : null;
  const sector = state.duty?.sectors.find((s) => s.destination === iata) ?? null;
  const arrival = layover?.from ?? sector?.arr;
  if (!Number.isFinite(arrival)) return '';
  // The airport's zone as the roster knows it (any sector arriving there or leaving from there).
  const known = view.snapshot?.sectors.find((s) => s.destination === iata && s.destTz)?.destTz
    ?? view.snapshot?.sectors.find((s) => s.origin === iata && s.originTz)?.originTz;
  const dest = buildDestination({
    iata, tz: sector?.destTz ?? known ?? airport(iata)?.tz ?? null, arrival,
    stay: layover ? { kind: 'layover', confidence: layover.confidence, from: layover.from, to: layover.to } : null,
  }, profile, now);
  const weather = dest && weatherFor ? weatherFor(dest.weather) : null;
  const text = weatherText(weather, dest?.tz);
  if (!dest || !text) return '';
  const date = weather?.date ? formatDate(Date.parse(`${weather.date}T12:00:00Z`), 'UTC') : null;
  return html`
    <section class="section">
      <div class="section-head"><h2 class="t-eyebrow">Weather</h2></div>
      <div class="intel"><div class="intel-row"><span class="intel-label">${dest.city}${date ? ` · ${date}` : ''}</span><span class="intel-value">${text}${weather?.sample ? ' · sample' : ''}</span></div></div>
    </section>`;
}

function intelligence(view, weatherFor) {
  return html`
    <aside class="today-context" aria-label="Intelligence">
      ${view.roster ? html`
        <section class="section">
          <div class="section-head"><h2 class="t-eyebrow">This week</h2></div>
          ${weekView(view.roster.days, view.profile.homeTz)}
        </section>` : ''}
      ${clocksSection(view)}
      ${restSection(view)}
      ${hotelSection(view)}
      ${weatherSection(view, weatherFor)}
      ${sourceSection(view)}
    </aside>`;
}

export const today = {
  title: 'Today',

  render(ctx) {
    const view = ctx.view();
    const tz = view.profile.homeTz;
    const date = formatDate(view.now, tz, undefined) ?? '';
    return html`
      <div class="page">
        ${pageHeader({ eyebrow: date, title: `${greeting(view.now, tz)}${view.profile.name ? `, ${view.profile.name}` : ''}` })}
        <div class="today">
          <div class="today-main">${view.loading && !view.state ? loadingPass(view) : statusPass(view)}</div>
          ${intelligence(view, ctx.weather)}
        </div>
      </div>`;
  },
};
