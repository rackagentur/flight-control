# Flight Control — project status

Last checkpoint: **2026-10-24 — documentation-only release preparation**.
Current release review is [RELEASE-REVIEW.md](RELEASE-REVIEW.md); dated sections below
are historical snapshots, not current deployment claims or instructions.

## 1. Current state

| Area | State and evidence |
|---|---|
| Git | Locally verified `v2.1-dev` at `5a7dd16`, two local documentation commits ahead of recorded origin; no fetch/push in this checkpoint |
| Production frontend | Owner-supplied fetched Git reference `a3008d2`; served commit and device worker adoption not checked |
| Backend | Owner reports active Version 29, displayed 2026-10-07 03:01 (timezone unspecified); editor screenshot is not immutable deployed-source proof |
| Implementation | Crew frontend/backend routing exist. Combined proposal: 15 changed frontend runtime files + six backend files; complete 82-file static tree and all 127 endpoint differences classified in RELEASE-REVIEW |
| Validation | Owner-run S0–S13 passed after S6 sequencing repair; teardown closed. Full suite recorded at `962644f`: 1379 pass, 0 fail, 2 skipped (Node 24.22.1); later owner-focused output 353/0/0 (Node v26.7.0), including hygiene |
| Browser/device | Earlier desktop checks and owner-reported physical acceptance retained; final crew candidate/browser/device approval not established. Recover existing results first |
| Remaining release requirements | Q1 clearance, Q4 execution identity, Q6 sole editor; candidate acceptance; real storage/backfill/timing evidence; baseline and explicit release approvals. See classified checklist |
| Current authorization | Documentation only; review complete diff before any commit. Production **NO-GO**. No tests repeated, production access, feed access, code changes or deployment |

## Historical baseline (2026-10-14 onward)

The next two sections preserve the older functionality/issue ledger. Branch labels, deployment
claims and “not implemented” statements there are historical; consult the current table above.
In particular crew is now implemented, and flight/attribution frontend plus offline foundations
are already represented in `a3008d2`. No product decision is superseded by source presence.

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
- *v2-redesign (local commit):* Step 6.6 offline-first roster persistence, service worker, sync status, pull-to-refresh, Sign out (keeps non-sensitive preferences) vs Reset (removes everything).

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
| I-002 | Unrecognised live-feed codes stay `unknown`: `U1`, `SBX`, `HS5`, `EM`, `RE10S`, `DH/<flight>`, other carriers' flights. **`SBX` meaning confirmed by owner 2026-10-15 (D-013: travel to the standby location before SB; not yet mapped)** | investigated | Owner to confirm meanings (handbook) before mapping; `DH/` (positioning) first |
| I-003 | Flaky test `S6` (token removal vs in-flight load) | **resolved 2026-10-14** | Test waited one `setTimeout(0)` while `runLoad` awaits WebCrypto first; now polls until the request starts |
| I-006 | Service-worker updates wait until every old client closes (no `skipWaiting`); Home Screen app may serve the old shell long after a deploy | known limitation | Release checklist step; "update available" prompt later |
| I-008 | Local branch `backup/v2-redesign-pre-rewrite-20261014` (old hashes `c8b0996`, `bb6c0f5`, `6959311`) kept after the history cleanup; never push it | local only | Delete after the owner confirms the pushed branch (`git branch -D …`) |
| I-009 | A deployed rollback worker reaches a device only through the browser lifecycle: an update check (usually on launch; ≤ 24 h), and in 2 of 30 desktop-Chrome runs a waiting rollback worker needed one relaunch. Rollback artifact `scripts/rollback/sw.js` + procedure prepared and browser-tested, never activated | known limitation | Optional: `registration.update()` on launch/foreground (I-006, app change, needs approval) |
| I-007 | A valid but completely empty roster is refused (shows refresh failure) | known limitation | **Must be resolved before multi-user onboarding** (contract signal "published, no events") |
| I-010 | Read-only `roster` POST from a Node script got HTTP 403 "Zugriff verweigert" (HTML, first hop, before `doPost`) twice on 2026-10-15. Endpoint matches production; access "Jeder"; phone app loads the roster (may be offline copy). Cause unknown | **deferred** (owner) | Revisit only if it blocks an essential milestone; options: browser-equivalent request, Executions log |
| I-004 | Google refreshes the subscribed Condor calendar on its own schedule; delay unmeasured | under investigation (Phase 0) | `docs/ARCHITECTURE.md` §4 |
| I-005 | v5 sync still scans event title+description for colleagues' employee numbers ("colleague history", v5 `Code.gs`); V2 never reads it (D3) | known, out of scope | Owner decision whether to retire in v5 |

