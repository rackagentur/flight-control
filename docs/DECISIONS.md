# Flight Control — decision log

The repo's original approved decisions stay where they are and are **not** copied here:
`docs/PLAN.md` ("Approved decisions", "Phase 6 decisions" D1–D6, "Phase 7 decisions", "Radar"),
`docs/DATA-GAPS.md` (owner decisions, e.g. crew base FRA only, D-OFF), `docs/CONTRACT-V2.md` (D-SRC, status semantics).

This file records decisions made in conversation, and every **change** to an earlier decision (never silently
overwrite: add a new entry that names what it supersedes). Status: `active` · `superseded` · `finding` (verified result, not a choice) · `proposed` (needs approval).

| ID | Date | Status | Decision | Source |
|---|---|---|---|---|
| D-001 | 2026-10-06 | active | Airline rules live in airline packs (`src/airlines/<airline>/`), not core. Feed parsing is separate from code meaning. Condor is the reference pack; other airlines only with real evidence | commits 48d800a, 571f33c |
| D-002 | 2026-10-06 | active | Standby Radar becomes the Radar screen; the old app is retired only after Flight Control's Radar is verified | owner |
| D-003 | 2026-10-06 | active (**challenged**, see P-003) | No Supabase in Flight Control: Apps Script backend (secrets in Script Properties) + browser storage. Server-side persistence only if a future requirement genuinely needs it | owner |
| D-004 | 2026-10-06 | active | Radar shows facts only: no probability/risk/legality claims; provider Boarding/GateClosed never shown as fact | `docs/CONTRACT-V2.md` |
| D-005 | 2026-10-06 | active, **display part superseded by D-008** | Condor Strichtag is the single dash `-` → canonical kind `unassigned` (not OFF/free). Originally: display STRICHTAG, calendar cell `STR` | commit d83ae2f |
| D-006 | 2026-10-06 | active | Calendar is a clean overview: one top-down aircraft per rotation on its first day (start marker), 8 px end ring, no sector counts; Unknown/Strichtag fixes go to the code-mapping layer, not UI | commits 73b717f, c87c222 |
| D-007 | 2026-10-07 | active | Two-theme restyle: brand base owns identity; copper (Light) / champagne (Dark) = brand + selection; aviation blue = routes/movement; duty states = subtle overlays; labels System / Light / Dark; owner reviews each step before commit. Palette frozen after Step 4 | owner |
| D-008 | approved by owner, recorded 2026-10-14 | active, **not implemented** | Calendar display preferences: **Strichtag cell `STR` → `–`** (changes D-005's cell code; canonical kind stays `unassigned`); **leave `LEAVE` → `U`** (cell/short code; meaning unchanged); **completed (flown) flights subdued**. State 2026-10-14: `src/airlines/condor/profile.js` still has `cell: 'STR'` and leave `short: 'LEAVE'`; flown sectors already recede in the rotation journey list (`.jr-sector.is-past`, opacity 0.62), month-calendar treatment not checked. Wording changes belong in the Condor pack terminology, not core/CSS | owner (conversation) |
| D-009 | 2026-10-14 | finding | Calendar data audit result: the existing calendar integration already carries most roster operational data; allowances, duty end, home-base pickups and rotation ids are not in the feed; crew names are in descriptions but stay excluded (D3) | `docs/ARCHITECTURE.md` §3 |
| D-010 | 2026-10-14 | active | Direct ICS feed: Phase 0 approved for **preparation and read-only local investigation only**. No request to the original feed until the owner confirms automated access is permitted **and** explicitly authorizes the probe. URL lives only in Script Property `FC_DIRECT_FEED_URL` (separate probe project), never in Git, chat, logs or responses | owner |

## Proposed (need approval)

| ID | Proposal | Blocked on |
|---|---|---|
| P-001 | **Hybrid ICS architecture**: direct feed only for "today onward", Google subscription + synced copy kept for history and as fallback; Script Property mode `off`/`shadow`/`primary`; contract and frontend unchanged | Phase 0 results: permission, reachability, deterministic UID ↔ Google-id mapping, measured freshness gain. If any fails → keep Google sync |
| P-002 | **Three-step onboarding** (account + airline → connect roster link with preview → personalize) on a hosted multi-user service reusing the pure Condor adapter/model; Condor only | Permission/legal review, hosting choice, P-003 |
| P-003 | **Revisit D-003** for multi-user: a separate backend (e.g. Supabase EU or Vercel functions + managed DB) is required for per-user isolation; the Apps Script path stays for the owner | Owner decision; would supersede D-003 for the multi-user service only |
