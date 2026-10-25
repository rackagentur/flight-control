# Flight Control — next steps

Last updated: **2026-10-26**. Current checkpoint: focused diagnostic review corrections verified; approved physical fault/Reset session paused at baseline inspection.

## Current implementation checkpoint — 2026-10-26

Local aggregate diagnostics, bounded backfill and lock-wait changes are owner-authorized and verified.
Current worker a6ae289d2a4dace19979. Focused review corrections:147 affected tests and13
hygiene/offline tests passed on Nodev26.7.0; worker/diff checks passed. No full-suite rerun.
Initial opt-in diagnostic intent is re-armed with fresh records; access-ending clears remain.
Cache timing has a deterministic nonzero assertion and a rejecting hard-coded-zero mutation check.
Earlier1,395-test and94-test results remain historical in CREW-DIAGNOSTICS. No publication.
See CREW-DIAGNOSTICS.md and the new decision entry. Next: owner reviews the local change and
recorded targeted/build checks; no automatic publication or real-data commissioning. The already
approved synthetic fault/Reset session remains paused at baseline inspection; do not run it in
parallel. The older authorization/status text below records the preceding checkpoint and is
superseded only by this local implementation authorization. Production remains NO-GO.

## 1. Scope selected; timeout exception approved

The owner selected the combined crew + single-flight-information + attribution scope for
preparation: **15 frontend changes, six backend files, complete 82-file static publication tree**
in [RELEASE-REVIEW.md](RELEASE-REVIEW.md). The inventory is unchanged. Production remains **NO-GO**;
selection authorizes no commit, push, deployment, activation, production access or new testing.

**Owner approved 45 s per `crewIndex` request only**, superseding its former <30 s client-timeout
target. Other crew requests retain their configured 25 s timeout. This resolves the timeout
specification decision, not measured latency: the cooperative server budget and all latency,
backfill, storage and acceptance targets remain unchanged. No code change or test cycle is needed
to record the decision; production remains NO-GO and deployment/activation unauthorized.

## 2. Paused physical response-fault checkpoint and retained evidence

**C3 is resolved by owner-approved documentation exception (2026-10-26; DECISIONS, C3).**
S0–S13 and teardown remain completed, owner-reported evidence. Exact execution date, executed
build identity and corresponding manifest digests are unavailable from inspected records; no
commit-bound validation is established. No more recovery search, rerun or infrastructure recreation
solely to replace those records. Other gates remain unchanged.

The bounded physical malformed/empty-response preservation and Reset plan was subsequently approved,
but remains paused at baseline inspection while this local implementation is reviewed. Do not
resume automatically or repeat completed normal-path checks. C3 does not waive these cases.

The authorized fixture-only session is recorded once in RELEASE-REVIEW. Existing synthetic
Version 2 immutable source matched all four publication hashes and has fixture-only data bindings;
Gregory's TLS/authenticated capabilities preflight passed. Home Screen normal-path fictional
roster sync and offline closure/reopen passed by owner report, with unchanged displayed last-sync
2026-10-24 21:12 (Europe/Berlin) and Available offline. Do not repeat this check or closed adoption.

The first configured browser also restored the fictional roster offline and showed saved-roster
readiness. Gregory subsequently confirmed it was standalone Safari, resolving the context uncertainty.
The subsequent authorized sign-out setup exposed conflicting Safari evidence: Tab 2 was still in
review mode; Tab 1 showed no saved token/roster and disabled Sign out. Gregory confirmed the same
Safari context/profile. Preserve the earlier restoration report but qualify Safari acceptance until
this discrepancy is resolved; do not infer data loss or a defect. Home Screen restoration and
adoption remain closed. That initial attempt stopped before sign-out; the separately authorized resumed result follows.

The earlier read-only owner-run Web Inspector diagnosis confirmed both tabs have accessible localStorage
but no endpoint, token or roster keys. Tab 1 is normal mode; Tab 2 is review mode. Both match the
preview origin and owner-confirmed regular/default Safari context. Only key names and booleans
were inspected. Absence is established at observation time; cause and historical continuity remain
unknown. No data-loss/defect conclusion or source-binding comparison is supported.

