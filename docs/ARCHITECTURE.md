# Flight Control — architecture

Status labels used below: **[live]** in production · **[branch]** on `v2-redesign` only · **[uncommitted]** working
tree only · **[proposed]** design, not approved or built · **[unverified]** not confirmed by a check.

## 1. System overview [live]

```
Condor duty-plan ICS (host: cube.aero, tokenized URL — never in Git)
   │  subscribed in Google Calendar (Google decides the refresh schedule)
   ▼
SOURCE_CALENDAR_ID  (…@import.calendar.google.com)
   │  v5 trigger syncWorkToJointCalendar, daily 05:00 (+ standbyHourlySync hourly)
   ▼
TARGET_CALENDAR_ID  (joint calendar; sync-tagged copies keep long-term history)
   │
   ▼  Apps Script web app (deployment "untitled", Execute as owner)
   doPost fc.roster v2 (token in body) ── roster: today onward ← SOURCE (live read); before today ← TARGET
   │                                     history ← TARGET; stats = v5 payload; departures ← AeroDataBox
   ▼
Static PWA on GitHub Pages (branch main): src/api/appscript.js → contract-v2.js → fc-appscript-v2.js
   → model/roster.js → screens.  Endpoint + token entered in Settings, kept in device localStorage.
```

Backend files: `backend/apps-script/*.gs` (v2, tracked). v5 source: `reference/apps-script-v5/` (**git-ignored**,
contains personal identifiers). Contract: `docs/CONTRACT-V2.md`.

### Single-user assumptions (relevant to any multi-user work)
Hardcoded calendar/Sheet ids and the sync tag (v5 constants); one shared token `FC_V2_TOKEN`; script-wide failure
counter and caches; `FCV2_CONDOR_CONFIG_` holds the owner's base (FRA), history start and sync title prefix; hotel
Sheet, Places and AeroDataBox keys are the owner's; history exists only because of the owner's v5 sync.

## 2. Frontend data flow [live; offline layer uncommitted]

- Adapter output = one `RosterSnapshot`; screens never read backend payloads directly.
- Airline packs (`src/airlines/`) supply roster codes and wording; `generic` is a wording fallback only.
- [uncommitted, Step 6.6] `src/roster-storage.js` keeps one `fc.v2.roster.v1` record (accepted payload, last sync);
  service worker precache (`npm run build:offline`); sync status and pull-to-refresh. See `docs/STEP-6.6-OFFLINE.md`.

## 3. Calendar data audit (2026-10-14) — what the feed provides

Method: read of the v2 backend, v5 reference, frontend and docs; no live feed sample was read.

| Field | Status | Where / note |
|---|---|---|
| Flight number, dep/arr airport | AVAILABLE | Title `DE<n> AAA-AAA` (`CondorAdapterV2.gs`); only designator `DE` recognised |
| Scheduled dep/arr | AVAILABLE | Event start/end; feed does not label them; no actual times |
| Report time | AVAILABLE (v2) | `C/I` event ≤ 4 h before first departure; shown only as Horizon "Briefing", not in duty/calendar rows |
| Duty end / check-out | NOT AVAILABLE | No code in the feed; app uses last arrival |
| Aircraft type/registration | PARTIALLY | Description line `REG (TYP)` when present; shown on Flights only; frequency unverified |
| Crew names | in raw source, **excluded** | Decision D3; adapter rejects crew lines |
| Layover hotel | PARTIALLY | Fail-closed parse (address/phone dropped unless well-formed); pins only for VERIFIED Sheet rows |
| Pickup | PARTIALLY | `P/U` at outstations only; none at home base |
| Allowances | NOT AVAILABLE | Not in feed or code |
| Rotation ids | NOT AVAILABLE | `capabilities.rotations: false`; frontend derives rotations |
| Positioning `DH/<flight>`, other codes | PARTIALLY | Present, unmapped → `unknown` (I-002) |
| Anything PDF-only | UNVERIFIED | No feed-vs-PDF comparison exists |

Received but not displayed: report time outside Horizon, aircraft outside Flights, unknown-event raw title
(`day.sourceTitle`), `sector.basis`, v5 stats/map/achievements. Feed horizon: a few past days to end of next month.

## 4. Direct ICS feed [PROPOSED; probe PREPARED — NOT EXECUTED]

Problem: Google refreshes the subscribed calendar on its own schedule (delay unmeasured, I-004).

**Source:** Condor roster ICS hosted on `cube.aero` (CUBE). The tokenized URL is a bearer credential. It is kept
outside Git in a private location known to the owner. It must only ever be stored in Script Property
**`FC_DIRECT_FEED_URL`** — never in Git, chat, logs, responses or shell history. Google does not expose a
subscription's source URL through `CalendarApp`.

**Proposed hybrid (P-001):** direct feed for today onward only; Google subscription + synced copy unchanged for
history and fallback; mode `off` | `shadow` | `primary` in a Script Property; on any failure fall back to Google;
contract and frontend unchanged; never cache raw ICS (normalized, allow-listed events only).

**Critical compatibility question:** event identity. Contract ids, synced-copy tags and hotel verification are keyed
on `CalendarEvent.getId()` (the iCalUID). The direct path is viable only if feed `UID` → Google id is a
**deterministic 1:1 mapping** (identity, case, `@google.com` suffix, …). If not → keep Google sync.

