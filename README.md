# Flight Control

An operational roster companion for airline crew: today's duty state, the Duty Horizon, roster calendar, flights, route map, weather and flying statistics.

> **Status:** V2 redesign in progress on the `v2-redesign` branch (Phase 2 scaffold).
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
- **States:** OFF, FLIGHT, STANDBY, RESERVE, LAYOVER, UNKNOWN. Every state carries a confidence level, and the app never shows a state the data cannot support.

See [`docs/PLAN.md`](docs/PLAN.md) for the full plan, [`docs/DATA-GAPS.md`](docs/DATA-GAPS.md) for what the current source cannot provide, and [`docs/AUDIT.md`](docs/AUDIT.md) for the Phase 0 audit.

## Run locally

```sh
npm run serve        # python3 -m http.server 8080, then open http://localhost:8080
```

The backend endpoint is entered at runtime in Settings (Phase 3+) and stored only in the browser. **Never commit it.**

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
