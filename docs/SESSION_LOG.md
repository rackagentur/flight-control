# Flight Control — session log

Newest first. One entry per working session (see the checkpoint procedure in `docs/NEXT_STEPS.md`).
Facts only; link to decisions/issues by ID. Never paste URLs with tokens, calendar ids, names or employee numbers.

## 2026-10-15 (latest) — Claude Code: Condor display terminology (D-012)

- Read-only audit first: classification of `-` (unassigned) and `U` (off/leave) correct in every layer; display wrong
  (`STR` / `LEAVE`). Then implemented D-012 in the Condor pack and pack-driven UI: calendar cell/key, 7-day strip,
  Today titles + descriptions. Generic pack unchanged; no backend, contract or classification change.
- Tests: 10 pinned assertions in 4 test files updated to the approved wording (lone-dash rule kept absolute for generic, restricted
  to the code elements for Condor); new `tests/condor-display.test.js` (7 tests; 4 fail against the old code).
- `sw.js` rebuilt (precached `profile.js` and UI files changed). Committed locally (not pushed); nothing deployed.

## 2026-10-15 (later) — Claude Code: release safety (rollback worker, Pages subpath)

- Added `scripts/rollback/sw.js` (self-removing worker: deletes only `fc-shell-*` caches, unregisters its own
  scope, reloads windows; no fetch handler, no storage access) and the emergency procedure in
  `docs/STEP-6.6-OFFLINE.md`. Not activated, not deployed.
- New tests: `tests/rollback-worker.test.js` (unit) and `tests/browser/rollback-subpath.mjs` (desktop Chrome under
  `/flight-control/` + rollback to the real `0ae7d58` tree; synthetic data; neighbour same-origin app at `/roadmap/`).
- Found (documented as I-009): the update check on launch is not guaranteed, and in 2 of the final 30 runs the
  installed rollback worker stayed waiting despite `skipWaiting()` until one relaunch. The test models launch → up
  to 3 `update()` calls → up to 2 relaunches and fails otherwise; final 30/30 pass (28 on launch, 2 after one relaunch). Three test-harness bugs fixed (async predicates passed to
  `waitForFunction`; readiness wait across navigations; reload before the worker was active).
- Committed locally (not pushed); nothing deployed; no production access.

## 2026-10-15 — Claude Code: isolated preview deployment

- Vercel project `flight-control-preview` created; SSO protection disabled for it only (other projects untouched,
  `flight-control-step66-preview` still SSO-protected). Staged 70 files from the clean tree @ `53850e0` and deployed;
  the first CLI deployment became the project's own production target (alias `flight-control-preview.vercel.app`).
- Verified: 200 + `no-cache` for `/`, `index.html`, `sw.js`; `noindex`; 8 non-allowlisted paths 404 (docs, reference,
  tests, backend, scripts, package.json, .git, vercel.json); served bytes equal the repo; headless Chrome (phone
  viewport): service worker active, 68 cached entries, no page errors, no third-party requests.
- Production unchanged: Pages source `main` @ `0ae7d58`, served `controller.js` equals `origin/main`.
- Synthetic backend + throwaway token generated in `~/.config/flight-control/test-backend/` (private); Apps Script
  setup needs the owner (no clasp). `53850e0` and this docs commit are local only.

## 2026-10-14 (final) — Claude Code: history cleanup, push, iPhone preview tooling

- History cleanup (unpublished commits only; no remote ref, tag, fork, PR, other branch or worktree contained them):
  `c8b0996` → `7c6488a`, `bb6c0f5` → `c999cef`, `6959311` → `5db9381`; the seven earlier commits unchanged. Final tree
  byte-identical to `6959311`; the credential-location line removed from history. Backup: local branch
  `backup/v2-redesign-pre-rewrite-20261014` (I-008).
- Checks before push: `npm test` 766/766, repo hygiene 5/5, `build-offline --check` current; scan of all 6,128
  added lines in the 10 commits: 0 generic hits, 0 of 7 exact production values.
