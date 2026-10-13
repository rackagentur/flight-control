# Flight Control — next steps

Last updated: 2026-10-14. Agents act only on items marked **approved**; everything else waits for the owner.

## 1. Next approved agent action

**None is pending without a further owner instruction.** Step 6.6 is committed locally and waits for owner review (no push). Approved scope today:

- Phase 0 direct feed: preparation and read-only **local** investigation only (D-010). Done; the probe is prepared.
- **No** request to the Condor feed, no production change, no deploy, no push.

## 2. Waiting for the owner (in suggested order)

| # | Decision / action | Unblocks |
|---|---|---|
| 1 | **Permission:** confirm that automated retrieval of the CUBE roster feed is permitted (employer IT / works agreement / CUBE terms) | Probe execution, P-001, P-002 |
| 2 | Set up the probe project (`~/.config/flight-control/feed-probe/SETUP.md` A–C), run `probeDryRun` only | — |
| 3 | **Authorize** the probe explicitly (set `FC_PROBE_AUTHORIZED_UNTIL`, tell the agent) | `probeRun`, then optional monitor |
| 4 | **Approve push** of `v2-redesign` (fast-forward `0ae7d58` → HEAD; public repo; no deploy: Pages serves `main` only) | backup + preview |
| 4a | **Approve iPhone preview setup** (`docs/IPHONE-ACCEPTANCE.md`): staged Vercel preview in a separate project + synthetic Apps Script test backend | A5 acceptance |
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