## 4. Where to find things

- Plan and approved decisions: `docs/PLAN.md`, `docs/DECISIONS.md` (index + newer decisions)
- Contract and data gaps: `docs/CONTRACT-V2.md`, `docs/DATA-GAPS.md`, `docs/PARITY-V2-V5.md`
- Backend deploy log/rollback: `backend/apps-script/README.md`, `docs/BACKEND-HARDENING.md`
- Architecture, calendar audit, proposals: `docs/ARCHITECTURE.md`
- iPhone acceptance plan: `docs/IPHONE-ACCEPTANCE.md`
- Next actions and checkpoint procedure: `docs/NEXT_STEPS.md`
- Roadmap and session history: `docs/ROADMAP.md`, `docs/SESSION_LOG.md`
- Private, git-ignored: `reference/` (v5 Apps Script with personal identifiers). Never copy from it into tracked files.


## 2026-10-15 — final release handover checkpoint

Final handover verification: v2-redesign d9d3706; gate/attribution uncommitted; 918/918 full tests and offline integrity passed (73 assets). Browser readiness failed twice (active/cached worker, uncontrolled page). Newer public synthetic preview is deployed but predates gates/attribution. Physical iPhone acceptance remains unverified. See FINAL-RELEASE-HANDOVER.md; earlier state-table counts and "nothing deployed" statements are historical.


## 2026-10-15 — release prerequisites follow-up

IMPLEMENTED locally: first-install worker-control recovery and synthetic gate/Radar fixture responses. Verified 923/923 automated tests, 73 shell assets, desktop offline/protected/subpath/update/rollback checks. Labels - / U verified unchanged. Isolated-preview candidate ready for review; remote backend compatibility/publication approval and physical-iPhone acceptance outstanding. Production NO-GO; no commit/push/deploy or production operation. See RELEASE-PREREQUISITES.md.


## 2026-10-16 — iPhone layout remediation (local only)

Local iPhone layout remediation: Flight Detail time values no longer inherit browser definition-list indentation; narrow columns, status and credit wrap without clipping. A theme-matched top-inset cover protects scrolled content. Physical owner reports gates/terminals/revised times/credit working, Radar succeeding after an error with 15–20 s loading. Screenshots were not attached to this remediation request. Corrections are local only; physical Safari/Home Screen recheck and remaining acceptance are pending. Production remains NO-GO.


## 2026-10-16 — local service-worker diagnostics

IMPLEMENTED locally: More → Settings → About now observes the controlling worker build, control status, waiting update and combined offline readiness. No worker lifecycle changes. Final local build 882166161364bd0a9c0f; 74 shell assets; 940/940 tests passed, including 11 new diagnostics tests. Desktop browser verified uncontrolled-to-controlled transition, waiting update distinct from controller, and normal adoption after client closure. Mobile-width light/dark checks passed. Physical iPhone adoption and STR diagnosis remain unverified. Not published; production NO-GO.


## 2026-10-16 — responsive-layout follow-up (local only)

Responsive follow-up IMPLEMENTED and verified locally: narrow timing rows wrap into separate time/label/countdown/note lines; timeline labels fit measured pixel bounds with next-stop priority and retain all stops plus the full accessible summary; hotel name/address are separated and wrap. UTC timeline badge reserves its own row. Local candidate worker: d34c49e1c3955d525def, 74 verified assets. Full regression: 945/945; browser matrix: 24/24 cases, 408/408 assertions (375/393px, 100/125/200% root text, light/dark, Local/UTC). Calendar mappings, timestamps, backend, authentication and safe-area implementation unchanged. No publication in this session. Physical-device acceptance is pending; production remains NO-GO.


## 2026-10-16 — durable sign-out correction (local only)

