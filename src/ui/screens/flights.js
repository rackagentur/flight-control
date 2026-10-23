// Flights (Phase 6): where am I going, what does this rotation look like, what do I need to
// know there, and what have I flown (as far as this device has seen)?
// Order: upcoming rotations as journeys → the calm end of the listed flights → "Seen on this
// device". Detail is per sector inside its rotation (D6): route → timing → rotation →
// destination → actions. Mobile shows list or detail; desktop shows both (master/detail).
// Everything comes from the normalized model (model/flights.js); nothing is parsed here.

import { html } from '../../lib/html.js';
import { formatDate, formatDuration, localDateKey, relativeDayLabel } from '../../lib/time.js';
import { pageHeader, previewBadge } from '../components.js';
import { icon } from '../icons.js';
import { hrefFor } from '../../router.js';
import { buildFlights, defaultSector } from '../../model/flights.js';
import { horizonView } from '../horizon.js';
import { alarmLink, city, clock, field, zoneNote } from '../duty.js';
import { journeyView } from '../journey.js';
import { milestoneList, milestoneRow, relativeIn, routeHero, sectorStatus, statusChip, displayShift } from '../flight-parts.js';
import { opDate, tzModeChip, tzTag } from '../../lib/op-time.js';
import { destinationView } from '../destination.js';
import { focusCalendar } from './calendar.js';
import { flightOpsView, flightOpsState, refreshFlightOps, setFlightOpsMounted } from '../flight-ops.js';
import { crewSection, mountCrewSection } from '../crew-section.js';

// Session UI state (not persisted).
const ui = { lastParam: undefined, returnTo: null, opsEntry: null };

const monthName = (key) => new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.parse(`${key}-15T12:00:00Z`));

function routeTitle(codes) {
  return html`${codes.map((c, i) => html`${i ? html`<span class="fl-arrow" aria-hidden="true"> → </span>` : ''}<span>${c}</span>`)}`;
}

/** Local dates, like every other date in Flights: departure at its origin, return at its destination (UTC when unknown). */
function rotationDates(r) {
  const first = r.sectors[0].sector;
  const last = r.sectors.at(-1).sector;
  const fromTz = first.originTz ?? 'UTC';
  const toTz = last.destTz ?? 'UTC';
  const a = formatDate(first.dep, fromTz);
  const b = formatDate(last.arr, toTz);
  return localDateKey(first.dep, fromTz) === localDateKey(last.arr, toTz) ? a : `${a} – ${b}`;
}

function rotationEyebrow(r, i, now, tz) {
  if (r.status === 'active') return 'Now · this rotation';
  const when = relativeDayLabel(now, r.firstDep, tz);
  return i === 0 ? `Next rotation · ${when}` : when;
}

function rotationView(r, i, view, selectedId, weatherFor) {
  const { profile, now } = view;
  const tz = profile.homeTz;
  const meta = [
    rotationDates(r),
    r.days > 1 ? `${r.days} days` : null,
    `${r.sectorCount} ${r.sectorCount === 1 ? 'sector' : 'sectors'}`,
    `${formatDuration(r.blockMin)} block`,
  ].filter(Boolean).join(' · ');
  const lead = i === 0;
  return html`
    <article class="fl-rot ${lead ? 'is-lead' : ''}" aria-labelledby="fl-rot-${i}">
      <header class="fl-rot-head">
        <p class="t-eyebrow">${rotationEyebrow(r, i, now, tz)}${tzModeChip()}</p>
        <h3 class="fl-rot-route ${lead ? 't-title-2' : 't-headline'}" id="fl-rot-${i}"><span class="visually-hidden">Rotation </span>${routeHero({ codes: r.route, size: lead ? 'title' : 'inline', as: 'span' })}</h3>
        <p class="fl-rot-meta t-tabular">${meta}</p>
      </header>
      ${lead && r.horizon ? horizonView(r.horizon, { variant: 'compact' }) : ''}
      ${journeyView(r, { selectedId, homeTz: tz, weatherFor })}
    </article>`;
}

