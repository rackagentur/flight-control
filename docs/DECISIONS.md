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


## 2026-10-24 — Combined release scope proposal (not approved)

Propose the 15-file frontend delta and six-file backend set in `RELEASE-REVIEW.md`.
If selected, this replaces the earlier gate-only three-file release proposal in
`FINAL-RELEASE-HANDOVER.md` and the crew-only four-file shorthand in the backend README.
It does not supersede product decisions, Q1/Q4/Q6 or measurement/acceptance requirements.
Frontend-first order remains binding, backend authorization separate. The owner-reported
current web-app rollback reference is Version 29; Version 27 remains historical.
No release selection, commit, push, deployment or real crew processing is approved here.


## 2026-10-24 — Owner selects combined scope for preparation

Owner selected the combined crew + single-flight-information + attribution scope: the exact
15 frontend changes, six backend files and complete 82-file static publication tree reviewed
in `RELEASE-REVIEW.md` and committed in `eba8876`. This supersedes only the awaiting-selection
status of the earlier “Combined release scope proposal (not approved)” entry above; the older
gate-only and crew-only proposals remain historical. The inventory is unchanged.

Selection is **for release preparation only**. It authorizes no application changes, tests,
resource creation, production access, commit, push, deployment or activation. Production
remains **NO-GO**. Frontend-first order and separate backend authorization remain binding.
Q1/Q4/Q6, candidate acceptance, storage/backfill/timing evidence, the indexing-timeout
specification discrepancy, rollback-baseline confirmation and release approvals remain open.
Completed S0–S13 validation and teardown stay closed. The next recommended decision is the
explicit indexing-timeout exception described in `RELEASE-REVIEW.md`; it is not approved here.


## 2026-10-24 — Approved client-timeout exception for crewIndex only

Owner approves **45 seconds per `crewIndex` request only**. This explicitly supersedes the
<30-second client-timeout target in `CREW-INTELLIGENCE.md` §12 only for `crewIndex`, and resolves
the timeout decision left open in the earlier scope-selection entry. `crew`, `crewEnroll` and
`crewRevoke` retain their configured **25-second** timeout; the ordinary-request target is unchanged.

The client timeout is a configured wait limit, not evidence of measured latency and not an extension
of the cooperative ≈15-second server execution budget. All server-duration, latency, backfill,
storage, quota and acceptance targets remain unchanged. The combined scope remains selected for
preparation only; Q1/Q4/Q6, missing acceptance/performance evidence, rollback-baseline confirmation
and release approvals remain open. Completed validation and teardown stay closed. Production
remains **NO-GO**. No code changes, test reruns, commit, push, deployment, activation or production
access are authorized by this decision.


## 2026-10-24 — Owner confirms Q4/Q6 and displayed access settings

Gregory confirms that the production web app executes as him (Q4). The supplied screenshot
supports the displayed setting “Ausführen als: Ich” (Execute as: Me). Gregory also confirms
that he is the project's only editor (Q6); this is owner confirmation, not screenshot evidence.
The screenshot shows “Zugriffsberechtigte: Jeder” (Who has access: Anyone). Record this as an
observed existing setting, not a change or new access approval.

This supersedes only the unresolved Q4/Q6 status in earlier release-preparation entries and
specification decision rows. It does not verify deployed source, OAuth scopes, runtime effective-user
behavior or application authentication. No account email or deployment identifiers are recorded.
Q1 remains unresolved: public web-app access is not permission to process crew data. Selected
combined scope, approved crewIndex timeout exception, historical Stage B visual approval and
closed validation/teardown remain unchanged. Other acceptance/performance/baseline and release
gates remain open. Production NO-GO; no production access or deployment authorized.


## Q1 — Owner confirmation of private, single-user processing (recorded 2026-10-24)

Gregory confirms that the previously described private, single-user crew-data processing is
permitted. Evidence is Gregory's statement in this conversation only: no supporting policy or
correspondence was inspected, and no independent legal verification is claimed. No external
approver or approval date is asserted. This does not cover multi-user access, sharing or
commercial use.

This supersedes only the unresolved Q1 status in earlier release-preparation entries and current
specification/checklist wording. Earlier entries remain historical. Candidate/device/cross-tab
acceptance, performance, OAuth/runtime authentication and rollback-baseline requirements remain
open. The selected combined scope, indexing-timeout exception, historical Stage B visual approval
and closed S0–S13/teardown are unchanged. The next checkpoint is D2 in RELEASE-REVIEW: separately
authorize the existing bounded session with named candidate, targets, data scope and operations.
Permission confirmation is not authorization to execute that session, access production or release.
Production remains NO-GO pending technical acceptance and explicit release authorization.


