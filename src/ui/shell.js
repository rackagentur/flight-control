// Application shell: one route list drives every navigation surface.
//   mobile  → floating glass tab bar (Today · Calendar · Flights · Map · More)
//   tablet  → icon rail with every destination
//   desktop → sidebar with grouped navigation, data status and quick theme switch

import { html, render } from '../lib/html.js';
import { ROUTES, hrefFor, activeTabFor } from '../router.js';
import { icon, brandMark } from './icons.js';
import { themeControl } from './components.js';

const GROUPS = [
  { id: 'primary', label: 'Operations' },
  { id: 'insight', label: 'Insights' },
  { id: 'system', label: 'System' },
];

function sidebar() {
  const groups = GROUPS.map((group) => {
    const items = ROUTES.filter((route) => route.group === group.id);
    return html`
      <div class="nav-group">
        <div class="nav-group-label t-eyebrow" id="nav-${group.id}">${group.label}</div>
        <ul class="nav-list" role="list" aria-labelledby="nav-${group.id}">
          ${items.map((route) => html`
            <li><a class="nav-item" href="${hrefFor(route.id)}" data-route="${route.id}">${icon(route.icon)}<span>${route.title}</span></a></li>
          `)}
        </ul>
      </div>`;
  });

  return html`
    <a class="brand" href="${hrefFor('today')}" aria-label="Flight Control, Today">
      ${brandMark()}
      <span class="brand-text"><span class="brand-name">Flight Control</span><span class="brand-sub">Adaptive Aviation</span></span>
    </a>
    <nav aria-label="Primary">${groups}</nav>
    <div class="sidebar-footer">
      <div class="status-line" role="status" data-source-status><span class="status-dot" aria-hidden="true"></span><span data-source-text>No roster source connected</span></div>
      <div class="theme-quick">${themeControl({ compact: true, label: 'Theme' })}</div>
    </div>`;
}

function tabbar() {
  return html`${ROUTES.filter((route) => route.tab).map((route) => html`
    <a class="tab" href="${hrefFor(route.id)}" data-tab="${route.id}">${icon(route.icon)}<span>${route.title}</span></a>
  `)}`;
}

export function mountShell() {
  const side = document.getElementById('sidebar');
  const tabs = document.getElementById('tabbar');
  render(side, sidebar());
  render(tabs, tabbar());
  const statusLine = side.querySelector('[data-source-status]');
  return {
    main: document.getElementById('main'),
    /** Sidebar data status: what the app is showing and how fresh it is. */
    setStatus(view) {
      let text = 'No roster source connected';
      let kind = 'none';
      if (view.review) { text = 'Sample data · not your roster'; kind = 'review'; }
      else if (view.loading && !view.snapshot) { text = 'Loading roster…'; kind = 'loading'; }
      else if (view.snapshot) {
        const minutes = Math.max(0, Math.round((view.now - view.snapshot.source.fetchedAt) / 60000));
        text = view.error ? 'Roster offline · showing cached' : minutes < 1 ? 'Roster updated just now' : `Roster updated ${minutes} min ago`;
        kind = view.error ? 'stale' : 'live';
      } else if (view.error) { text = 'Roster unavailable'; kind = 'error'; }
      statusLine.dataset.kind = kind;
      statusLine.querySelector('[data-source-text]').textContent = text;
    },
    setActive(routeId) {
      const tab = activeTabFor(routeId);
      for (const link of tabs.querySelectorAll('[data-tab]')) {
        if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
      for (const link of side.querySelectorAll('[data-route]')) {
        if (link.dataset.route === routeId) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
    },
  };
}
