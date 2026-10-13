# Flight Control — project status

Last checkpoint: **2026-10-14** (Claude Code session). Re-check anything below before relying on it; prefer the
commands over the copied values. "Verified" means checked on that date with the stated method; "Unverified" means
taken from notes or docs and not re-checked.

## 1. Where things stand

| Area | State | How to re-check |
|---|---|---|
| Production frontend | GitHub Pages serves branch **`main`** (`/`). Any merge/fast-forward of `main` is a production change. `origin/main` = `0ae7d58` (Radar slice 1 + airport fix) — verified 2026-10-14 | `git log -1 origin/main`, `gh api repos/{owner}/{repo}/pages` |
| Development branch | **`v2-redesign`**, 7 commits ahead of `origin/main` and **not pushed** (two-theme restyle Steps 1–6.5: `be48054` … `7bb7f54`) — verified 2026-10-14 | `git log --oneline origin/main..v2-redesign` |
| Uncommitted work | **Step 6.6 offline-first persistence**: 25 files modified/untracked in the working tree, under review, not committed (`docs/STEP-6.6-OFFLINE.md`) — verified 2026-10-14 | `git status --short` |
| Tests | `npm test`: 763/763 pass on the 2026-10-14 tree (incl. uncommitted 6.6). **Flaky:** `S6` in `tests/token-removal.test.js` failed once ("the pre-removal live read is in flight"), passed on rerun — see I-003 | `npm test` |
| Backend (Apps Script) | Contract fc.roster v2 installed privately; docs state **Version 29** (departures action), rollback Version 27, pre-v2 baseline 22. Live deployment **unverified** by agents (private) | `backend/apps-script/README.md`, `docs/BACKEND-HARDENING.md`; ask the owner |
| Current phase | Two-theme restyle, **Step 6.6 review**. Step 7 (destination/layover) not started. In parallel: **Phase 0 of the direct ICS feed investigation** (preparation only) and **proposals** for multi-user onboarding (not approved) | `docs/NEXT_STEPS.md` |
| Direct ICS probe | **PREPARED — NOT EXECUTED.** Private, outside Git: `~/.config/flight-control/feed-probe/`; offline tests 23/23 (2026-10-14); three independent review rounds, last verdict PASS_WITH_NOTES, final two fixes self-tested only. No request to the feed has ever been made by an agent | `cd ~/.config/flight-control/feed-probe && node --test feed-probe.test.mjs` |
| Onboarding / multi-user | **PROPOSED — not approved, not implemented** (`docs/ARCHITECTURE.md` §5) | — |
| Unresolved owner decisions | **Permission** for automated feed access (unknown); **hosting** for a multi-user service (P-003 vs D-003) | `docs/NEXT_STEPS.md` §3 |

Other local branches (`airline-registry`, `phase3-departures`, `radar-airport`, `radar-slice`) are merged history or
worktrees; local `main` is stale (`c085cdf`) — use `origin/main`.

## 2. Existing, verified functionality (in code and tests)

On `main` (production) unless marked *v2-redesign* or *uncommitted*:

- **Screens:** Today (Duty Horizon), Calendar (month overview + day detail), Flights (rotations, sector detail,
  "Seen on this device" history), Radar (read-only flights in the rostered standby window), More / Settings / Controls.
- **Roster contract v2** (`docs/CONTRACT-V2.md`): token-protected `doPost` with `capabilities`, `roster`, `history`,
  `stats`, `departures`; v5 `getStats` fallback. Frontend adapter `src/sources/fc-appscript-v2.js`.
- **Condor roster codes** by exact symbol (`src/airlines/condor/roster-codes.js` → generated `CondorCodesV2.gs`);
  unknown codes stay `unknown`, never guessed.
- **Data from the calendar feed** (see `docs/ARCHITECTURE.md` §3): flight number, airports, scheduled times, report
  (C/I), outstation pickup (P/U), standby/reserve windows, OFF/leave/ORT/Strichtag, hotel block (fail-closed),
  aircraft line when present.
- **Airline registry** (`src/airlines/`): Condor pack + neutral generic fallback; core carries no airline wording.
- *v2-redesign:* brand Light/Dark theme (tokens + contrast tests), shell, component foundation, aviation components,
  Local/UTC time display (`src/lib/op-time.js`).
- *uncommitted:* Step 6.6 offline-first roster persistence, service worker, sync status, pull-to-refresh.

Not implemented (do not describe as existing): direct ICS feed access, multi-user accounts/onboarding, allowances,
duty end/check-out, crew data (excluded by decision D3), rotation ids, the calendar display preferences in
`docs/DECISIONS.md` D-008.

## 3. Open issues

| ID | Issue | Status | Next step |
|---|---|---|---|
| **B2-sync** | The 05:00 v5 trigger `syncWorkToJointCalendar` hit `DEADLINE_EXCEEDED` (480 s) after its calendar writes finished (noted 2026-10-05). **ID collision:** `docs/AUDIT.md` uses `B2` for a different defect (inflated month-end hours forecast). Unverified whether still occurring | open, unverified | Owner: read the Apps Script *Executions* log for recent 05:00 runs; then decide (no sync change without approval) |
| B2 (AUDIT) | Month-end hours forecast inflated by future rostered flights (v5 stats) | open, known-issue marker shown | Later cleanup (`docs/BACKEND-HARDENING.md` "Later") |
| B3 | Monthly dashboard to re-check on **2026-11-01** | pending date | Owner check after 1 Nov |
| I-001 | `README.md` status block stale on `main` (says V2 not live). The working tree's README is part of the uncommitted 6.6 change | open | Update with the next approved docs/frontend commit |
| I-002 | Unrecognised live-feed codes stay `unknown`: `U1`, `SBX`, `HS5`, `EM`, `RE10S`, `DH/<flight>`, other carriers' flights | investigated | Owner to confirm meanings (handbook) before mapping; `DH/` (positioning) first |
| I-003 | Flaky test `S6` (token removal vs in-flight load) on the 6.6 tree | new 2026-10-14 | Investigate before committing 6.6 (timing-dependent assertion) |
| I-004 | Google refreshes the subscribed Condor calendar on its own schedule; delay unmeasured | under investigation (Phase 0) | `docs/ARCHITECTURE.md` §4 |
| I-005 | v5 sync still scans event title+description for colleagues' employee numbers ("colleague history", v5 `Code.gs`); V2 never reads it (D3) | known, out of scope | Owner decision whether to retire in v5 |

## 4. Where to find things

- Plan and approved decisions: `docs/PLAN.md`, `docs/DECISIONS.md` (index + newer decisions)
- Contract and data gaps: `docs/CONTRACT-V2.md`, `docs/DATA-GAPS.md`, `docs/PARITY-V2-V5.md`
- Backend deploy log/rollback: `backend/apps-script/README.md`, `docs/BACKEND-HARDENING.md`
- Architecture, calendar audit, proposals: `docs/ARCHITECTURE.md`
- Next actions and checkpoint procedure: `docs/NEXT_STEPS.md`
- Roadmap and session history: `docs/ROADMAP.md`, `docs/SESSION_LOG.md`
- Private, git-ignored: `reference/` (v5 Apps Script with personal identifiers). Never copy from it into tracked files.
