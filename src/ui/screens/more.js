// More (mobile): Weather · Statistics · Controls · Settings.

import { html } from '../../lib/html.js';
import { hrefFor } from '../../router.js';
import { pageHeader, listRow } from '../components.js';

export const more = {
  title: 'More',
  render() {
    return html`
      <div class="page">
        ${pageHeader({ title: 'More' })}
        <div class="more">
          <section class="section" aria-labelledby="more-insights">
            <div class="section-head"><h2 class="t-eyebrow" id="more-insights">Insights</h2></div>
            <div class="list">
              ${listRow({ href: hrefFor('weather'), iconName: 'weather', label: 'Weather', detail: 'Destination forecasts' })}
              ${listRow({ href: hrefFor('statistics'), iconName: 'statistics', label: 'Statistics', detail: 'Month, year, all time, achievements' })}
            </div>
          </section>
          <section class="section" aria-labelledby="more-system">
            <div class="section-head"><h2 class="t-eyebrow" id="more-system">System</h2></div>
            <div class="list">
              ${listRow({ href: hrefFor('controls'), iconName: 'controls', label: 'Controls', detail: 'Sync and monthly reports' })}
              ${listRow({ href: hrefFor('settings'), iconName: 'settings', label: 'Settings', detail: 'Theme, roster source, profile' })}
            </div>
          </section>
        </div>
      </div>`;
  },
};