**Probe — PREPARED, NOT EXECUTED (2026-10-14).** Lives outside the repo in the private directory
`~/.config/flight-control/feed-probe/` (mode 700): `FeedProbe.gs`, `appsscript.json`, `SETUP.md`,
`feed-probe.test.mjs` (23 offline tests with stubbed Apps Script services, synthetic ICS only). It runs in a
**separate, private, standalone** Apps Script project, never in production. Gates: dated Script Property
`FC_PROBE_AUTHORIZED_UNTIL`, https + `*.cube.aero` allow-list, no credentials in the URL, no redirects followed,
≤ 3 requests per `probeRun`. Reports only counts/booleans/header facts: reachability, ETag/Last-Modified/304,
change-detection stability (DTSTAMP churn), UID ↔ Google-id mapping, current Google staleness. Optional monitor
(30-min trigger, conditional requests, salted hashes, requires a deterministic mapping) measures the real Google
delay. Read-only scopes: `calendar.readonly`, `script.external_request`, `script.scriptapp`.

### 4a. V3 Milestone 2 — live ICS compatibility (2026-10-15) [verified unless marked]

Owner-authorized: owner confirmed automated access is permitted; two one-time read-only GETs of the owner's own feed
(URL kept in a private local file outside Git, never shown); two read-only `roster` POSTs to the v2 backend. Raw feed
held in memory only. Parser: `core/ics/ics.js` (`d9d3706`); interpreter: unchanged `CondorAdapterV2.gs` +
`RosterModelV2.gs` via `tests/gs-harness.js`. Only aggregates were recorded.

| Area | Result |
|---|---|
| Access | HTTP 200 `text/calendar`, ~30 KB, no redirect; **ETag + Last-Modified present** (conditional GET possible) |
| Format | ICS 2.0, `METHOD:PUBLISH`, CRLF, folded lines, valid UTF-8; 77 VEVENTs; **all times UTC**; no VTIMEZONE, TZID, all-day, RRULE, RECURRENCE-ID, SEQUENCE, STATUS, LAST-MODIFIED. Every event: UID, DTSTART, DTEND, DTSTAMP, SUMMARY, DESCRIPTION, LOCATION, CLASS |
| Parser | `ok`, 0 errors, 0 warnings |
| Horizon | about 15 days back to 47 days ahead |
| Interpreter (feed segment, 53 events) | 52/53 recognised (flight, check-in, pickup, standby, OFF/Urlaub/ORT, Strichtag); 1 `SBX` (meaning now D-013, not mapped). 9 sectors, all zones derived, aircraft on all; 9 duties, every C/I and P/U attached; 7 stays with hotel name (address/phone on 1) |
| Privacy | Employee-number tokens present in descriptions; **0 reach the contract** |
| Implications | Change detection must hash content per UID (no SEQUENCE/LAST-MODIFIED); cancellation = disappearance only |
| Backend comparison | **Not obtained.** Both POSTs got HTTP 403 "Zugriff verweigert" (HTML) from `script.google.com` on the first hop, before `doPost` ran (not a token error, no redirect). Local endpoint verified identical to the production deployment URL; owner confirms access "Jeder". Cause **unknown**; investigation deferred (I-010) |
| Production usability | Owner reports the app on the phone loads the roster (2026-10-15). **Not** proof that a fresh backend request succeeded at that time (the app may show its stored offline roster) |

**Still unverified:** (1) Google event id ↔ ICS UID mapping (needs the backend comparison); (2) hotel stay end times —
the validation script read a non-existent field, so the 7 "open-ended" results are a script artifact, not a finding;
(3) field-level parity with the Google-powered output (days, sectors, duties, windows, stays); (4) whether missing
hotel address/phone is absent in the feed or dropped by the fail-closed parser.

## 5. Multi-user onboarding [PROPOSED — not approved, not implemented]

Requirements: per-user accounts and isolation; per-user encrypted roster link; no shared token; per-user history
(the Google synced copy does not exist for new users); SSRF-safe server-side fetching; crew data never stored.
The current Apps Script backend **cannot** isolate users (shared properties/quotas, runs as the owner).

**Flow (three steps):** (1) sign in + choose airline (Condor only; others "not supported yet");
(2) paste roster link → server validates and shows a preview without crew data → confirm; link is write-only
afterwards; (3) personalize: home base (suggested, confirmed), Local/UTC, wake-up offset.

**Sync states:** `active`, `stale` (> 6 h), `unreachable` (backoff), `link-invalid` (401/403/404/410 → reconnect),
`invalid-format` (HTML/login page), `degraded` (unknown-code spike / big drop held for confirmation), `paused`.
A failure never deletes stored data; reconnect keeps history (keyed by user, not link).

**Airline adapter interface (pure):** `{ id, displayName, feed: {kind:'ics-url', hostAllowList, connectSteps,
minRefreshMinutes}, defaults, flightDesignators, rosterCodes, classify(raw, userConfig), validateSample(events) }`.
Reusable unchanged: `CondorAdapterV2.gs`, `RosterModelV2.gs`, roster codes + generator, airport zones, contract v2,
validator, frontend adapter and screens, airline registry, offline layer.

**Needs a separate backend service** (conflicts with D-003 → P-003). Phases: P0 decisions (permission/legal, hosting,
probe results) → P1 shared pure core (byte-identical `.gs` + service builds) → P2 service in shadow for the owner →
P3 onboarding UI + session transport → P4 closed beta → P5 other airlines only with real sample feeds.
