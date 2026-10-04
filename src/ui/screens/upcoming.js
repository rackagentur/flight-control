// Screens whose content arrives in later phases. Each states plainly what will appear,
// carrying forward every v5 feature listed for it in docs/PLAN.md §C.

import { html } from '../../lib/html.js';
import { routeById } from '../../router.js';
import { pageHeader, upcomingScreen } from '../components.js';

function screen(id, { subtitle, phase, summary, items }) {
  const route = routeById(id);
  return {
    title: route.title,
    render() {
      return html`
        <div class="page">
          ${pageHeader({ title: route.title, subtitle })}
          ${upcomingScreen({ route, phase, summary, items })}
        </div>`;
    },
  };
}

export const map = screen('map', {
  subtitle: 'Where you have flown',
  phase: 'a later phase',
  summary: 'Your route network in earth tones.',
  items: [
    'Great-circle routes weighted by how often you flew them',
    'Airports sized by visits, with visit counts',
    'Top routes and airports alongside on desktop',
  ],
});

export const weather = screen('weather', {
  subtitle: 'Conditions where you are going',
  phase: 'a later phase',
  summary: 'Forecasts for your next destinations, on the local date you arrive.',
  items: [
    'Next destinations with daily high, low and conditions',
    'The same forecast surfaces on Today when it matters',
  ],
});

export const statistics = screen('statistics', {
  subtitle: 'This month, this year, all time',
  phase: 'a later phase',
  summary: 'Your flying history with editorial hierarchy instead of a wall of tiles.',
  items: [
    'This month: flights, rostered hours, days away, standby, reserve, progress',
    'This year and month-end / year-end projections',
    'All time: flights, hours, distance, countries, airports',
    'Records: longest flight, busiest month, top destination, top route',
    'Achievements with progress',
  ],
});
