// Calendar: the roster month. Built on the same normalized model and day classifier as Today
// (model/calendar.js → roster.buildDays), so no classification logic lives here.
// Each day: date, a status marker that never relies on colour alone (shape + text), the IATA
// code where useful, and rotation continuity drawn as a band across the days it spans.

import { html, render } from '../../lib/html.js';
import { formatDate, formatTime, localDateKey, dayShift, formatDuration } from '../../lib/time.js';
import { pageHeader, previewBadge } from '../components.js';
import { icon } from '../icons.js';
import { buildMonth, addMonths, monthKeyOf } from '../../model/calendar.js';
import { buildRotationHorizon } from '../../model/horizon.js';
import { EVIDENCE, OFF_SUBTYPE } from '../../model/roster.js';
import { horizonView } from '../horizon.js';
import { clock, city } from '../duty.js';
import { airport } from '../../data/airports.js';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const STATUS_NAME = { flight: 'Flight', layover: 'Layover', standby: 'Standby', reserve: 'Reserve', off: 'Off', unknown: 'Unknown' };
const PROVENANCE = {
  source: 'From the roster source',
  history: 'Remembered from an earlier sync on this device',
  derived: 'Derived by Flight Control from your itinerary',
  none: 'No source data',
};

// UI state survives tab switches within the session (not persisted).
const ui = { month: null, selected: null, keyOpen: null };

function noData(day) {
  return day.evidence === 'before-source' || day.evidence === 'outside-window';
}

/** Short text shown in the cell. Text, not colour, carries the meaning. */
function cellCode(day) {
  if (day.status === 'off') return OFF_SUBTYPE[day.offSubtype]?.short ?? 'OFF';
  if (day.status === 'standby') return 'SB';
  if (day.status === 'reserve') return 'RE';
  if (day.label) return day.label;
  if (day.evidence === 'duty-unspecified') return 'Duty';
  if (day.status === 'unknown' && !noData(day)) return '?';
  return '';
}

/** Desktop secondary line: the first departure, or the window times. */
function cellSub(day, tz) {
  const dep = day.sectors.find((s) => s.dep >= day.start && s.dep < day.end);
  if (dep) return `${dep.origin} ${clock(dep.dep, dep.originTz)}`;
  if (day.window && (day.status === 'standby' || day.status === 'reserve')) return `${formatTime(day.window.start, tz)}–${formatTime(day.window.end, tz)}`;
  return '';
}

function describe(day) {
  const name = day.status === 'off' && OFF_SUBTYPE[day.offSubtype] ? `${OFF_SUBTYPE[day.offSubtype].name}${day.offSubtype === 'ort' ? ' (ORT, protected)' : ''}` : STATUS_NAME[day.status];
  const conf = day.status === 'unknown' ? '' : day.confidence === 'inferred' ? ', inferred' : ', confirmed';
  const label = day.label && !(day.status === 'off' && day.offSubtype) ? ` ${day.label}` : '';
  const evidence = day.status === 'unknown' ? `: ${EVIDENCE[day.evidence] ?? 'no data'}` : day.evidence === 'duty-unspecified' ? ', duty also listed' : '';
  return `${name}${label}${conf}${evidence}`;
}

/** The one cell reachable with Tab: the selection, else today, else the first day of the month. */
function focusDate(month) {
  const inMonth = month.days.filter((d) => d.inMonth);
  if (ui.selected && month.days.some((d) => d.date === ui.selected)) return ui.selected;
  return (inMonth.find((d) => d.isToday) ?? inMonth[0]).date;
}

/** The day's token: a capsule, dot or ring that carries meaning by shape and text. */
function token(day) {
  if (day.status === 'standby') return 'tok-sb';
  if (day.status === 'reserve') return 'tok-re';
  if (day.status === 'off') return day.offSubtype === 'ort' ? 'tok-off tok-ort' : day.offSubtype === 'leave' ? 'tok-off tok-leave' : 'tok-off';
  if (day.status === 'unknown' && day.evidence === 'duty-unspecified') return 'tok-duty';
  if (day.status === 'unknown' && !noData(day)) return 'tok-unknown';
  return '';
}

