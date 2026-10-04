// Shared test helpers (not a test file: no `.test.` in the name).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptV5 } from '../src/sources/fc-appscript-v5.js';
import { buildRoster } from '../src/model/roster.js';
import { deriveState } from '../src/model/state.js';
import { buildHorizon } from '../src/model/horizon.js';
import { DEFAULT_PROFILE } from '../src/config/profile.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const PROFILE = DEFAULT_PROFILE;
export const at = (iso) => Date.parse(iso);

export function loadFixture() {
  return JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/getstats.v5.synthetic.json'), 'utf8'));
}

export function fixtureSnapshot(mutate = null) {
  const payload = loadFixture();
  if (mutate) mutate(payload);
  return adaptV5(payload, { profile: PROFILE, fetchedAt: at(payload._now), kind: 'fixture' });
}

/** Full pipeline at a moment: snapshot → roster → state → horizon. */
export function pipeline(snapshot, iso, profile = PROFILE) {
  const now = at(iso);
  const roster = buildRoster(snapshot, profile, now);
  const state = deriveState(snapshot, roster, profile, now);
  const horizon = buildHorizon(roster, state, profile, now);
  return { now, roster, state, horizon };
}