- **Pushed** `v2-redesign` `0ae7d58..5db9381` (fast-forward, no force). `origin/main` still `0ae7d58`; Pages source
  `main`; backup branch not pushed.
- Preview tooling (local commit, not pushed): `scripts/preview/stage.mjs`, `scripts/preview/gen-test-backend.mjs`,
  `tests/preview.test.js` (8 tests); setup steps in `docs/IPHONE-ACCEPTANCE.md`. Nothing deployed.

## 2026-10-14 (latest) — Claude Code: iPhone acceptance preparation

- Verified: `v2-redesign` @ `bb6c0f5`, clean tree; `origin/v2-redesign` = `origin/main` = `0ae7d58`; push would be a
  fast-forward of 9 commits; branch unprotected; only workflow is Pages build for `main`; repo is public.
- Scanned unpushed commits: no credentials/ids; reworded two lines that named where the feed credential is kept.
- iPhone plan `docs/IPHONE-ACCEPTANCE.md`: staged Vercel preview (separate project) + synthetic Apps Script test
  backend; run sheet of 12 checks. Nothing pushed or deployed; awaiting approval.

## 2026-10-14 (later) — Claude Code: Step 6.6 completion audit and final corrections

- Audit: no product/security defect; blocker was the S6 test (failed 40/40 in isolation: one `setTimeout(0)` vs the
  WebCrypto `sourceIdentity()` await before the request) plus an assertion on legacy keys only.
- Owner decisions D-011 implemented: Sign out keeps non-sensitive preferences, removes `name`/`hotelListUrl`;
  Reset removes everything; token change purges previous-source data (already correct, now tested).
  Settings copy distinguishes Sign out from Reset. `sw.js` regenerated.
- Tests: S6 file 30× → 0 failures; in-flight test alone 30× → 0; `npm test` 5× → 766/766; `build-offline --check`
  current; desktop browser harness 15/15 (system Chrome, installed Playwright, synthetic, localhost).
  Unverified: physical iPhone/Home Screen, Safari.
- Known limitations recorded: I-006 service-worker update latency, I-007 empty roster (before multi-user).
- One local Step 6.6 commit on `v2-redesign`; not pushed, not merged, no deploy, no feed access.

## 2026-10-14 — Claude Code: calendar audit, direct-feed Phase 0, onboarding proposal, continuity docs

- Branch `v2-redesign` @ `7bb7f54`; Step 6.6 uncommitted in the working tree (untouched this session).
- **Calendar data audit** (read-only): field availability recorded in `docs/ARCHITECTURE.md` §3 (D-009).
- **Direct ICS investigation**: no feed URL in the repo; Google does not expose it; source is CUBE (`cube.aero`).
  Recommendation P-001 (hybrid, conditional). Owner approved Phase 0 for preparation only (D-010).
- **Probe PREPARED — NOT EXECUTED**: moved from the temporary scratchpad to `~/.config/flight-control/feed-probe/`
  (private, mode 700, outside Git; checksums verified). Independent review rounds:
  1. PASS_WITH_NOTES — gate/privacy/read-only OK; 2 major + 6 minor issues (monitor, BOM, all-day, scopes) → fixed.
  2. FAIL — 6/8 fixes confirmed; new N1 (Calendar failure blinded the monitor), N2 (0-min deletion samples),
     N3 (stale mapping), N4 (old state), N5 (doc) → fixed.
  3. PASS_WITH_NOTES — all confirmed; remaining: 0-min samples after gaps, mapping kept on early stops → fixed
     (resync after gaps/restart; mapping cleared at every `probeRun`). **These last fixes are self-tested only.**
  Offline tests 23/23. Not verifiable offline: real Apps Script/CUBE behaviour, `getId()` format, read-only scope.
- **Onboarding architecture PROPOSED** (P-002) — requires a separate backend (P-003, challenges D-003).
- Owner-approved calendar display preferences recorded as D-008 (not implemented).
- Issues logged: B2-sync ID collision with AUDIT B2, flaky test I-003, Google refresh delay I-004, v5 colleague
  number scan I-005.