## C3 — Historical provenance exception (owner-approved 2026-10-26)

Gregory approves resolving C3 through a documentation exception. Retain Phase 1d.2C S0–S13
and teardown as completed, owner-reported evidence. The exact execution date, executed commit/
build identity and corresponding executed-bundle MANIFEST.txt digests are **not recoverable from
inspected records**. Surviving scratchpad manifests describe multiple packages but do not establish
which was executed. The report date and package source history are not execution provenance.

This supersedes only the unresolved C3 metadata-recovery requirement from the release-gate review
and the expectation of recovering those fields in CREW-GAS-TEST-SETUP §7/§13.1. The historical
record remains unchanged; do not invent dates/hashes or present regenerated hashes as historical.
C3 is **resolved by accepted exception**, not commit-bound validation. Do not rerun validation or
recreate infrastructure solely to replace these records. No other acceptance requirement is waived.
Combined preparation scope, earlier unexplained Safari discrepancy, Home Screen pass and the
patched-preview/original-candidate distinction remain unchanged. Production **NO-GO**; no tests,
commit, push, deployment or production access authorized.


## G6/G8 — Owner-approved evidence substitution and capability parity (2026-10-26)

**G6 approved:** accept completed physical Safari offline-refresh preservation/reconnect evidence
and the inspected shared saved-v2 preservation path for network/timeout errors as a narrow
substitution for physical timeout-preservation testing. Timer-driven abort remains **not physically
verified**. This supersedes only the separate physical timeout-preservation requirement in
IPHONE-ACCEPTANCE §2.6, STEP-6.6-OFFLINE physical step 8 and the corresponding release-review A2
row. It does not change timeout configuration, require an elapsed-time benchmark, or waive
malformed/empty-response preservation. Immutable FC66 Version 2 has no deliberate timeout mode;
the different generator's timeout mode is not a capability of that deployment.

**G8 approved:** amend CREW-INTELLIGENCE §14 Phase 1c capability-absent parity to permit the
Settings discovery/opt-in panel. Unsupported enrollment must stop before enrollment dispatch,
explain that the backend does not offer the feature and leave the feature off. Flight-detail crew
content must remain absent without supported capability. This supersedes literal whole-app
pixel-identity only for that Settings panel; other parity/privacy requirements remain. Approval
changes the criterion, not a claim of new physical execution or live-grant cleanup acceptance.

C3's approved provenance exception, combined preparation scope, earlier unexplained Safari
absence, Home Screen pass and patched/original build distinction remain intact. No tests, backend
setting changes/requests, application changes, deployment, commit or push authorized by these
records. Production **NO-GO**. Malformed/empty and Reset execution requires separate authorization.

## Measurement/backfill — Owner-approved specification decisions (2026-10-26)

Owner approved opt-in aggregate diagnostics, history-scaled bounded continuation, operation-specific
lock waits, documentation and targeted tests. Supersedes the fixed <=8-call initial-backfill
criterion in CREW-INTELLIGENCE §12 and RELEASE-REVIEW P2: N is captured once from the first
successful work snapshot; complete coverage requires <=ceil(N/6)+2 requests and <=180 seconds,
within existing budgets. Six months/request remains. One shared busy retry consumes allowance;
other no-progress stops; no automatic resume or allowance growth. Decimal-byte thresholds are
explicitly approved:6,000 median /8,000 maximum stored part bytes;450,000 observed peak;
500,000 admission. No latency, lock-held, quota or other acceptance target is waived.

Approved implementation safeguards and precise contract/retention/incomplete behavior are in
CREW-DIAGNOSTICS.md. Diagnostics stay request/client memory-only, aggregate-only, bounded and
subject to unchanged authorization/generation/cleanup/admission. User Properties operation
counts include diagnostic overhead but are not a complete daily quota calculation. Legacy
responses remain valid; missing session metadata prevents speculative continuation.

This authorization permits local implementation and tests only. No production/backend requests,
credentials, deployment, commit or push; paused physical session stays paused. C3's accepted
provenance exception, G6/G8, Q1/Q4/Q6 and historical/physical evidence remain within their recorded
scope; the unexplained Safari discrepancy is not resolved by this work.