/** The end of the listed flights: a calm statement, never an error. */
function boundaryView(b, tz) {
  const through = b.through ? formatDate(Date.parse(`${b.through}T12:00:00Z`), 'UTC') : null;
  if (b.kind === 'missing') {
    return html`
      <div class="fl-boundary" role="note">
        <span class="fl-boundary-mark" aria-hidden="true"></span>
        <div>
          <p class="fl-boundary-title">No flight list in the last update</p>
          <p class="t-caption t-secondary">Your roster source did not send its flight list this time, so upcoming flights are unknown. Nothing is filled in.</p>
        </div>
      </div>`;
  }
  if (b.kind === 'truncated') {
    return html`
      <div class="fl-boundary" role="note">
        <span class="fl-boundary-mark" aria-hidden="true"></span>
        <div>
          <p class="fl-boundary-title">End of the listed flights</p>
          <p class="t-caption t-secondary">${b.limit ? `Your roster source shares its next ${b.limit} flights at a time.` : 'Your roster source shares only part of your upcoming flights.'} Later flights appear here as these are flown${through ? `; nothing after ${through} is known yet` : ''}.</p>
        </div>
      </div>`;
  }
  return html`
    <div class="fl-boundary" role="note">
      <span class="fl-boundary-mark" aria-hidden="true"></span>
      <div>
        <p class="fl-boundary-title">${b.empty ? 'No upcoming flights listed' : 'End of the listed flights'}</p>
        <p class="t-caption t-secondary">${through ? `Your roster source lists flights through ${through}.` : 'Your roster source lists no further flights.'}${b.empty ? ' Days without a listed flight are not proof of time off.' : ''}</p>
      </div>
    </div>`;
}

function recentView(recent, view, selectedId) {
  const tz = view.profile.homeTz;
  const server = view.snapshot?.historySource === 'roster-calendar';
  const since = recent.since ? formatDate(recent.since, tz) : null;
  return html`
    <section class="fl-recent" aria-labelledby="fl-recent-title" id="fl-recent">
      <div class="section-head"><h2 class="t-eyebrow" id="fl-recent-title">${server ? 'Flight history' : 'Seen on this device'}</h2></div>
      <p class="t-caption t-secondary fl-recent-intro">${server
        ? 'Flights from your roster calendar (synced copy), up to 13 months back, plus flights this device saw. Not a complete career history.'
        : `Flights this device saw in earlier roster syncs, kept for ${recent.keepDays} days. Not a complete flight history.`}${recent.count ? ` ${recent.count} ${recent.count === 1 ? 'flight' : 'flights'} since ${since}.` : ''}</p>
      ${recent.count ? recent.months.map((m) => html`
        <h3 class="fl-recent-month t-caption">${monthName(m.month)}</h3>
        <ul class="fl-recent-list" role="list">
          ${m.rotations.map((r) => {
            const first = r.sectors[0].sector;
            const remembered = r.provenance !== 'source';
            const fromRoster = r.sectors.every((e) => e.sector.historySource === 'roster-calendar');
            const selected = r.sectors.some((e) => e.sector.id === selectedId);
            return html`
              <li>
                <a class="fl-recent-row ${selected ? 'is-selected' : ''}" href="${hrefFor('flights', first.id)}" data-sector="${first.id}" ${selected ? html`aria-current="true"` : ''}>
                  <span class="fl-recent-date t-tabular">${rotationDates(r)}</span>
                  <span class="fl-recent-route">${routeTitle(r.route)}</span>
                  <span class="fl-recent-sub t-caption">${r.sectors.map((e) => e.sector.flightNumber).join(' · ')}</span>
                  <span class="fl-tag ${remembered ? 'tag-remembered' : 'tag-source'}">${!remembered ? 'Current roster' : fromRoster ? 'Roster history' : 'Remembered'}</span>
                </a>
              </li>`;
          })}
        </ul>`) : html`<p class="fl-recent-empty t-callout t-secondary">No earlier flights seen on this device yet. Flights listed by your roster source appear here once flown, for ${recent.keepDays} days.</p>`}
    </section>`;
}

