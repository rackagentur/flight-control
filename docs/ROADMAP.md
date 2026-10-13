# Flight Control — roadmap

Status per item: **DONE** (in production on `main`) · **BRANCH** (committed on `v2-redesign`, not live) ·
**IN REVIEW** (uncommitted) · **PREPARED** (built, not executed) · **PROPOSED** (not approved) · **LATER**.
Every step needs the owner's review/approval before commit; any change to `main` is a production deploy.

## Track A — V2 PWA (frontend)

| # | Item | Status |
|---|---|---|
| A1 | V2 static frontend, contract v2 adapter, Today/Calendar/Flights/More/Settings | DONE |
| A2 | Phase 3 departures data + Radar slice 1 (read-only standby window) | DONE |
| A3 | Two-theme restyle Steps 1–5 (tokens, brand base, shell, component foundation) | BRANCH (`be48054`…`97dbea9`) |
| A4 | Step 6 aviation components; Step 6.5 Local/UTC display | BRANCH (`7d1db67`, `7bb7f54`) |
| A5 | Step 6.6 offline-first roster persistence, service worker, sync status, Sign out vs Reset (D-011) | BRANCH (local commit, not pushed; iPhone acceptance prepared: `docs/IPHONE-ACCEPTANCE.md`) |
| A6 | Calendar display preferences D-008 (`STR`→`–`, `LEAVE`→`U`, subdued completed flights) | approved, not implemented |
| A7 | Show report time + aircraft in duty/calendar detail (data already received) | PROPOSED (audit §3) |
| A8 | Step 7 destination/layover; Step 8 theme-color/manifest polish | LATER |
| A9 | Release `v2-redesign` → `main` | LATER (owner approval, regression checklist) |

## Track B — Roster data and backend

| # | Item | Status |
|---|---|---|
| B1 | Backend hardening BH-1/BH-2, contract v2, Condor code table, departures (Version 29 per docs) | DONE |
| B2 | Map remaining live codes (`DH/<flight>` positioning first; `U1`, `SBX`, `HS5`, `EM`, `RE10S`) | PROPOSED (needs meanings, I-002) |
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