IMPLEMENTED locally: durable sign-out now checks the persisted marker, retries after roster cleanup, and removes the endpoint if marker persistence remains unavailable. Persistent failures are reported; the current page remains signed out through refresh/reconnect/storage events. Normal preferences and successful reset semantics remain unchanged. Full regression 954/954; local worker 807357dcd3bb9ef3e92e, 74 assets. Owner reports prior physical-device acceptance passed; this new correction is not published or physically accepted. Production remains NO-GO.


## 2026-10-24 — Crew Intelligence Phase 1d.2C: isolated live-service validation

Owner-run, owner-reported, on `v2.1-dev` (test package last changed in `962644f`). Two isolated Apps Script projects (FC-TEST Crew API, read-only calendar scope; FC-TEST Seeder, the only write scope) and two synthetic calendars, in the owner's existing Google account. Results: 18 + 57 synthetic events seeded; S0–S5 and S13 7/7; schedule change applied once; S6 1/1 after a baseline repair; S7–S12 6/6 (S9 refusal and deletion, S10 malformed state, S12 7 guard cases); cleanup deleted 75 and kept 0. The first S6 failure (`time-moved`) was an execution-sequencing error (a second `fctRunSmoke` after the schedule change overwrote the S5 baseline), not a verified Crew API defect. Teardown complete (owner-reported): repair function and `FCT_SEED_CONFIRM` removed; both test calendars and both temporary Apps Script projects deleted; both OAuth authorizations revoked; generated `~/fc-gas-test-package` removed; local filename scans found no matching temporary credential files; clipboard cleared with Terminal output provided. Filename scans are limited evidence, not proof that all credential copies are absent. See `docs/CREW-GAS-TEST-SETUP.md` §13.3. Several earlier UNVERIFIED platform assumptions are now observed working; others remain open (`docs/CREW-GAS-TEST-SETUP.md` §13). Automated tests at `962644f`: full suite 1379 pass, 0 fail, 2 skipped on Node 24.22.1 (Node 22 lacks `navigator.locks`; see `CLAUDE.md`). No production deployment, production-calendar change or production Script Property change. **Production remains NO-GO.**

## 2026-10-24 — Reconciled crew release-readiness checkpoint

Historical reconciliation baseline: `v2.1-dev` at `3c9e6a3` before that
documentation update; clean working tree, one commit ahead of origin.
Owner-provided output after fetching origin identifies `origin/main`
as `a3008d2`. This verifies the Git reference, not the currently served
frontend or installed Apps Script version.

Confirmed evidence:
- Crew frontend, runtime, credentials and backend routing exist in source.
- Claude Cloud committed and pushed validation documentation as `e7d98b6`.
  Its supplied final report explicitly retained production NO-GO.
- Owner-run S0–S13 passed after the documented S6 sequencing correction.
- Teardown is complete as owner-reported and documented in `3c9e6a3`,
  including clipboard cleanup and the limited filename-scan evidence.
- Owner-provided focused test output: Node v26.7.0, 353 passed,
  0 failed, 0 skipped, including repository hygiene. This was not a
  full-suite or browser run. No repeat is required merely for these docs.
- Direct tree comparison `origin/main HEAD` reports 127 changed files,
  27,617 insertions and 192 deletions. This includes crew work and other
  backend, offline, parser, tooling, test and documentation changes.
  It is an inventory, not an approved production release scope.

Older statements that no crew frontend exists are historical and stale.
Passing tests establish only their exercised scope. Production remains NO-GO.

## 2026-10-24 — Backend baseline and proposed release scope

Owner reports the existing production web-app deployment is Version 29,
dated 2026-10-07 at 03:01 as displayed; timezone unspecified.
This is owner-confirmed, not independently inspected deployment metadata.

The supplied editor screenshot shows DeparturesV2.gs present and
FlightInfoV2.gs, CrewCoreV2.gs, CrewCondorV2.gs and CrewApiV2.gs absent.
Editor contents are not proof of the immutable Version 29 source snapshot.
No source, properties, triggers or deployment settings were changed.

Version 29 is the recorded web-app deployment rollback reference.
Rolling back the versioned web app must not be treated as restoring editor
source or trigger execution. Preserve the editor baseline separately before
any future authorized source changes.

The proposed six-file backend update is recorded in
backend/apps-script/README.md under the matching dated heading.
Exact production source parity and the final release selection remain open.
Production remains NO-GO.