The separately authorized bounded setup/sync and sign-out checkpoint is now complete. Both tabs
were confirmed normal-mode with endpoint/token/roster keys present and the same fictional roster.
System/Local preferences were recorded. Sign-out in Tab 1 removed its visible roster; focusing
Tab 2 removed its roster. Tab 2 key-presence output confirmed token/roster absent, endpoint retained,
and System/Local survived. Offline closure/reopen of Tab 2 retained inaccessible roster and those
preferences. No server-side deletion, full account/history cleanup audit or Home Screen sign-out
is claimed. Do not repeat the passed cases. Earlier Safari absence remains unexplained; the new
setup/sign-out is not a replacement persistence pass.

The separately approved one-tab physical Safari offline-refresh/reconnect session is complete.
Baseline fictional roster: last sync 16:46 (Europe/Berlin), Available offline. After one manual
Refresh roster while offline and a reported 30-second wait, the same roster, timestamp/readiness
and endpoint/token/roster keys remained. One instructed reconnect produced Roster synchronized,
16:53 (Europe/Berlin), Available offline. No calendar date, measured timeout, exact request count,
raw network trace or malformed/empty-response acceptance inferred. No completed lifecycle checks
repeated; Home Screen pass and the earlier unexplained Safari discrepancy remain unchanged.

**Next checkpoint:** owner approval of the bounded malformed/empty and Reset plan in
RELEASE-REVIEW. G6 substitution is approved: completed physical offline-refresh/reconnect plus
shared preservation code path; timer-driven abort remains not physically verified. Malformed/
empty cases are not waived. G8 permits Settings discovery/opt-in but requires unsupported enrollment
to stop before dispatch, explain unsupported backend and leave feature off; unsupported flight-detail
crew content remains absent. No new physical G8 result or live-grant cleanup claimed.

The plan changes only existing synthetic FC66_SCENARIO (malformed, empty, exact baseline restoration),
uses Home Screen for the two fault-specific preservation/relaunch cases, then normal Reset in
Home Screen and two Safari tabs for explicit installed/other-tab criteria. Non-default Light/UTC
baseline makes preference removal observable. No execution yet; configuration changes, restoration
and local Reset deletion need separate approval. No replacement of missing saved-state preconditions,
retries, manual storage clearing, production access or completed lifecycle-check reruns.

Remaining A1 presentation, A2 failure-preservation and unobserved cleanup details, A3 update/rollback retention,
P1–P4 performance and OAuth/runtime/baseline/release-authorization gates stay open. Evidence applies
only to patched preview `0ecef7b232405a096670`, not original `a8024ca318cbf11bb3cb`, crew performance
or complete release acceptance. No reset, fault-mode change, regression/adoption rerun or new
infrastructure. Preserve Q1/Q4/Q6, timeout exception, historical visual approval and closed S0–S13/
teardown. No further execution, commit, push or deployment authorized. Production **NO-GO**.

### Remaining D2 authorization template (not a new execution approval)


Q1 is **owner-confirmed**: Gregory confirms that the previously described private, single-user
crew-data processing is permitted. No supporting policy or correspondence was inspected; this
is not independent legal verification. Multi-user access, sharing and commercial use are outside
this confirmation. It does not authorize production access, execution or release.

Use RELEASE-REVIEW's existing D2 / A1–A3 / P1–P4 checklist; do not restart evidence reconciliation.
**Required authorization:** Gregory names the candidate/build, existing HTTPS preview and
measurement target, operator, synthetic/real data boundary and permitted missing-check operations.
Explicitly include preview publication/update/rollback if A3 is to run, and service reads plus
any enrollment/backfill if P2–P4 are to run. No available target means that row remains blocked;
no resource creation or application change is implied. Production-dependent measurements and
OAuth/runtime checks remain deferred to separately authorized R3/R4 commissioning/verification.
This documentation checkpoint authorizes none of those operations.

Candidate/device/cross-tab acceptance, performance, OAuth/runtime authentication, source/rollback
baselines and explicit release approvals remain open. Preserve the selected combined scope,
45 s crewIndex-only exception, historical 198-image Stage B visual approval, Q4/Q6 confirmations
and closed S0–S13/teardown. No screenshot regeneration, general retest or repeated approval of
closed decisions. Production remains **NO-GO**.

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
