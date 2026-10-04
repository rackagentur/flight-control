// Settings: Appearance (live), Roster source and Profile (structure; later phases), local data.

import { html } from '../../lib/html.js';
import { pageHeader, listRow, themeControl } from '../components.js';
import { store } from '../../store.js';
import { applyTheme } from '../../theme.js';

export const settings = {
  title: 'Settings',

  render() {
    return html`
      <div class="page">
        ${pageHeader({ title: 'Settings' })}
        <div class="settings">
          <section class="setting-block" aria-labelledby="set-appearance">
            <div class="section-head"><h2 class="t-eyebrow" id="set-appearance">Appearance</h2></div>
            <div class="list">
              <div class="setting-row">
                <div class="setting-copy">
                  <span class="list-label">Theme</span>
                  <span class="t-caption">System follows your device. Your choice is remembered on this device.</span>
                </div>
                ${themeControl()}
              </div>
            </div>
          </section>

          <section class="setting-block" aria-labelledby="set-source">
            <div class="section-head"><h2 class="t-eyebrow" id="set-source">Roster source</h2></div>
            <div class="list">
              ${listRow({ iconName: 'source', label: 'Flight Control calendar', detail: 'Your processed roster via the Flight Control backend', trail: 'Phase 4', disabled: true })}
              ${listRow({ iconName: 'calendar', label: 'Airline calendar', detail: 'Read the airline roster calendar directly', trail: 'Planned', disabled: true })}
              ${listRow({ iconName: 'report', label: 'ICS import', detail: 'Import a roster file', trail: 'Planned', disabled: true })}
            </div>
          </section>

          <section class="setting-block" aria-labelledby="set-profile">
            <div class="section-head"><h2 class="t-eyebrow" id="set-profile">Profile</h2></div>
            <div class="list">
              ${listRow({ iconName: 'profile', label: 'Home base and time zone', trail: 'Phase 4', disabled: true })}
              ${listRow({ iconName: 'today', label: 'Wake-up before pickup', trail: 'Phase 4', disabled: true })}
              ${listRow({ iconName: 'hotel', label: 'Alarm shortcut and saved hotels', trail: 'Phase 6', disabled: true })}
            </div>
          </section>

          <section class="setting-block" aria-labelledby="set-data">
            <div class="section-head"><h2 class="t-eyebrow" id="set-data">Data on this device</h2></div>
            <div class="list">
              <div class="setting-row">
                <div class="setting-copy">
                  <span class="list-label">Reset local data</span>
                  <span class="t-caption" id="reset-help">Clears Flight Control preferences stored in this browser. Your roster is not affected.</span>
                </div>
                <button type="button" class="btn btn-critical" id="reset-local" aria-describedby="reset-help">Reset</button>
              </div>
            </div>
          </section>

          <section class="setting-block" aria-labelledby="set-about">
            <div class="section-head"><h2 class="t-eyebrow" id="set-about">About</h2></div>
            <div class="list">
              ${listRow({ iconName: 'info', label: 'Flight Control', detail: 'Version 2.0 · design system preview (Phase 3)' })}
            </div>
          </section>
        </div>
      </div>`;
  },

  mount(root) {
    let armed = false;
    let timer = null;
    const button = root.querySelector('#reset-local');
    const onClick = () => {
      if (!armed) {
        armed = true;
        button.textContent = 'Tap again to reset';
        timer = setTimeout(() => { armed = false; button.textContent = 'Reset'; }, 4000);
        return;
      }
      clearTimeout(timer);
      const removed = store.clearAll();
      applyTheme('system');
      armed = false;
      button.textContent = removed > 0 ? 'Cleared' : 'Nothing to clear';
      button.disabled = true;
    };
    button.addEventListener('click', onClick);
    return () => { clearTimeout(timer); button.removeEventListener('click', onClick); };
  },
};
