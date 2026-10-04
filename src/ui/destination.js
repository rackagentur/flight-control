// Destination intelligence view (decision D5): one component for any screen. Rows appear only
// when they apply: local time and difference from home, the stay (turnaround / layover /
// return not yet listed), weather, the hotel (never an invented assignment) and map actions.
// Unavailable data is stated plainly with its reason.

import { html } from '../lib/html.js';
import { formatDate, formatDuration, formatTime, formatUtcOffset } from '../lib/time.js';
import { MAX_INFERRED_LAYOVER_DAYS } from '../model/roster.js';

const pad = (n) => String(n).padStart(2, '0');

/** "Same time as home", "6h behind home", "5h 30m ahead of home". */
export function diffText(minutes) {
  if (minutes === null) return null;
  if (minutes === 0) return 'Same time as home';
  const abs = Math.abs(minutes);
  const span = `${Math.floor(abs / 60)}h${abs % 60 ? ` ${abs % 60}m` : ''}`;
  return `${span} ${minutes > 0 ? 'ahead of' : 'behind'} home`;
}

/** Compact signed difference for one-line summaries: "same time", "−6h", "+5:30". */
export function diffShort(minutes) {
  if (minutes === null) return null;
  if (minutes === 0) return 'same time as home';
  const abs = Math.abs(minutes);
  return `${minutes > 0 ? '+' : '−'}${Math.floor(abs / 60)}${abs % 60 ? `:${pad(abs % 60)}` : 'h'} vs home`;
}

const nights = (n) => (n === 1 ? '1 night' : `${n} nights`);

export function stayText(stay) {
  if (!stay) return null;
  if (stay.kind === 'turn') return `${formatDuration(stay.minutes)} on the ground`;
  if (stay.kind === 'open') return 'Return not yet listed';
  if (stay.kind === 'gap') {
    if (stay.reason === 'too-long') return `Next departure from here is more than ${MAX_INFERRED_LAYOVER_DAYS} days later`;
    return stay.nextOrigin ? `Next listed flight departs ${stay.nextOrigin}` : 'No later flight seen on this device';
  }
  const length = [stay.nights ? nights(stay.nights) : null, formatDuration(stay.minutes)].filter(Boolean).join(' · ');
  return length;
}

export function stayLabel(stay) {
  if (!stay) return null;
  if (stay.kind === 'turn') return 'Turnaround';
  if (stay.kind === 'open') return 'Stay';
  if (stay.kind === 'gap') return stay.reason === 'too-long' ? 'No layover inferred' : 'Return not seen';
  return stay.confidence === 'confirmed' ? 'Layover · from roster' : 'Layover · inferred';
}

const WEATHER_REASON = {
  'no-coordinates': 'No coordinates for this airport',
  'no-timezone': 'Time zone unknown',
  error: 'Forecast unavailable right now',
  'not-in-forecast': 'Not in the current forecast',
  review: 'Not loaded in review mode',
  'no-destination': 'Unavailable',
};

/** Weather line value; null when nothing should be shown (e.g. a stay in the past). */
export function weatherText(w, tz) {
  if (!w) return null;
  if (w.status === 'ok') return `${w.text ?? 'Forecast'} · ${w.max}° / ${w.min}°`;
  if (w.status === 'loading') return 'Loading forecast…';
  if (w.status === 'later') {
    const from = w.availableFrom ? formatDate(Date.parse(`${w.availableFrom}T12:00:00Z`), 'UTC') : null;
    return from ? `Forecast from ${from}` : 'Too far ahead for a forecast';
  }
  if (w.reason === 'past') return null;
  return WEATHER_REASON[w.reason] ?? 'Unavailable';
}

function row(label, value, { note = null, attrs = '' } = {}) {
  return html`
    <div class="dest-row" ${attrs}>
      <dt class="dest-label">${label}</dt>
      <dd class="dest-value"><span class="dest-main">${value}</span>${note ? html`<span class="dest-note">${note}</span>` : ''}</dd>
    </div>`;
}

function link(href, text) {
  return html`<a class="dest-link" href="${href}" target="_blank" rel="noopener noreferrer">${text}<span aria-hidden="true"> ↗</span><span class="visually-hidden"> (opens in a new tab)</span></a>`;
}

/**
 * @param {object|null} dest  model/destination.buildDestination()
 * @param {object|null} weather  resolved provider answer for dest.weather
 * @param {{now: number, review?: boolean, titleId?: string}} options
 */
