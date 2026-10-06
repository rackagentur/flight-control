// Hash router: works on any static host (no server rewrites).
// Route metadata is the single source for every navigation surface (tab bar, rail, sidebar, More).

export const ROUTES = [
  { id: 'today', title: 'Today', icon: 'today', group: 'primary', tab: true },
  { id: 'calendar', title: 'Calendar', icon: 'calendar', group: 'primary', tab: true },
  // detail: the route accepts one sub-path (#/flights/<sector id>, Phase 6 decision D6).
  { id: 'flights', title: 'Flights', icon: 'flights', group: 'primary', tab: true, detail: true },
  { id: 'map', title: 'Map', icon: 'map', group: 'primary', tab: true },
  { id: 'more', title: 'More', icon: 'more', group: 'hidden', tab: true },
  // Radar (slice 1): reached from Today / Calendar only; Today stays the active tab. Detail = the window start (epoch ms).
  { id: 'radar', title: 'Flights in standby window', icon: 'radar', group: 'hidden', parent: 'today', detail: true },
  { id: 'weather', title: 'Weather', icon: 'weather', group: 'insight', parent: 'more' },
  { id: 'statistics', title: 'Statistics', icon: 'statistics', group: 'insight', parent: 'more' },
  { id: 'controls', title: 'Controls', icon: 'controls', group: 'system', parent: 'more' },
  { id: 'settings', title: 'Settings', icon: 'settings', group: 'system', parent: 'more' },
];

export const DEFAULT_ROUTE = 'today';

const BY_ID = new Map(ROUTES.map((route) => [route.id, route]));

export function routeById(id) {
  return BY_ID.get(id) ?? null;
}

/** '#/flights' → 'flights'. Unknown, empty or malformed hashes → DEFAULT_ROUTE. */
export function parseHash(hash) {
  const id = String(hash ?? '').replace(/^#\/?/, '').split(/[/?]/)[0].toLowerCase();
  return BY_ID.has(id) ? id : DEFAULT_ROUTE;
}

/** '#/flights/<id>' → '<id>' (decoded) for routes that accept a detail; otherwise null. */
export function parseParam(hash) {
  const path = String(hash ?? '').replace(/^#\/?/, '').split('?')[0];
  const slash = path.indexOf('/');
  if (slash < 0 || !routeById(parseHash(hash))?.detail) return null;
  const rest = path.slice(slash + 1);
  if (!rest) return null;
  try { return decodeURIComponent(rest); } catch { return null; }
}

export function hrefFor(id, param = null) {
  return param ? `#/${id}/${encodeURIComponent(param)}` : `#/${id}`;
}

/** The tab that should appear selected for a route (More owns its child screens). */
export function activeTabFor(id) {
  const route = routeById(id);
  return route?.parent ?? id;
}

export function startRouter(onRoute, win = globalThis.window) {
  const emit = () => {
    const id = parseHash(win.location.hash);
    const param = parseParam(win.location.hash);
    // Normalise unknown or malformed hashes so the URL always names the screen shown.
    if (win.location.hash !== hrefFor(id, param)) win.history.replaceState(null, '', hrefFor(id, param));
    onRoute(id, param);
  };
  win.addEventListener('hashchange', emit);
  emit();
  return () => win.removeEventListener('hashchange', emit);
}