function provenancePill(e) {
  if (e.sector.provenance === 'history') {
    return e.sector.historySource === 'roster-calendar'
      ? html`<span class="status-pill" data-confidence="remembered">From your roster history</span>`
      : html`<span class="status-pill" data-confidence="remembered">Remembered on this device</span>`;
  }
  return html`<span class="status-pill" data-confidence="confirmed">Current roster</span>`;
}

function timingView(e, view) {
  const { profile, now, review } = view;
  const s = e.sector;
  const dayMark = displayShift(e, s);
  const shift = dayMark ? html`<sup class="pass-shift">${dayMark > 0 ? `+${dayMark}` : dayMark}</sup>` : '';
  const tag = tzTag(s.dep, s.originTz, s.arr, s.destTz);
  const arrTag = tag ? html` <span class="tz-tag">${tag}</span>` : '';
  const upcoming = e.status === 'upcoming';
  const alarm = (ms, label) => (upcoming && !review ? alarmLink(profile, ms, s.originTz, label) : clock(ms, s.originTz));
  const zone = (ms, tz) => (zoneNote(ms, tz, profile) ? html` · ${zoneNote(ms, tz, profile)}` : '');
  // Milestones in the order they happen. "in …" only for events still ahead of now.
  const rows = [
    e.wakeup !== null ? { icon: 'bell', time: alarm(e.wakeup, 'wake-up'), label: 'Wake-up', relative: relativeIn(now, e.wakeup) } : null,
    e.pickup !== null ? { icon: 'car', time: alarm(e.pickup, 'pickup'), label: 'Pickup', relative: relativeIn(now, e.pickup) } : null,
    { icon: 'takeoff', time: clock(s.dep, s.originTz), label: 'Departure', relative: relativeIn(now, s.dep),
      note: html`${city(s.origin)} · ${opDate(s.dep, s.originTz)}${zone(s.dep, s.originTz)}` },
    { icon: 'landing', time: html`${clock(s.arr, s.destTz)}${shift}${arrTag}`, label: 'Arrival', relative: relativeIn(now, s.arr),
      note: html`${city(s.destination)} · ${opDate(s.arr, s.destTz)}${zone(s.arr, s.destTz)}` },
  ].filter(Boolean);
  const next = rows.find((row) => row.relative);
  return html`
    <section class="fl-section" aria-labelledby="fl-timing">
      <p class="t-eyebrow" id="fl-timing">Timing${tzModeChip()}</p>
      ${milestoneList(rows.map((row) => milestoneRow({ ...row, emphasis: row === next })))}
      <dl class="pass-fields fl-fields fl-facts">
        ${field('Block', formatDuration(s.blockMin))}
        ${s.aircraft ? field('Aircraft', s.aircraft.typeCode, s.aircraft.registration ?? null) : ''}
      </dl>
      ${e.firstOfDuty && e.pickup === null && upcoming ? html`<p class="t-caption t-secondary">No pickup listed for this duty by your roster source.</p>` : ''}
    </section>`;
}