function dayCell(day, month, tz) {
  const selected = day.date === ui.selected;
  const band = day.rotationPos && (day.status === 'flight' || day.status === 'layover');
  const tok = token(day);
  const classes = [
    'cal-day', `is-${day.status}`, day.evidence ? `ev-${day.evidence}` : '', day.inMonth ? '' : 'is-outside',
    day.isToday ? 'is-today' : '', selected ? 'is-selected' : '', day.confidence === 'inferred' ? 'is-inferred' : '',
    noData(day) ? 'is-nodata' : '', band ? 'has-band' : '',
  ].filter(Boolean).join(' ');
  // Journey line: one continuous stroke per rotation, with a node where it departs and where it ends.
  const bandClasses = band ? [
    'cal-band', `pos-${day.rotationPos}`, `kind-${day.status}`, day.confidence === 'inferred' ? 'is-inferred' : 'is-confirmed',
    day.column === 0 && (day.rotationPos === 'middle' || day.rotationPos === 'end') ? 'wrap-in' : '',
    day.column === 6 && (day.rotationPos === 'middle' || day.rotationPos === 'start') ? 'wrap-out' : '',
    day.rotationOpenStart ? 'open-start' : '', day.rotationOpenEnd ? 'open-end' : '',
  ].filter(Boolean).join(' ') : '';
  const dateLabel = formatDate(day.start + 12 * 3600000, tz) ?? day.date;
  return html`
    <button type="button" class="${classes}" role="gridcell" data-date="${day.date}"
      aria-selected="${selected ? 'true' : 'false'}" ${day.isToday ? html`aria-current="date"` : ''}
      tabindex="${day.date === focusDate(month) ? '0' : '-1'}"
      aria-label="${day.isToday ? 'Today, ' : ''}${dateLabel}: ${noData(day) ? 'No data' : describe(day)}">
      <span class="cal-num t-tabular" aria-hidden="true">${Number(day.date.slice(8))}</span>
      <span class="cal-track" aria-hidden="true">${band ? html`<span class="${bandClasses}"></span>` : html`<span class="cal-mark"></span>`}</span>
      <span class="cal-code ${tok}" aria-hidden="true">${cellCode(day)}</span>
      <span class="cal-sub t-tabular" aria-hidden="true">${cellSub(day, tz)}</span>
    </button>`;
}

const KEY = [
  ['key-flight', 'Flight · one line per rotation'],
  ['key-layover', 'Layover · inferred (dotted)', 'YYZ'],
  ['key-layover-roster', 'Layover · from roster (double line)', 'YYZ'],
  ['key-sb', 'Standby', 'SB'],
  ['key-re', 'Reserve', 'RE'],
  ['key-off', 'Off · stated by roster', 'OFF'],
  ['key-ort', 'ORT · protected free day', 'ORT'],
  ['key-leave', 'Leave', 'LEAVE'],
  ['key-duty', 'Duty · type not given', 'Duty'],
  ['key-unknown', 'Unknown', '?'],
  ['key-nodata', 'No data'],
];

/** Compact key behind a disclosure (opened by default on wide screens in mount()). */
function keyView() {
  return html`
    <details class="cal-key" data-cal-key>
      <summary>Key</summary>
      <ul class="cal-key-list" role="list">
        ${KEY.map(([cls, label, code]) => html`<li class="cal-key-item ${cls}"><span class="cal-key-sample" aria-hidden="true">${code ?? ''}</span>${label}</li>`)}
      </ul>
    </details>`;
}

const shortDate = (key) => formatDate(Date.parse(`${key}T12:00:00Z`), 'UTC')?.replace(/^\w+ /, '') ?? key;

