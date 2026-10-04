# Phase 0 audit (public, redacted)

Date: 2026-10-04 · Scope: GitHub repository + the Apps Script production source (kept privately in git-ignored `reference/`).
Personal identifiers (calendar, sheet and deployment IDs, employee number, email, saved-list links) are **redacted**.
Detailed security findings are kept privately until backend hardening is complete (see `BACKEND-HARDENING.md`).

## 1. Source inventory

| File (Apps Script project) | Role |
|---|---|
| `Code.gs` | Backend: calendar sync and enrichment, layover hotel database, triggers |
| `Dashboard.gs` | Backend: monthly report (Drive HTML file + email summary) |
| `Flight Control Web App v5.gs` | **Production reference**: `doGet` router, `getFlightStats`, the v5 UI (`getAppHtml`) |
| `Web App Wrapper v2.gs` | Legacy compatibility backend for the old GitHub page (`?function=` + JSONP); shadowed by v5 |
| `WebAppV5.gs` | Local duplicate of v5 (functionally identical; not part of the live project) |
| `appsscript.json` | Project manifest (Europe/Berlin time zone, V8 runtime, web-app deployment settings) |
| GitHub `index.html` (now `legacy/index-v1.html`) | Legacy frontend; **dead** against the current backend (`?function=` is not routed by v5) |

## 2. Canonical architecture

```
Airline roster calendar (ICS import)
  │ Code.gs  syncWorkToJointCalendar   [daily 05:00] · standbyHourlySync [hourly, only while SB is active]
  ▼
Processed "joint" calendar (single source for everything below)
  ├─ Dashboard.gs  generatePreviousMonthDashboard [1st of month 08:00] · generateMonthlyDashboard
  └─ Web App v5   doGet ?action=getStats | sync | dashboard | dashboardPrev  (no action → v5 HTML UI)
```

The v5 UI calls its own endpoint with `fetch(?action=…)`, so the JSON API is already **hosting-independent**. That is why a static V2 frontend can use it unchanged.

## 3. Global-namespace collisions (Apps Script merges all files into one scope; the last-loaded function wins)

| Symbol | Files | Behaviour differs? |
|---|---|---|
| `doGet` | v5, v2 wrapper, (local dup) | **Yes**: the entire API depends on file load order |
| `getFlightStats` | v5, v2 wrapper, (local dup) | **Yes**: v2 lacks most v5 fields |
| `parseFlightTitle` | v5, v2 wrapper, (local dup) | No |
| `parseFlightInfo` | Code.gs, Dashboard.gs | **Yes**: prefix handling (affects crew-history enrichment) |
| `getAirportName` | Code.gs, Dashboard.gs | **Yes**: output format (affects descriptions and hotel matching) |

The live deployment is inferred to be v5. That can be verified with read-only probes only.

## 4. Frozen backend contracts (unchanged during the V2 redesign)

1. Trigger handlers: `syncWorkToJointCalendar`, `standbyHourlySync`, `generatePreviousMonthDashboard`.
2. `doGet` actions `getStats | sync | dashboard | dashboardPrev`; mutations return `{success, message}`.
3. `getFlightStats` payload: every field (`today`, `daysOff`, `upcoming[]`, `dutyBlock`, `month`, `year`, `allTime`, `map`, `achievements`).
4. Calendar side effects: sync window, source-ID tag, pickup tag, flight title prefix, colour map, reminders, orphan deletion.
5. Description enrichment format; hotel Sheet schema (20 columns); Places key in Script Properties.
6. Dashboard: Drive folder and file naming (overwrite on regeneration), email summary, monthly trigger.
7. Roster title grammar (flight / standby / reserve / pickup / ground-training codes).

## 5. Correctness defects (backend; reported, not fixed in the UI redesign)

| ID | Sev | Defect |
|---|---|---|
| B1 | High | Local arrival and base-reference times are off by the origin's UTC offset (fixed-offset arithmetic formatted as UTC) |
| B2 | High | The month-end hours forecast is inflated: month hours include future rostered flights and are then extrapolated |
| B3 | Medium | Layover days count as days off (busy days are keyed by event start date) |
| B4 | Medium | A flight later today shows "Tomorrow" (`ceil` over milliseconds) |
| B5 | Medium | Outstation departures are shown in the script time zone, labelled as local |
| B6 | Medium | Fixed summer-time offsets; wrong by 1 h against non-DST zones after the DST change |
| B7 | Low | A pickup is matched to a flight by calendar date; a pickup before midnight is lost |
| B8 | Low | Client weather is indexed by days-until and clamped to forecast day 10 |
| B9 | Low | Server exceptions return HTML instead of JSON |
| B10 | Low | The full history is read on every stats request; crew history is rebuilt on every sync |
| B11 | Low | Live weather in descriptions triggers event rewrites whenever the forecast changes |
| B12 | Medium | Load-order-dependent behaviour (§3) |
| B13 | Low | The current-month dashboard counts future rostered flights as flown |

The V2 presentation layer corrects the *display* of B1, B4, B5, B6 and B8 by computing from timestamps and IANA zones (see `PLAN.md` §B, §H).

## 6. Security and commercialization (summary)

- The backend must be hardened **before V2 becomes the public/live version** (`BACKEND-HARDENING.md`). The details are tracked privately.
- Commercial blockers to resolve later: weather API licence (non-commercial free tier), OSM standard tiles (not for app traffic), Places data-storage terms, third-party personal data in crew history, single-tenant execution model and consumer quotas, airline-specific coupling.

## 7. v5 UI feature inventory

Every item has an explicit V2 destination in `PLAN.md` §C:
- next-duty hero (route, flight number, flag, date, departure, duration, Today / Tomorrow / N days)
- wake-up and pickup with iOS Shortcut alarm links
- hotel search and saved-list links (suppressed at home bases)
- next-OFF and duty-days line
- live dual clocks
- 1 s departure countdown
- duty-block card
- next days off
- flights list (local times, +1, base reference, pickup once per day, hotel link)
- month stats, forecasts and SB/RE breakdown
- all-time totals and records
- this-year stats
- 12 achievements
- route map
- destination weather
- controls (sync, current-month and previous-month reports, saved hotels)