function rotationSection(e, view, weatherFor) {
  const r = e.journey;
  return html`
    <section class="fl-section" aria-labelledby="fl-rotation">
      <p class="t-eyebrow" id="fl-rotation">Rotation · day ${e.day} of ${r.days}</p>
      <p class="t-headline">${routeTitle(r.route)}</p>
      ${r.openStart || r.openEnd || r.gapEnd ? html`<p class="t-caption t-secondary">${r.openStart ? 'Starts before the data this device has. ' : ''}${r.openEnd ? 'Return not yet listed by your roster source.' : ''}${r.gapEnd ? 'No return to base is seen in this rotation.' : ''}</p>` : ''}
      ${r.horizon ? horizonView(r.horizon, { variant: 'compact' }) : ''}
      <ol class="fl-mini" role="list">
        ${r.sectors.map((x) => html`
          <li><a class="fl-mini-row ${x.sector.id === e.sector.id ? 'is-current' : ''}" href="${hrefFor('flights', x.sector.id)}" data-sector="${x.sector.id}" ${x.sector.id === e.sector.id ? html`aria-current="true"` : ''}>
            <span class="t-code">${x.sector.flightNumber}</span>
            <span class="t-tabular">${x.sector.origin} → ${x.sector.destination}</span>
            <span class="t-caption t-secondary t-tabular">${formatDate(x.sector.dep, x.sector.originTz ?? 'UTC')}</span>
          </a></li>`)}
      </ol>
    </section>`;
}

/** City under an airport code; null when only the code is known (no repeated code). */
const cityName = (iata) => (city(iata) !== iata ? city(iata) : null);

function detailView(e, view, weatherFor, { explicit, ops = null, crew = '' }) {
  if (!e) return html`<div class="fl-detail-empty"><p class="t-callout t-secondary">Select a flight to see its details.</p></div>`;
  const { profile, now } = view;
  const s = e.sector;
  const tz = profile.homeTz;
  const status = sectorStatus(e, s);
  const when = relativeDayLabel(now, s.dep, tz);
  const seen = s.provenance === 'history' && s.historySource !== 'roster-calendar' && Number.isFinite(s.seenAt) ? `Last seen in your roster ${formatDate(s.seenAt, tz)}` : null;
  return html`
    <article class="fl-detail-card" aria-labelledby="fl-detail-title" data-fl-detail>
      ${explicit ? html`<a class="fl-back" href="${hrefFor('flights')}" data-fl-back><span aria-hidden="true">‹ </span>Flights</a>` : ''}
      <header class="fl-detail-head">
        <p class="t-eyebrow">${formatDate(s.dep, s.originTz ?? 'UTC')} · Flight ${e.index + 1} of ${e.count} in this rotation</p>
        <h2 class="t-title-2 fl-detail-route" id="fl-detail-title" tabindex="-1">${routeHero({ codes: [s.origin, s.destination], cities: [cityName(s.origin), cityName(s.destination)], size: 'hero', as: 'span' })}</h2>
        <p class="t-callout"><span class="t-code">${s.flightNumber}</span></p>
        <p class="cal-detail-meta">${provenancePill(e)}${status ? statusChip(status) : ''}<span class="t-caption t-secondary">${[status ? null : when, seen].filter(Boolean).join(' · ')}</span></p>
      </header>
      ${timingView(e, view)}
      ${flightOpsView(ops, s, view)}${crew}
      ${rotationSection(e, view, weatherFor)}
      ${e.destination ? html`<div class="fl-section">${destinationView(e.destination, weatherFor(e.destination), { now, review: view.review, titleId: 'fl-dest' })}</div>` : ''}
      <p class="fl-detail-foot"><a class="dest-link" href="${hrefFor('calendar')}" data-fl-calendar="${localDateKey(s.dep, tz)}">Show this day in Calendar</a></p>
    </article>`;
}