export function destinationView(dest, weather, { now, review = false, titleId = null }) {
  if (!dest) return '';
  const stay = dest.stay;
  const wText = weatherText(weather, dest.tz);
  const weatherDate = weather?.date ? formatDate(Date.parse(`${weather.date}T12:00:00Z`), 'UTC') : null;
  const showHotel = Boolean(dest.hotel);
  return html`
    <section class="dest" aria-labelledby="${titleId ?? ''}" data-tone="${dest.tone ?? ''}">
      <header class="dest-head">
        <p class="t-eyebrow" ${titleId ? html`id="${titleId}"` : ''}>Destination</p>
        <p class="dest-place"><span class="t-headline">${dest.city}</span>${dest.country ? html` <span class="t-callout t-secondary">${dest.country}</span>` : ''}${dest.city !== dest.iata ? html` <span class="t-code dest-code">${dest.iata}</span>` : ''}</p>
      </header>
      <dl class="dest-rows">
        ${dest.tz
          ? row('Local time', html`<span class="t-tabular" data-clock-tz="${dest.tz}">${formatTime(now, dest.tz)}</span> · ${formatUtcOffset(now, dest.tz)}`, { note: diffText(dest.diffNow) })
          : row('Local time', 'Unknown', { note: 'This airport is not in the airport table, so its times are shown in UTC.' })}
        ${stay ? row(stayLabel(stay), stayText(stay), {
          note: stay.current && stay.remainingMin !== null ? `Now there · ${formatDuration(stay.remainingMin)} left`
            : stay.kind === 'layover' && stay.confidence === 'inferred' ? 'Derived from your itinerary, not a roster entry.'
            : stay.kind === 'open' ? 'The next departure from here is beyond the flights your roster source lists.'
            : stay.kind === 'gap' && stay.reason === 'too-long' ? `Longer than ${MAX_INFERRED_LAYOVER_DAYS} calendar days, so no layover is inferred and nothing is assumed about the time there.`
            : stay.kind === 'gap' ? 'No departure from here is known, so nothing is inferred about the time there.' : null,
        }) : ''}
        ${wText ? row(weatherDate ? `Weather · ${weatherDate}` : 'Weather', wText, {
          note: weather?.status === 'ok' ? (weather.sample ? 'Sample forecast' : `Forecast · ${weather.source}`) : null,
          attrs: html`data-weather="${weather?.status ?? 'none'}"`,
        }) : ''}
        ${showHotel && dest.hotel.record ? row('Hotel · from roster', html`${dest.hotel.record.name}${dest.hotel.record.address ? html`<span class="dest-note">${dest.hotel.record.address}</span>` : ''}`, {
          note: dest.hotel.record.phone ? html`<a class="dest-link" href="tel:${dest.hotel.record.phone.replace(/[^\d+]/g, '')}">${dest.hotel.record.phone}</a>` : null,
        }) : ''}
        ${showHotel && !dest.hotel.record ? row('Hotel', 'Not provided by your roster source', {
          note: review ? 'Hotel links are off in review mode.' : null,
        }) : ''}
      </dl>
      ${!review && (dest.maps || (showHotel && (dest.hotel.search || dest.hotel.savedList || dest.hotel.record?.location?.mapsUrl))) ? html`
        <p class="dest-actions">
          ${showHotel && dest.hotel.record?.location?.mapsUrl ? link(dest.hotel.record.location.mapsUrl, 'Hotel in Maps') : ''}
          ${showHotel && !dest.hotel.record && dest.hotel.search ? link(dest.hotel.search, `Hotels in ${dest.city}`) : ''}
          ${showHotel && dest.hotel.savedList ? link(dest.hotel.savedList, 'My saved hotels') : ''}
          ${dest.maps ? link(dest.maps, `${dest.iata} in Maps`) : ''}
        </p>` : ''}
    </section>`;
}

/** One quiet line for journey lists: "Berlin · −6h vs home · Partly cloudy 24°". */
export function destinationTeaser(dest, weather) {
  if (!dest) return '';
  const w = weather?.status === 'ok' ? `${weather.text ?? 'Forecast'} ${weather.max}°` : null;
  return [dest.city, diffShort(dest.diffAtArrival), w].filter(Boolean).join(' · ');
}
