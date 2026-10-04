// Controls: the existing backend actions. Shown now so nothing silently disappears;
// wired to the backend in a later phase (with confirmation, since reports send email).

import { html } from '../../lib/html.js';
import { pageHeader, listRow } from '../components.js';

export const controls = {
  title: 'Controls',
  render() {
    return html`
      <div class="page">
        ${pageHeader({ title: 'Controls', subtitle: 'Sync and reports' })}
        <div class="more">
          <section class="section" aria-labelledby="controls-roster">
            <div class="section-head"><h2 class="t-eyebrow" id="controls-roster">Roster</h2></div>
            <div class="list">
              ${listRow({ iconName: 'sync', label: 'Run sync now', detail: 'Refreshes your Flight Control calendar from the airline roster', trail: 'Later phase', disabled: true })}
            </div>
          </section>
          <section class="section" aria-labelledby="controls-reports">
            <div class="section-head"><h2 class="t-eyebrow" id="controls-reports">Monthly reports</h2></div>
            <div class="list">
              ${listRow({ iconName: 'report', label: 'Current month', detail: 'Generates the report and emails a summary', trail: 'Later phase', disabled: true })}
              ${listRow({ iconName: 'report', label: 'Previous month', detail: 'Generates the report and emails a summary', trail: 'Later phase', disabled: true })}
            </div>
          </section>
          <section class="section" aria-labelledby="controls-hotels">
            <div class="section-head"><h2 class="t-eyebrow" id="controls-hotels">Hotels</h2></div>
            <div class="list">
              ${listRow({ iconName: 'hotel', label: 'Saved hotels', detail: 'Your saved list, configured in Settings', trail: 'Later phase', disabled: true })}
            </div>
          </section>
          <p class="t-caption t-secondary">These actions become available once a roster source is connected. Report actions will ask for confirmation because they send email.</p>
        </div>
      </div>`;
  },
};