/** Quiet coverage chip: what the roster source covers; everything else is hatched "no data". */
function coverageChip(m) {
  const c = m.coverage;
  const to = [c.flightsTo, c.freeListTo].filter(Boolean).sort().at(-1);
  const from = c.rememberedFrom && (!c.from || c.rememberedFrom < c.from) ? c.rememberedFrom : c.from;
  const inMonth = m.days.some((d) => d.inMonth && !noData(d));
  const text = !inMonth ? 'No roster data for this month' : from && to ? `Roster data ${shortDate(from)} – ${shortDate(to)}` : 'Roster data';
  const detail = [
    c.from && `source covers from ${shortDate(c.from)}`,
    c.flightsTo && `flights to ${shortDate(c.flightsTo)}`,
    c.freeListTo && `free-day list to ${shortDate(c.freeListTo)}`,
    c.rememberedFrom && `earlier flights remembered on this device from ${shortDate(c.rememberedFrom)}`,
  ].filter(Boolean).join(', ');
  return html`
    <p class="cal-coverage-chip" title="${detail ? `${detail}. ` : ''}Days outside are shown as no data; nothing is filled in.">
      <span class="cal-hatch" aria-hidden="true"></span><span>${text}${c.complete ? '' : ' · hatched days: no data'}</span>
      <span class="visually-hidden">. ${detail}. Days outside are shown as no data; nothing is filled in.</span>
    </p>`;
}

function summaryView(m) {
  const s = m.summary;
  const parts = [
    [s.flightDays, 'flight days'], [s.layoverDays, 'layover days'], [s.standbyDays, 'standby'], [s.reserveDays, 'reserve'],
    [s.offDays, 'off'], [s.unknownDuty, 'duty, type not given'], [s.unknownFree, 'no duty reported'],
    [s.unknownOther + s.noData, 'unknown / no data'],
  ].filter(([n]) => n > 0);
  return html`
    <section class="cal-summary" aria-label="Month summary">
      <p class="t-eyebrow">This month</p>
      <p class="cal-summary-line">${s.sectors} ${s.sectors === 1 ? 'sector' : 'sectors'} · ${s.rotations} ${s.rotations === 1 ? 'rotation' : 'rotations'}</p>
      <ul class="cal-summary-list" role="list">${parts.map(([n, label]) => html`<li><span class="t-tabular">${n}</span> ${label}</li>`)}</ul>
    </section>`;
}


/** "All day", "05:00 – 17:00", or a dated range for windows spanning several days. */
function windowText(w, day, tz) {
  if (w.start <= day.start && w.end >= day.end && localDateKey(w.start, tz) === day.date) return 'All day';
  if (localDateKey(w.start, tz) === localDateKey(w.end - 1, tz)) return `${formatTime(w.start, tz)} – ${formatTime(w.end, tz)}`;
  return `${formatDate(w.start, tz)} ${formatTime(w.start, tz)} → ${formatDate(w.end, tz)} ${formatTime(w.end, tz)}`;
}

/** Layover span in the outstation's local time (home time, labelled, if its zone is unknown). */
function awayRange(layover, homeTz) {
  const otz = airport(layover.airport)?.tz;
  const z = otz ?? homeTz;
  return `${formatDate(layover.from, z)} ${formatTime(layover.from, z)} → ${formatDate(layover.to, z)} ${formatTime(layover.to, z)} ${otz ? 'local time' : 'home time'}`;
}

function sectorRow(s, day) {
  const shift = s.originTz && s.destTz ? dayShift(s.dep, s.originTz, s.arr, s.destTz) : 0;
  return html`
    <li class="cal-sector">
      <span class="cal-sector-flight t-code">${s.flightNumber}${s.originTz && localDateKey(s.dep, s.originTz) !== day.date ? html`<span class="cal-sector-date">${formatDate(s.dep, s.originTz)}</span>` : ''}</span>
      <span class="cal-sector-route t-tabular">
        <span class="cal-sector-leg"><b>${s.origin}</b> ${clock(s.dep, s.originTz)}</span>
        <span class="cal-sector-leg"><span class="cal-sector-arrow" aria-hidden="true">→</span> <b>${s.destination}</b> ${clock(s.arr, s.destTz)}${shift ? html`<sup class="pass-shift">${shift > 0 ? `+${shift}` : shift}</sup>` : ''}</span>
      </span>
      <span class="cal-sector-block t-tabular">${formatDuration(s.blockMin)}</span>
    </li>`;
}

/**
 * The roster hotel for a day inside a source-stated stay, never inferred from the city:
 *  1. a stated layover window with a hotel that covers the day (its own window, else any other);
 *  2. an "Away from base" (inferred) layover whose arrival matches a roster stay's start at the
 *     same airport, the same rule the Flights destination uses (model/flights.js).
 */
