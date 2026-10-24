# Flight Control — next steps

Last updated: **2026-10-24**. Current checkpoint: documentation review only.

## 1. Next owner decision

**Select the combined crew + single-flight-information + attribution scope in
[RELEASE-REVIEW.md](RELEASE-REVIEW.md), or request a separately reviewed crew-only proposal.**
Review the complete documentation diff first. Scope selection is not permission to commit,
push, deploy, change properties/triggers, access the feed or process real crew data.

## 2. Release follow-up after scope selection

Use RELEASE-REVIEW's classified checklist and exact inventory. Recover existing crew UI/device
acceptance and aggregate storage/backfill/timing results before proposing tests. Resolve Q1/Q4/Q6;
confirm served frontend and backend/editor rollback baselines privately. Then agree any missing
acceptance work separately. Frontend release precedes a separately authorized backend update.
Completed isolated S0–S13 validation and teardown stay closed; do not recreate test infrastructure.

## 3. Other work remains outside this release

Direct ICS ingestion, multi-user hosting/onboarding, unmapped codes, duty-end/allowances and
later product milestones are not added by this checkpoint. The B3 monthly dashboard check remains
after 2026-11-01. Historical owner queues below are not new authorization.

## 4. Session-end checkpoint procedure (every substantial session)

For this documentation-only checkpoint, the owner explicitly requires no repeat tests and no commit.
Those constraints override steps 2, 7 and 8 below; use existing test evidence and `git diff --check`.
Do not add a decision entry unless changing a decision or recording a clearly labelled proposal.

1. `git status --short` and `git log --oneline -5`: note branch, HEAD, uncommitted files.
2. Run `npm test`; record pass/fail counts and any flaky test.
3. Update `docs/PROJECT_STATUS.md` (state table, open issues) — mark anything not re-checked as unverified.
4. Update `docs/NEXT_STEPS.md` (next approved action, owner queue).
5. Add decisions/changes to `docs/DECISIONS.md` (new entry that names what it supersedes; never edit history away).
6. Add a dated entry to `docs/SESSION_LOG.md`; adjust `docs/ROADMAP.md` statuses.
7. Scan for secrets before committing: `npm test` (repo-hygiene test) and no URLs with tokens, calendar ids,
   names or employee numbers in the diff.
8. Commit **only** the documentation files (explicit paths), never unrelated work in progress. Push only with approval.


## Historical next-action snapshots

These entries retain their original context; §§1–3 above are the current next action.

## 2026-10-15 — final release handover checkpoint

Next release action: diagnose the reproduced browser readiness failure and prepare synthetic flight/departures responses, then seek approval for the current candidate preview. Owner must review attribution visuals, approve V2 release scope, and complete device acceptance. No commit, push, deployment or production change is authorized by this handover. See FINAL-RELEASE-HANDOVER.md for the ordered release gates.


## 2026-10-15 — release prerequisites follow-up

Approved local readiness/fixture preparation is complete. Next owner approval: review the candidate and choose the existing synthetic backend/preview target with an explicit token-property compatibility plan. No automatic project creation, credential change, backend publication or frontend upload. Then separately approve isolated publication and complete physical-iPhone acceptance. Keep the frontend-first production sequence in FINAL-RELEASE-HANDOVER.md. See RELEASE-PREREQUISITES.md for evidence.


## 2026-10-16 — iPhone layout remediation (local only)

Next: owner reviews local mobile-layout correction and separately approves isolated frontend publication, then repeats iPhone 13 mini Safari/Home Screen overflow, top-inset scrolling, offline and sign-out/reset checks. No publication is authorized by this local remediation. Backend/authentication remain unchanged; investigate transport timing further only if device evidence warrants it.


## 2026-10-16 — local service-worker diagnostics

Await separate owner approval to publish the local diagnostic candidate to the existing isolated preview. Then inspect More → Settings → About separately in Safari and Home Screen on iPhone 13 mini and iPhone 15: record application version, controlling build, control status, waiting status and offline readiness. Expected candidate build: 882166161364bd0a9c0f after adoption. If diagnostics are absent, record that fact rather than clearing data or claiming adoption. Recheck October 18 and Urlaub. No production authorization.


## 2026-10-16 — responsive-layout follow-up (local only)

Next owner action: review the local responsive-layout candidate and separately approve isolated-preview publication. Then verify the actual controlling worker in About on iPhone 13 mini and iPhone 15, separately in Safari and Home Screen, before testing normal/enlarged text, departure/arrival timing, dense rotation labels, hotel/address wrapping and Local/UTC. Recheck native status-bar scrolling and calendar -/U independently: neither is resolved by this layout task. No production release before device evidence; no commit/push/deployment authorized by this checkpoint.


## 2026-10-16 — durable sign-out correction (local only)

Next: owner reviews the local durable-sign-out correction and separately approves isolated-preview publication. Then verify sign-out/reset, offline relaunch and fresh authentication in Safari and Home Screen using synthetic-only state. Disposable-browser acceptance remains deferred by owner choice. If browser storage blocks both marker writes and endpoint removal, clear website data manually before relying on restart isolation. No commit, push, deployment or production operation is authorized by this checkpoint.


## 2026-10-24 — Crew Intelligence Phase 1d.2C: isolated live-service validation

Phase 1d.2C isolated validation and teardown are complete as reported by the owner
(`docs/CREW-GAS-TEST-SETUP.md` §13). The validation documentation was committed and
pushed as `e7d98b6`; this follow-up records the completed teardown, including clipboard
cleanup. Next checkpoint: review the documentation diff and commit the documentation-only
changes. Then evaluate and propose the next development milestone against the remaining
limits in §13.4–13.5 and the crew implementation/release documentation.
No next milestone is approved by this entry. Production remains NO-GO; deployment,
production configuration changes and real crew-data operations are outside this checkpoint.

## 2026-10-24 — Reconciled crew release-readiness checkpoint

Next checkpoint: define the exact production release scope from the existing
127-file tree difference. Classify changes as selected, already represented
in production, deferred, or support-only, with evidence for each conclusion.
Do not infer deployment state from file presence or old documentation.

Then prepare the coordinated release checklist:
1. Identify exact frontend/backend candidates and existing acceptance evidence.
2. Record actual current deployed frontend and Apps Script rollback references.
3. Reconcile the specification's outstanding Q1, Q4 and Q6 decisions.
4. Recover existing storage/backfill/timing results where available; otherwise
   identify requirements needing evidence or an explicit approved revision.
5. Distinguish required acceptance from optional additional investigation.
   Untested isolated web-app access alone does not authorize recreating
   test resources or repeating the completed smoke scenarios.
6. Retain frontend-first release order and separately approved backend changes.

No production release, push, configuration change, new test environment,
or additional test cycle is authorized by this checkpoint.

## 2026-10-24 — Backend baseline and proposed release scope

Next checkpoint: select the intended release scope. The documented proposal
is a combined crew + single-flight-information + attribution update using
the six backend files listed in backend/apps-script/README.md.
A crew-only alternative would require preparing and reviewing a different
shared-router candidate; it must not be represented as the already-reviewed
combined candidate.

After scope selection, finalize the frontend file set, existing acceptance
evidence, unresolved release decisions and rollback procedure.
No additional testing, source change, upload, push or deployment is
authorized by this documentation checkpoint. Production remains NO-GO.
