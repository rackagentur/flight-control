// Descriptions of the six operational environments for the design preview.
// This is design documentation rendered in the app, NOT roster data: it contains no flights,
// times or places, and every surface that shows it carries a PREVIEW label.

export const ENVIRONMENTS = [
  {
    state: 'off',
    name: 'Off',
    family: 'Stone · Tobacco · Sand',
    intent: 'Rest. Warm, quiet and unhurried. Leads with the next duty and the time until it begins.',
  },
  {
    state: 'flight',
    name: 'Flight',
    family: 'Slate · Steel · Muted sky',
    intent: 'On duty or airborne. Cool and precise: route, wake-up, pickup, departure and countdown.',
  },
  {
    state: 'standby',
    name: 'Standby',
    family: 'Graphite · Taupe · Muted amber',
    intent: 'Armed but waiting. Calm, with the standby window, time remaining and next known event.',
  },
  {
    state: 'reserve',
    name: 'Reserve',
    family: 'Graphite · Taupe',
    intent: 'On reserve. The same calm family as standby, told apart by its label and taupe accent.',
  },
  {
    state: 'layover',
    name: 'Layover',
    family: 'Destination-derived earth tone',
    intent: 'Away from base. The tone follows the destination; local time, weather and hotel lead.',
  },
  {
    state: 'unknown',
    name: 'Unknown',
    family: 'Neutral graphite · Stone',
    intent: 'Shown whenever the roster cannot prove a state. Never disguised as Off.',
  },
];

export const TONES = [
  { tone: 'ocean', name: 'Ocean' },
  { tone: 'olive', name: 'Olive' },
  { tone: 'stone', name: 'Stone' },
  { tone: 'sand', name: 'Sand' },
];

export function environment(state) {
  return ENVIRONMENTS.find((entry) => entry.state === state) ?? ENVIRONMENTS.at(-1);
}