export function stayHotel(day, snapshot) {
  const named = (h) => (h && typeof h.name === 'string' && h.name ? h : null);
  const stated = (w) => w?.kind === 'layover' && named(w.hotel);
  const w = stated(day.window) ? day.window : (snapshot?.windows ?? []).find((x) => stated(x) && x.start < day.end && x.end > day.start);
  if (w) return w.hotel;
  const l = day.layover;
  const stay = l && (snapshot?.stays ?? []).find((h) => named(h.hotel) && h.airport === l.airport && Math.abs(h.from - l.from) < 60000);
  return stay ? stay.hotel : null;
}

/** "Hotel · from roster" section: name, address, phone, and a map link only for a verified location (as in destination.js). */
export function hotelSection(day, snapshot, { review = false } = {}) {
  const hotel = stayHotel(day, snapshot);
  if (!hotel) return '';
  const phone = hotel.phone ? hotel.phone.replace(/[^\d+]/g, '') : '';
  const maps = !review && hotel.location?.mapsUrl;
  return html`
    <section class="cal-detail-section" data-cal-hotel>
      <p class="t-eyebrow">Hotel · from roster</p>
      <p class="t-headline">${hotel.name}</p>
      ${hotel.address ? html`<p class="t-caption t-secondary">${hotel.address}</p>` : ''}
      ${phone ? html`<p class="t-callout t-tabular"><a class="dest-link" href="tel:${phone}">${hotel.phone}</a></p>` : ''}
      ${maps ? html`<p class="t-callout"><a class="dest-link" href="${maps}" target="_blank" rel="noopener noreferrer">Hotel in Maps<span aria-hidden="true"> ↗</span><span class="visually-hidden"> (opens in a new tab)</span></a></p>` : ''}
    </section>`;
}

