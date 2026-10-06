# Flight Control

An operational roster companion for airline crew: today's duty state, the Duty Horizon, roster calendar, flights, route map, weather and flying statistics.

> **Status:** V2 redesign in progress on the `v2-redesign` branch (Phase 5: roster Calendar).
> The production app is still the Apps Script v5 web app; V2 is not live.

## Architecture (V2)

A static, framework-free web app (native ES modules, no build step) that reads roster data through **roster-source adapters** and renders a **normalized duty model**.

```
RosterSource adapter ─▶ RosterSnapshot (normalized) ─▶ state engine · Duty Horizon · roster ─▶ UI
  fc-appscript-v5          src/model/                     src/model/                          src/ui/
  sample (synthetic)
  later: airline calendar · ICS import · Flight Control API
```

- **Backend (temporary):** the existing Google Apps Script web app (`?action=getStats|sync|dashboard|dashboardPrev`). Its contract is frozen during the redesign.
- **Times:** always computed from timestamps with IANA time zones in the presentation layer.
- **States:** OFF, UNASSIGNED (a day the roster lists with no duty assigned; not a day off), FLIGHT, STANDBY, RESERVE, LAYOVER, UNKNOWN. Every state carries a confidence level, and the app never shows a state the data cannot support.
- **Flights:** rotations drawn as journeys, per-sector detail inside its rotation, shared destination intelligence (local time, stay, weather, legitimate hotel actions). Weather comes from Open-Meteo, requested by the browser with the airport's coordinates only (no key, nothing personal; never in review mode).
- **Seen on this device:** recently flown sectors are remembered locally (120 days, at most 300) because the v5 source has no flight history. They are labelled as such and never presented as a complete history.

See [`docs/PLAN.md`](docs/PLAN.md) for the full plan, [`docs/DATA-GAPS.md`](docs/DATA-GAPS.md) for what the current source cannot provide, and [`docs/AUDIT.md`](docs/AUDIT.md) for the Phase 0 audit.

## Run locally

```sh
npm run serve        # no-cache local server, then open http://localhost:8080
```

The backend endpoint is entered at runtime in **Settings → Roster source** and stored only in that browser. **Never commit it.**

Review mode: open `http://localhost:8080/?review#/today`. It shows **fictional sample data only** (places HOME/AWAY, flights SAMPLE 01…), one scenario per operational state plus Calendar and Flights scenarios, under a permanent "Sample data · Not your roster" banner. The synthetic v5 fixture is used by the tests only, never shown in the app.

## Test

```sh
npm test             # node --test, no dependencies (Node ≥ 21: test globs)
```

## Privacy rules for this public repository

- Never commit calendar IDs, sheet IDs, deployment URLs, employee numbers, saved-list URLs, API keys or real roster data.
- `reference/` (private production source) is git-ignored.
- Every committed fixture must be synthetic or redacted and declare `"_synthetic": true` or `"_redacted": true`.
- `tests/repo-hygiene.test.js` enforces these rules.

## Repository layout

| Path | Purpose |
|---|---|
| `index.html`, `src/` | V2 app |
| `tests/` | Node test suites and synthetic fixtures |
| `docs/` | Audit, plan, data gaps, backend-hardening plan |
| `legacy/index-v1.html` | The original GitHub frontend, preserved (no longer functional against the current backend) |
