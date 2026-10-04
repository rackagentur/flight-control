// 7-day operational strip for Today: "what does my next week look like?"
// Each day shows only what the evidence supports. Unknown days are drawn as unknown,
// never as off; inferred layover days carry an inferred marker.

import { html } from '../lib/html.js';
import { zonedParts } from '../lib/time.js';

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const EVIDENCE_TEXT = {
  'no-duty-reported': 'No duty reported',
  'duty-unspecified': 'Duty, details not provided',
  'outside-window': 'No data',
};

function dayLabel(day) {
  if (day.status === 'off') return 'OFF';
  if (day.status === 'standby') return 'SB';
  if (day.status === 'reserve') return 'RE';
  if (day.label) return day.label;
  if (day.evidence === 'duty-unspecified') return 'Duty';
  return '—';
}

function dayDescription(day) {
  const base = {
    flight: `Flight${day.label ? ` · ${day.label}` : ''}`,
    layover: `Layover ${day.label}${day.confidence === 'inferred' ? ' (inferred)' : ''}${day.evidence === 'duty-unspecified' ? ', duty also listed' : ''}`,
    standby: 'Standby',
    reserve: 'Reserve',
    off: 'Off',
  }[day.status];
  return base ?? EVIDENCE_TEXT[day.evidence] ?? 'Unknown';
}

export function weekView(days, tz) {
  return html`
    <ol class="week" role="list" aria-label="Next 7 days">
      ${days.map((day) => {
        const p = zonedParts(day.start + 12 * 3600000, tz);
        return html`
          <li class="week-day is-${day.status} ${day.isToday ? 'is-today' : ''} ${day.confidence === 'inferred' ? 'is-inferred' : ''} ${day.evidence ? `ev-${day.evidence}` : ''}"
              aria-label="${day.isToday ? 'Today, ' : ''}${WEEKDAY[p.weekday]} ${p.day}: ${dayDescription(day)}">
            <span class="week-dow" aria-hidden="true">${day.isToday ? 'Today' : WEEKDAY[p.weekday]}</span>
            <span class="week-date t-tabular" aria-hidden="true">${p.day}</span>
            <span class="week-mark" aria-hidden="true"></span>
            <span class="week-code" aria-hidden="true">${dayLabel(day)}</span>
          </li>`;
      })}
    </ol>`;
}
