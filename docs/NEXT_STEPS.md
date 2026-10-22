# Flight Control — next steps

Last updated: 2026-10-14. Agents act only on items marked **approved**; everything else waits for the owner.

## 1. Next approved agent action

**None is pending without a further owner instruction.** `v2-redesign` is pushed (`5db9381`); the iPhone preview tooling is prepared but **not deployed**. Approved scope today:

- Phase 0 direct feed: preparation and read-only **local** investigation only (D-010). Done; the probe is prepared.
- **No** request to the Condor feed, no production change, no deploy, no push.

## 2. Waiting for the owner (in suggested order)

| # | Decision / action | Unblocks |
|---|---|---|
| 1 | **Permission:** confirm that automated retrieval of the CUBE roster feed is permitted (employer IT / works agreement / CUBE terms) | Probe execution, P-001, P-002 |
| 2 | Set up the probe project (`~/.config/flight-control/feed-probe/SETUP.md` A–C), run `probeDryRun` only | — |
| 3 | **Authorize** the probe explicitly (set `FC_PROBE_AUTHORIZED_UNTIL`, tell the agent) | `probeRun`, then optional monitor |
| 4 | ~~Push `v2-redesign`~~ — done 2026-10-14 (`5db9381`, fast-forward, after history cleanup) | — |
| 4a | Isolated preview: Vercel `flight-control-preview` **deployed 2026-10-15**; owner sets up the synthetic Apps Script backend (`docs/IPHONE-ACCEPTANCE.md` Setup A), then the agent verifies it | A5 acceptance |
| 4b | Run the iPhone acceptance run sheet; report results | release of A5 |
| 5 | Read the Apps Script Executions log for the 05:00 sync (B2-sync) | B3 |
| 6 | **Hosting decision** for multi-user (P-003: keep D-003 vs separate service, provider, EU region) and legal/privacy review | Track C |
| 7 | Approve D-008 implementation (Condor pack wording `–` / `U`, subdued completed flights; screenshots first) | A6 |
| 8 | Confirm meanings of unmapped codes, `DH/<flight>` first | B2 |
| 9 | After 2026-11-01: check the B3 monthly dashboard | — |

## 3. Unresolved decisions

- **Permission** for automated feed access — unknown; never assume it.
- **Hosting** for a multi-user service — open; D-003 ("No Supabase") is still active.
- Duty-end rule (on-block + fixed post-flight time?) — only if the owner wants a derived duty end.
- Allowances — out of scope, or a PDF-only upload later.
- Where the URL should live long-term: it currently also exists in a third-party location outside Git (owner knows
  where). Rotating it at CUBE would also break the existing Google subscription.

## 4. Session-end checkpoint procedure (every substantial session)

1. `git status --short` and `git log --oneline -5`: note branch, HEAD, uncommitted files.
2. Run `npm test`; record pass/fail counts and any flaky test.
3. Update `docs/PROJECT_STATUS.md` (state table, open issues) — mark anything not re-checked as unverified.
4. Update `docs/NEXT_STEPS.md` (next approved action, owner queue).
5. Add decisions/changes to `docs/DECISIONS.md` (new entry that names what it supersedes; never edit history away).
6. Add a dated entry to `docs/SESSION_LOG.md`; adjust `docs/ROADMAP.md` statuses.
7. Scan for secrets before committing: `npm test` (repo-hygiene test) and no URLs with tokens, calendar ids,
   names or employee numbers in the diff.
8. Commit **only** the documentation files (explicit paths), never unrelated work in progress. Push only with approval.


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
