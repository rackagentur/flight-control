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
| D-008 | approved by owner, recorded 2026-10-14 | symbols **superseded by D-012**; subdued completed flights **not implemented** | Calendar display preferences: **Strichtag cell `STR` → `–`** (changes D-005's cell code; canonical kind stays `unassigned`); **leave `LEAVE` → `U`** (cell/short code; meaning unchanged); **completed (flown) flights subdued**. State 2026-10-14: `src/airlines/condor/profile.js` still has `cell: 'STR'` and leave `short: 'LEAVE'`; flown sectors already recede in the rotation journey list (`.jr-sector.is-past`, opacity 0.62), month-calendar treatment not checked. Wording changes belong in the Condor pack terminology, not core/CSS | owner (conversation) |
| D-009 | 2026-10-14 | finding | Calendar data audit result: the existing calendar integration already carries most roster operational data; allowances, duty end, home-base pickups and rotation ids are not in the feed; crew names are in descriptions but stay excluded (D3) | `docs/ARCHITECTURE.md` §3 |
| D-012 | 2026-10-15 | active, implemented (uncommitted) | **Condor display terminology** (Condor pack only; classifications unchanged: `-` = `unassigned`, `U` = `off`/`leave`). Strichtag: calendar cell, key sample and 7-day strip show the roster code `-` (ASCII hyphen-minus U+002D); Today title "Strichtag", description "No duty assigned"; still not a guaranteed day off. Urlaub: cell, key and strip show `U`; Today title "Urlaub", description "Holiday"; key "Urlaub · holiday". Never `STR` / `LEAVE` for Condor. **Supersedes** the display part of D-005 (`STRICHTAG` / `STR`) and corrects D-008's `–` (en dash) to `-`; the D-008 "subdued completed flights" part stays open. Generic pack unchanged (`LEAVE`, `UNAS`) | owner (conversation) |
| D-011 | 2026-10-14 | active, implemented (Step 6.6) | **Token change** invalidates the previous credentials' roster, history and departures cache; preferences stay. **Sign out** removes token, roster, history, operational caches (departures, weather memory), revokes other tabs (sign-out marker) and the account-specific profile fields `name` and `hotelListUrl`; keeps home base, wake-up offset, other operational profile fields, theme, Local/UTC, endpoint. **Reset** removes everything (`fc.v2.*`) and returns to setup. Sign out and Reset are explained separately in Settings. Supersedes the earlier 6.6 draft in which Sign out removed the whole profile | owner (conversation) |
| D-010 | 2026-10-14 | active | Direct ICS feed: Phase 0 approved for **preparation and read-only local investigation only**. No request to the original feed until the owner confirms automated access is permitted **and** explicitly authorizes the probe. URL lives only in Script Property `FC_DIRECT_FEED_URL` (separate probe project), never in Git, chat, logs or responses | owner |
| D-013 | 2026-10-15 | active, **not implemented** (next implementation milestone) | **Condor code `SBX`** = the scheduled travel window to the standby location before an SB duty. Classify as **standby-related travel**, a kind of its own, separate from the SB standby duty; keep the original scheduled start/end; never a flight, day off or standby duty. Until implemented it stays `unknown` (I-002). Meaning lives in the Condor pack (`src/airlines/condor/`), not core. Observed once in the live feed (Milestone 2, 2026-10-15) | owner (conversation) |

## Proposed (need approval)

| ID | Proposal | Blocked on |
|---|---|---|
| P-001 | **Hybrid ICS architecture**: direct feed only for "today onward", Google subscription + synced copy kept for history and as fallback; Script Property mode `off`/`shadow`/`primary`; contract and frontend unchanged | Phase 0 results: permission, reachability, deterministic UID ↔ Google-id mapping, measured freshness gain. If any fails → keep Google sync |
| P-002 | **Three-step onboarding** (account + airline → connect roster link with preview → personalize) on a hosted multi-user service reusing the pure Condor adapter/model; Condor only | Permission/legal review, hosting choice, P-003 |
| P-003 | **Revisit D-003** for multi-user: a separate backend (e.g. Supabase EU or Vercel functions + managed DB) is required for per-user isolation; the Apps Script path stays for the owner | Owner decision; would supersede D-003 for the multi-user service only |


## 2026-10-15 — release prerequisites follow-up

Release-prerequisite correction (no product-scope change): recover the first-install/navigation claim race with a one-time message to a complete active worker; retain no-skipWaiting and controller-confirmed readiness. Synthetic provider acceptance uses existing pure handlers plus local fixtures; generated code omits live bindings. This supersedes the handover assumption that missing provider fixtures/readiness diagnosis remain unprepared. No remote auth/protection decision is made; existing synthetic backend property-name mismatch must be reviewed before any publication. Production remains frontend first.


## 2026-10-16 — iPhone layout remediation (local only)

Additive layout correction only: retain two Flight Detail columns and existing typography/colors; remove default dd indentation and permit wrapping under width/text-size pressure. Retain current safe-area padding and cover only the top system inset during scrolling. No matching, timezone, authentication, request/retry or backend policy changes. This does not supersede any release decision.


## 2026-10-16 — local service-worker diagnostics

About diagnostics observe the existing FC_SHELL_STATUS reply from navigator.serviceWorker.controller, with a bounded timeout and stale-reply rejection. getRegistration is read-only and used only for waiting-update observation. Registration.active and network sw.js are never evidence of the current controller identity. No lifecycle decision is superseded: no update(), skipWaiting, reload, claim or unregister is introduced. Unknown/unsupported/uncontrolled states remain explicit; overall readiness requires both worker cache evidence and existing controller roster readiness.


## 2026-10-16 — responsive-layout follow-up (local only)

Additive correction to responsive presentation only: narrow milestone containers use stacked rows rather than four competing shared columns. Timeline visibility now uses rendered label bounds and 8px clearance, superseding fractional-only collision decisions when mounted. Existing priority is retained (next stop, then final arrival); every track stop and complete accessible summary remain. Refit on container/font changes, dispose observers with the screen. UTC badge takes its own grid row to avoid enlarged-text collisions. Hotel address is a separate block with an explicit text separator. No calendar mapping, model, timezone, authentication, backend or release-policy decision is superseded.


## 2026-10-16 — durable sign-out correction (local only)

Refines D-011 sign-out failure handling without changing normal preference retention or reset semantics: retry the verified marker write after cleanup frees quota. If it still fails, remove and verify the endpoint, report storage failure even when disconnection succeeds, and retain the in-memory signed-out block until explicit reconnection. This supersedes only the implicit assumption that the initial marker write always succeeds. Successful reset clears the namespace without requiring a surviving marker. No backend authentication, worker lifecycle or release-policy change.
