# Flight Control — instructions for coding agents

## Read first (before any substantial work)

1. `docs/PROJECT_STATUS.md` — current phase, branches, what is live, verified functionality, open issues.
2. `docs/NEXT_STEPS.md` — the next approved action, what waits for the owner, the checkpoint procedure.

Then, as needed: `docs/DECISIONS.md` (decision log), `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`,
`docs/SESSION_LOG.md`, `docs/PLAN.md`, `docs/CONTRACT-V2.md`. Re-check facts with git/tests; docs can be stale.

## Hard rules

- **`main` is production** (GitHub Pages). Never merge, fast-forward or push to `main` without explicit approval.
  Develop on `v2-redesign`. Do not push any branch without approval.
- **Apps Script backend is production.** Never deploy, edit Script Properties or triggers, or change the v5 sync.
  Backend changes ship frontend first, then backend, with a rollback version (`backend/apps-script/README.md`).
- **Never request the Condor/CUBE roster feed** unless the owner has confirmed automated access is permitted
  **and** explicitly authorized that request in the current session.
- **No secrets or personal data in Git**: no tokenized calendar URLs, calendar/Sheet ids, deployment URLs, API keys,
  colleagues' names or employee numbers. `reference/` is git-ignored and private; never copy from it into tracked
  files. `tests/repo-hygiene.test.js` must pass.
- Never mark unverified features as implemented. Proposals stay PROPOSED until approved and built.
- Decisions are never silently overwritten: add a new `docs/DECISIONS.md` entry naming what it supersedes.
- Roster-code meaning and airline wording live in `src/airlines/<airline>/`, never in core or CSS.
- The owner reviews each step (screenshots for visual changes) before any commit. Commit only the files of the
  approved step; never sweep in unrelated working-tree changes.
- No new runtime dependencies without approval (native ES modules, `node --test`).

## Commands

- `npm test` — full suite (includes repo hygiene). `npm run build:offline` after frontend file changes (Step 6.6).
- Node runtime for tests: the crew suites need the Web Locks API (`navigator.locks`). Node 24.22.1 has it (full suite
  green); Node 22.22.0 lacks it, and ~123 crew tests then fail with `lock-unavailable`. That is an environment
  failure, not a regression; rerun on Node 24 before judging.

## Session end

Follow the checkpoint procedure in `docs/NEXT_STEPS.md` §4.
