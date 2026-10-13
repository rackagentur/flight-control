# Flight Control — session log

Newest first. One entry per working session (see the checkpoint procedure in `docs/NEXT_STEPS.md`).
Facts only; link to decisions/issues by ID. Never paste URLs with tokens, calendar ids, names or employee numbers.

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
