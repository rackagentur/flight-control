# Flight Control — roadmap

Current checkpoint (2026-10-24): Crew frontend/backend are implemented on `v2.1-dev`;
isolated validation and teardown are closed. The combined release is **PROPOSED**, not approved.
See [RELEASE-REVIEW.md](RELEASE-REVIEW.md) for the exact inventory and outstanding gates.
The tables and dated entries below preserve earlier milestone snapshots; their old branch/live
labels are not current deployment evidence. No new feature milestone is authorized.

Historical status per item: **DONE** (in production on `main`) · **BRANCH** (committed on `v2-redesign`, not live) ·
**IN REVIEW** (uncommitted) · **PREPARED** (built, not executed) · **PROPOSED** (not approved) · **LATER**.
Every step needs the owner's review/approval before commit; any change to `main` is a production deploy.

## Track A — V2 PWA (frontend)

| # | Item | Status |
|---|---|---|
| A1 | V2 static frontend, contract v2 adapter, Today/Calendar/Flights/More/Settings | DONE |
| A2 | Phase 3 departures data + Radar slice 1 (read-only standby window) | DONE |
| A3 | Two-theme restyle Steps 1–5 (tokens, brand base, shell, component foundation) | BRANCH (`be48054`…`97dbea9`) |
| A4 | Step 6 aviation components; Step 6.5 Local/UTC display | BRANCH (`7d1db67`, `7bb7f54`) |
| A5 | Step 6.6 offline-first roster persistence, service worker, sync status, Sign out vs Reset (D-011) | BRANCH (pushed `c999cef`; iPhone preview tooling ready, not deployed; acceptance not started) |
| A6 | Calendar display preferences D-008 (`STR`→`–`, `LEAVE`→`U`, subdued completed flights) | approved, not implemented |
| A7 | Show report time + aircraft in duty/calendar detail (data already received) | PROPOSED (audit §3) |
| A8 | Step 7 destination/layover; Step 8 theme-color/manifest polish | LATER |
| A9 | Release `v2-redesign` → `main` | LATER (owner approval, regression checklist) |

## Track B — Roster data and backend

| # | Item | Status |
|---|---|---|
| B1 | Backend hardening BH-1/BH-2, contract v2, Condor code table, departures (Version 29 per docs) | DONE |
| B2 | Map remaining live codes (`DH/<flight>` positioning first; `U1`, `SBX`, `HS5`, `EM`, `RE10S`) | PROPOSED (needs meanings, I-002; `SBX` meaning confirmed, D-013 — in next implementation milestone) |
| B3 | B2-sync: v5 05:00 sync `DEADLINE_EXCEEDED` | open (owner reads Executions log) |
| B4 | Calendar data audit | DONE 2026-10-14 (`docs/ARCHITECTURE.md` §3) |
| B5 | Direct ICS probe | PREPARED — NOT EXECUTED (`~/.config/flight-control/feed-probe/`, 23/23 offline tests) |
| B6 | Hybrid ICS architecture P-001 | PROPOSED (depends on B5 results + permission) |
| B7 | Optional feed-vs-PDF comparison for one month (resolves UNVERIFIED fields) | PROPOSED |

## Track C — Multi-user product

| # | Item | Status |
|---|---|---|
| C0 | Decisions: permission/legal, hosting (P-003 vs D-003) | OPEN — owner |
| C1 | Shared pure core (one source → `.gs` + service), byte-identical tests | PROPOSED |
| C2 | Hosted service, owner-only shadow mode with parity vs Apps Script | PROPOSED |
| C3 | Three-step onboarding UI + session transport + sync states | PROPOSED |
| C4 | Closed Condor beta | PROPOSED |
| C5 | Further airlines (only with real sample feeds + documented codes) | LATER |


## 2026-10-15 — final release handover checkpoint

A6 wording portion is committed in 714326e: ASCII - / Strichtag and U / Urlaub (D-012); do not reimplement it or infer completion of subdued completed-flight styling. Gates and attribution are implemented but uncommitted. A5/A9 remain blocked on browser readiness and physical acceptance. The current public synthetic preview lacks gates/attribution. See FINAL-RELEASE-HANDOVER.md.


## 2026-10-15 — release prerequisites follow-up

Release prerequisites IMPLEMENTED locally: worker control-race recovery; synthetic flight/departures acceptance fixtures. Desktop and automated verification PASS (923 tests, 73 assets). Physical-iPhone acceptance and approved isolated publication remain pending; production remains NO-GO. No new phase/feature scope started. See RELEASE-PREREQUISITES.md.


## 2026-10-16 — iPhone layout remediation (local only)

iPhone acceptance: IN PROGRESS, with owner-reported gate/terminal/time/credit success and intermittent Radar loading. Layout corrections IMPLEMENTED locally, pending isolated publication approval and physical-device retest. Production remains blocked by unfinished acceptance; no Step 6.7 work.


## 2026-10-16 — local service-worker diagnostics

IMPLEMENTED locally: read-only worker diagnostics under More → Settings → About for Step 6.6 acceptance. Isolated publication awaits approval; physical iPhone acceptance and production release remain blocked. No later milestone started.


## 2026-10-16 — responsive-layout follow-up (local only)

Responsive timing, rotation-label and hotel-formatting corrections: IMPLEMENTED locally, automated/browser verification complete. Isolated-preview publication awaits separate approval; physical-iPhone acceptance remains IN PROGRESS. Production release stays NO-GO until corrected layout and remaining device checks pass. No Step 6.7 work.


## 2026-10-16 — durable sign-out correction (local only)

Step 6.6 durable-sign-out correction: IMPLEMENTED locally and regression-verified. Publication approval and sign-out/reset acceptance remain pending; prior physical layout acceptance is owner-reported passed. Production remains NO-GO. No later milestone started.

## 2026-10-24 — Reconciled crew release-readiness checkpoint

Crew implementation and isolated live-service validation have reached the
release-preparation milestone. Phase 1d.2C teardown is documented as complete.
Current work is documentation reconciliation and release-scope definition.
Production release remains NO-GO. No new feature milestone has been approved.