function detailView(day, view) {
  const { profile, now, roster, state } = view;
  const tz = profile.homeTz;
  if (!day) {
    return html`<div class="cal-detail-empty"><p class="t-callout t-secondary">Select a day to see its duties.</p></div>`;
  }
  const rotation = day.rotationId ? roster.rotations.find((r) => r.id === day.rotationId) : null;
  const confidence = noData(day) ? 'No data' : day.status === 'unknown' ? 'Unknown' : day.confidence === 'inferred' ? 'Inferred' : 'Confirmed';
  const dayNo = (ms) => Date.parse(`${localDateKey(ms, tz)}T12:00:00Z`);
  const rotationDays = rotation ? Math.max(1, Math.round((dayNo(rotation.end) - dayNo(rotation.start)) / 86400000) + 1) : 0;
  const rotationIndex = rotation ? Math.round((Date.parse(`${day.date}T12:00:00Z`) - dayNo(rotation.start)) / 86400000) + 1 : 0;
  const hz = rotation ? buildRotationHorizon(rotation, state, profile, now) : null;
  const title = noData(day) ? 'No data'
    : day.status === 'unknown' && day.evidence === 'duty-unspecified' ? 'Duty'
    : day.status === 'off' && OFF_SUBTYPE[day.offSubtype] ? OFF_SUBTYPE[day.offSubtype].name
    : `${STATUS_NAME[day.status]}${day.label && (day.status === 'flight' || day.status === 'layover') ? ` · ${day.status === 'flight' ? `to ${city(day.label)}` : city(day.label)}` : ''}`;
  return html`
    <article class="cal-detail-card" aria-labelledby="cal-detail-title">
      <header class="cal-detail-head">
        <p class="t-eyebrow">${day.isToday ? `Today · ${formatDate(day.start + 12 * 3600000, tz)}` : formatDate(day.start + 12 * 3600000, tz)}</p>
        <h2 class="t-title-2" id="cal-detail-title">${title}</h2>
        <p class="cal-detail-meta">
          <span class="status-pill" data-confidence="${day.status === 'unknown' ? 'unknown' : day.confidence}">${confidence}</span>
          ${day.provenance !== 'none' ? html`<span class="t-caption t-secondary">${PROVENANCE[day.provenance]}</span>` : ''}
        </p>
        ${day.status === 'unknown' || day.evidence ? html`<p class="t-callout t-secondary">${EVIDENCE[day.evidence] ?? 'No data for this day.'}</p>` : ''}
      </header>

      ${day.duties.map((duty) => html`
        <section class="cal-detail-section">
          <p class="t-eyebrow">${duty.sectors.length > 1 ? 'Flights' : 'Flight'}</p>
          <ol class="cal-sectors" role="list">${duty.sectors.map((s) => sectorRow(s, day))}</ol>
          ${duty.wakeup !== null || duty.pickup !== null ? html`
            <p class="cal-pickup t-tabular">
              ${duty.wakeup !== null ? html`<span>Wake-up <b>${clock(duty.wakeup, duty.sectors[0].originTz)}</b></span>` : ''}
              ${duty.pickup !== null ? html`<span>Pickup <b>${clock(duty.pickup, duty.sectors[0].originTz)}</b></span>` : ''}
            </p>` : ''}
        </section>`)}

      ${day.unknownCodes?.length ? html`
        <section class="cal-detail-section">
          <p class="t-eyebrow">${day.evidence === 'unknown-code' ? 'On the roster' : 'Also on the roster'}</p>
          <p class="t-callout">${day.unknownCodes.join(', ')}: a code Flight Control does not recognise. Shown as it is; not interpreted.</p>
        </section>` : ''}
      ${day.offSubtype === 'ort' ? html`
        <section class="cal-detail-section">
          <p class="t-eyebrow">ORT · from roster</p>
          <p class="t-callout">Assigned by the company as a free day; it cannot be taken away or reassigned.</p>
        </section>` : ''}
      ${day.window ? html`
        <section class="cal-detail-section">
          <p class="t-eyebrow">${day.window.kind === 'off' && OFF_SUBTYPE[day.window.subtype] ? OFF_SUBTYPE[day.window.subtype].name : STATUS_NAME[day.window.kind] ?? day.window.kind} · from roster</p>
          <p class="t-callout t-tabular">${windowText(day.window, day, tz)}${day.window.label && day.window.kind !== 'off' && day.window.kind !== 'layover' ? ` · ${day.window.label}` : ''}</p>
        </section>` : ''}

      ${day.layover && day.window?.kind !== 'layover' ? html`
        <section class="cal-detail-section">
          <p class="t-eyebrow">Away from base · ${day.layover.confidence === 'inferred' ? 'inferred' : 'roster'}</p>
          <p class="t-callout t-tabular">${city(day.layover.airport)} · ${awayRange(day.layover, tz)}</p>
          <p class="t-caption t-secondary">${day.layover.confidence === 'inferred' ? 'Arrived there and the next departure is from there. Derived from your itinerary, not a roster entry.' : 'Listed by the roster.'}</p>
        </section>` : ''}

      ${hotelSection(day, view.snapshot, { review: view.review })}

      ${rotation ? html`
        <section class="cal-detail-section">
          <p class="t-eyebrow">Rotation · day ${rotationIndex} of ${rotationDays}</p>
          <p class="t-headline">${[rotation.duties[0].sectors[0].origin, ...rotation.duties.flatMap((d) => d.sectors.map((x) => x.destination))].join(' → ')}</p>
          ${rotation.openStart || !rotation.closed ? html`<p class="t-caption t-secondary">${rotation.openStart ? 'Starts before the visible data. ' : ''}${rotation.closed ? '' : 'Return not yet visible.'}</p>` : ''}
          ${hz ? horizonView(hz, { variant: 'compact' }) : ''}
        </section>` : ''}
    </article>`;
}