export const flights = {
  title: 'Flights',

  render(ctx) {
    const view = ctx.view();
    const param = ctx.param?.() ?? null;
    if (!view.snapshot) {
      const needsToken = !view.loading && view.error?.code === 'auth-required';   // S6
      return html`
        <div class="page">
          ${pageHeader({ title: 'Flights', subtitle: 'Your rotations and destinations' })}
          <div class="empty">
            <div class="empty-icon">${icon('flights')}</div>
            <p class="t-headline">${view.loading ? 'Loading roster…' : needsToken ? 'Access token required' : 'No roster source connected'}</p>
            <p class="empty-text t-callout">${needsToken ? 'Your roster is only shown with the access token. Add it under Roster contract v2 in Settings.' : html`Flights shows only what your roster source provides. ${view.loading ? '' : 'Connect it in Settings.'}`}</p>
            ${view.loading ? '' : html`<a class="btn btn-quiet" href="#/settings">${needsToken ? 'Open Settings' : 'Connect roster source'}</a>`}
          </div>
        </div>`;
    }
    const f = buildFlights(view.snapshot, view.roster, view.state, view.profile, view.now);
    const weatherFor = (dest) => (dest ? (ctx.weather ? ctx.weather(dest.weather) : { status: 'unavailable', reason: 'no-destination' }) : null);
    const explicit = Boolean(param && f.sectors.has(param));
    const selectedId = explicit ? param : defaultSector(f);
    const selected = selectedId ? f.sectors.get(selectedId) : null;
    // Live gates/terminals (provider data beside the roster, never instead of it); loads on demand.
    const ops = selected ? flightOpsState(ctx, selected, view) : null;
    ui.opsEntry = ops ? selected : null;
    // Crew Intelligence (Stage B2): '' unless crew is on, offered, and the sector is eligible.
    const crew = selected ? crewSection(ctx, selected, view) : '';
    return html`
      <div class="page">
        ${pageHeader({ eyebrow: view.review ? 'Sample data · not your roster' : 'Roster', title: 'Flights' })}
        ${param && !explicit ? html`<p class="t-callout t-secondary fl-missing" role="status">That flight is no longer listed. Showing your current flights.</p>` : ''}
        <div class="fl-layout ${explicit ? 'is-explicit' : ''}">
          <div class="fl-list">
            ${view.review ? html`<div class="fl-toolbar">${previewBadge('Sample · not your roster')}</div>` : ''}
            <section class="fl-upcoming" aria-labelledby="fl-upcoming-title">
              <div class="section-head"><h2 class="t-eyebrow" id="fl-upcoming-title">Upcoming</h2></div>
              ${f.upcoming.map((r, i) => rotationView(r, i, view, explicit ? selectedId : null, weatherFor))}
              ${boundaryView(f.boundary, view.profile.homeTz)}
            </section>
            ${recentView(f.recent, view, explicit ? selectedId : null)}
          </div>
          <aside class="fl-side" aria-label="Flight detail">
            ${detailView(selected, view, weatherFor, { explicit, ops, crew })}
          </aside>
        </div>
      </div>`;
  },

  mount(root, ctx) {
    const param = ctx.param?.() ?? null;
    const mobile = !window.matchMedia('(min-width: 1200px)').matches;
    const changed = ui.lastParam !== undefined && ui.lastParam !== param;
    if (changed && mobile) {
      if (param) window.scrollTo({ top: 0 });
      else if (ui.returnTo) root.querySelector(`[data-sector="${CSS.escape(ui.returnTo)}"]`)?.scrollIntoView({ block: 'center' });
    }
    if (changed && param) root.querySelector('#fl-detail-title')?.focus({ preventScroll: !mobile });
    if (param) ui.returnTo = param;
    ui.lastParam = param;
    setFlightOpsMounted(true);
    const onClick = (event) => {
      if (event.target.closest('[data-fo-refresh]')) {
        event.preventDefault();
        if (ui.opsEntry) refreshFlightOps(ctx, ui.opsEntry, ctx.view());
        return;
      }
      const cal = event.target.closest('[data-fl-calendar]');
      if (cal) {
        event.preventDefault();
        focusCalendar(cal.dataset.flCalendar.slice(0, 7), cal.dataset.flCalendar);
        location.hash = hrefFor('calendar');
      }
    };
    root.addEventListener('click', onClick);
    const stopCrew = mountCrewSection(root, ctx);
    return () => { root.removeEventListener('click', onClick); setFlightOpsMounted(false); stopCrew(); };
  },
};

/** Review hook: forget list/detail navigation memory. */
export function resetFlightsUi() {
  ui.lastParam = undefined;
  ui.returnTo = null;
}