- `npm test` 763/763 (one flaky failure of S6 on the first run).
- Created `docs/PROJECT_STATUS.md`, `docs/NEXT_STEPS.md`, `docs/DECISIONS.md`, `docs/ROADMAP.md`,
  `docs/SESSION_LOG.md`, `docs/ARCHITECTURE.md`, `CLAUDE.md`, `AGENTS.md`. No production change, no deploy,
  no feed access.


## 2026-10-15 — final release handover checkpoint

Codex final handover: read Claude's existing reports and current Git/preview metadata; preserved all pre-existing content. Full suite 918/918, check:offline current, diff check passed. Desktop offline harness failed twice at initial controller readiness despite 73 cached assets; no fix attempted. Verified Condor labels in source/tests and the public preview profile. Staged 75 files locally outside Git; prepared the release/device checklist. No production roster/feed/provider request, credential output, code change, commit, push or deployment.


## 2026-10-15 — release prerequisites follow-up

Continued v2-redesign @ d9d3706, preserving existing uncommitted work. Deterministically reproduced activated-but-uncontrolled startup during navigation, added bounded claim recovery and regression. Prepared synthetic flight/Radar scenarios via real handlers with no live bindings or credentials. Full suite 923/923; 73-asset integrity, normal/protected offline, root/subpath race, A→B update and rollback PASS. Local artifacts and detailed findings in RELEASE-PREREQUISITES.md. Physical iPhone and remote publication remain pending. No commits, pushes, deployments, provider calls, production or authentication-setting changes.


## 2026-10-16 — iPhone layout remediation (local only)

Owner-reported iPhone 13 mini findings investigated locally. Added a network-free browser regression fixture using the actual Flight Detail renderer/styles; reproduced arrival-column overflow at 375 px. Corrected scoped CSS and regenerated offline shell. Radar investigation reused recorded HTTP evidence and local generated-backend timing; no new remote/provider requests or changes. No commit, push or deployment. Detailed measurements and screenshots retained outside the repository.


## 2026-10-16 — local service-worker diagnostics

Implemented local About diagnostics and 11 focused regression tests. npm run build and npm run check passed; npm test 940/940, no failures/skips. Local browser showed intermediate controller e4677d59595445558f27 with a distinct waiting update, then final controller 882166161364bd0a9c0f after normal client closure/reopen. No saved roster in this browser: diagnostics correctly withheld offline readiness. Verified 375px light / 393px dark layout without horizontal overflow. Existing dirty tree preserved; no backend, credential, provider, remote, commit, push or deployment operation. Physical-device testing remains owner-only.


## 2026-10-16 — responsive-layout follow-up (local only)

Approved local responsive follow-up implemented on v2-redesign, HEAD d9d3706, preserving existing dirty work. Used the prior iPhone investigation report. Changed components/screens CSS, destination/horizon views and screen mount cleanup; added focused hotel/pixel-fit/observer-cleanup tests plus a network-free browser matrix. Full tests 945/945; build/check pass with 74 assets and worker d34c49e1c3955d525def. Browser 24 cases / 408 assertions pass at 375/393px and 100/125/200% root text, both themes and Local/UTC; visual checks and live resize also performed. Synthetic fixtures only, no provider requests or remote changes. No commit/push/deploy. Physical-iPhone testing and release approval remain outstanding.


## 2026-10-16 — durable sign-out correction (local only)

Corrected the confirmed unchecked sign-out marker on v2-redesign at d9d3706. Added nine synthetic fault/restart/race regressions; six failed against the pre-fix implementation. Focused checks 202/202 and full regression 954/954 passed. Regenerated static manifest: worker 807357dcd3bb9ef3e92e, 74 assets; worker lifecycle source unchanged. Retained all unrelated working-tree changes. No browser session, real credential, backend, provider or production resource accessed; no commit/push/deploy. Separate publication approval and sign-out/reset device acceptance remain required.