export const calendar = {
  title: 'Calendar',

  render(ctx) {
    const view = ctx.view();
    const tz = view.profile.homeTz;
    const todayKey = localDateKey(view.now, tz);
    if (!ui.month) ui.month = monthKeyOf(todayKey);
    if (!view.snapshot) {
      const needsToken = !view.loading && view.error?.code === 'auth-required';   // S6
      return html`
        <div class="page">
          ${pageHeader({ title: 'Calendar', subtitle: 'Your roster, month by month' })}
          <div class="empty">
            <div class="empty-icon">${icon('calendar')}</div>
            <p class="t-headline">${view.loading ? 'Loading roster…' : needsToken ? 'Access token required' : 'No roster source connected'}</p>
            <p class="empty-text t-callout">${needsToken ? 'Your roster is only shown with the access token. Add it under Roster contract v2 in Settings.' : html`The calendar shows only what your roster source provides. ${view.loading ? '' : 'Connect it in Settings.'}`}</p>
            ${view.loading ? '' : html`<a class="btn btn-quiet" href="#/settings">${needsToken ? 'Open Settings' : 'Connect roster source'}</a>`}
          </div>
        </div>`;
    }
    const m = buildMonth(view.snapshot, view.roster, view.profile, view.now, ui.month);
    const selectedDay = m.days.find((d) => d.date === ui.selected) ?? null;
    return html`
      <div class="page">
        ${pageHeader({ eyebrow: view.review ? 'Sample data · not your roster' : 'Roster', title: m.label })}
        <div class="cal-layout">
          <section class="cal-main" aria-label="Roster month">
            <div class="cal-toolbar">
              <div class="cal-nav">
                <button type="button" class="btn btn-quiet cal-step" data-cal-step="-1" aria-label="Previous month">‹</button>
                <button type="button" class="btn btn-quiet cal-step" data-cal-step="1" aria-label="Next month">›</button>
              </div>
              <button type="button" class="btn btn-quiet" data-cal-today ${m.monthKey === monthKeyOf(todayKey) && ui.selected === todayKey ? 'disabled' : ''}>Today</button>
              ${view.review ? previewBadge('Sample · not your roster') : ''}
            </div>
            ${coverageChip(m)}
            <div class="cal-grid" role="grid" aria-label="${m.label}" aria-readonly="true">
              <div class="cal-row cal-head" role="row">
                ${WEEKDAYS.map((d) => html`<span class="cal-dow" role="columnheader">${d}</span>`)}
              </div>
              ${m.weeks.map((week) => html`<div class="cal-row" role="row">${week.map((day) => dayCell(day, m, tz))}</div>`)}
            </div>
            ${keyView()}
          </section>
          <aside class="cal-side" aria-label="Day detail">
            <div class="cal-detail" data-cal-detail>${detailView(selectedDay, view)}</div>
            ${summaryView(m)}
          </aside>
        </div>
      </div>`;
  },

  mount(root, ctx) {
    const rerender = (focusDate = null) => {
      ctx.rerender();
      if (focusDate) document.querySelector(`.cal-day[data-date="${focusDate}"]`)?.focus();
    };
    const select = (date, { focus = false } = {}) => {
      ui.selected = date;
      if (monthKeyOf(date) !== ui.month) ui.month = monthKeyOf(date);
      rerender(focus ? date : null);
      if (!focus && window.matchMedia('(max-width: 1199px)').matches) {
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        document.querySelector('[data-cal-detail]')?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
      }
    };
    const onClick = (event) => {
      const cell = event.target.closest('.cal-day');
      if (cell) { select(cell.dataset.date); return; }
      const step = event.target.closest('[data-cal-step]');
      if (step) { ui.month = addMonths(ui.month, Number(step.dataset.calStep)); ui.selected = null; rerender(); return; }
      if (event.target.closest('[data-cal-today]')) {
        const today = localDateKey(ctx.view().now, ctx.view().profile.homeTz);
        ui.month = monthKeyOf(today);
        select(today, { focus: true });
      }
    };
    const onKey = (event) => {
      const cell = event.target.closest('.cal-day');
      if (!cell) return;
      const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
      if (!(event.key in moves)) return;
      event.preventDefault();
      const [y, mo, d] = cell.dataset.date.split('-').map(Number);
      const next = new Date(Date.UTC(y, mo - 1, d + moves[event.key])).toISOString().slice(0, 10);
      select(next, { focus: true });
    };
    const key = root.querySelector('[data-cal-key]');
    if (key) {
      key.open = ui.keyOpen ?? window.matchMedia('(min-width: 1200px)').matches;
      key.addEventListener('toggle', () => { ui.keyOpen = key.open; });
    }
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKey);
    return () => { root.removeEventListener('click', onClick); root.removeEventListener('keydown', onKey); };
  },
};

/** Review hook: open a month, optionally selecting a day. */
export function focusCalendar(month, selected = null) {
  ui.month = month;
  ui.selected = selected;
}

/** Test hook: reset session UI state. */
export function resetCalendarUi(month = null, selected = null) {
  ui.month = month;
  ui.selected = selected;
}
