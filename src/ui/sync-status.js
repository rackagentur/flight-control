import { opTime, opDateKey } from '../lib/op-time.js';
import { getTimeDisplay } from '../time-display.js';
import { html } from '../lib/html.js';

export function syncStatusText(view) {
  if (view.review) return '';
  if (!view.snapshot) return view.storageError ? 'Local data could not be cleared. Clear website data in browser settings.'
    : view.offline ? 'Offline · No saved roster on this device' : '';
  const local = view.savedRoster ? 'Saved roster' : 'Roster in memory only';
  const state = view.offline ? `Offline · ${local}` : view.error?.code === 'auth-required' ? `${local} · Authentication needed`
    : view.error ? `${local} · Refresh failed` : view.usingSaved || view.storageError ? local : 'Roster synchronized';
  const at = view.lastSyncedAt;
  const zone = getTimeDisplay() === 'utc' ? 'UTC' : view.profile.homeTz;
  const time = at ? `${opDateKey(at, view.profile.homeTz)} ${opTime(at, view.profile.homeTz)} (${zone})` : null;
  const saved = time ? `Last sync ${time}` : 'Not saved on this device';
  const readiness = view.storageError ? 'Could not save update' : view.offlineReady ? 'Available offline' : 'Offline setup incomplete';
  return `${state} · ${saved}${view.loading && !view.offline ? ' · Refreshing' : ''} · ${readiness}`;
}
export const syncStatus = (view) => html`<p class="sync-status t-caption" data-sync-status role="status" aria-live="polite" ${view.review ? 'hidden' : ''}>${syncStatusText(view)}</p>`;
