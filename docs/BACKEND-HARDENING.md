# Backend hardening (separate workstream)

**Status: BH-1 deployed (Version 25, 2026-10-05); BH-2 next. Each step requires explicit approval.**
**Gate:** V2 may be developed and previewed against the existing backend, but it must **not** become the live/public version until BH-1 and BH-2 are deployed and verified.

The live Apps Script deployment is **not modified** during frontend development (Phases 2–7).
Detailed findings are tracked privately and are not published until fixed.

## Principles

- **Reversible:** every step ships as a new version of the *same* deployment (the URL is unchanged). Rollback = Manage deployments → Edit → previous version.
- **Contract-preserving:** trigger handler names and the `getStats` payload stay frozen; changes are additive.
- **Logged:** every deployed version number is recorded below.

## Steps

| Step | Goal | Notes |
|---|---|---|
| BH-0 | Baseline | Private plain-text export of every project file, the trigger list and the current deployment version number |
| BH-1 | Reduce the server entry-point surface | Trigger handler names unchanged |
| BH-2 | Access control for API actions | Must work without a CORS preflight; V2 `api/appscript.js` provides the hook |
| BH-3 | Framing protection | Default framing policy |
| Later | Cleanup after V2 is stable | Remove the legacy wrapper; de-collide shared function names; fix B1/B2/B4/B7/B9–B13; additive `getStats` fields (`DATA-GAPS.md`) |

## Phase 7 note (2026-10-04)

- BH-0 baseline recorded privately (file hashes, deployments, triggers, scopes, Script Property names). Not published.
- The fc.roster v2 sources (`backend/apps-script/`) are implemented and tested locally; **nothing was installed or deployed**. The v2 endpoint is token-protected from its first deployment; it does not fix the v5 GET surface, which remains the BH-1/BH-2 gate.

## Phase 7 install (2026-10-04) and Step H (2026-10-05)

Installed (owner-approved): the four v2 files added unchanged to the existing project; Script Property `FC_V2_TOKEN` set; the existing *untitled* ("Unbenannt") deployment moved to **Version 23** ("fc.roster v2"), same /exec URL. Version 23 checked to contain all nine files, byte-identical to the intended sources; the five original files, the triggers (a normal `standbyHourlySync` run observed) and `PLACES_API_KEY` unchanged; v5 `getStats` HTTP 200 with five upcoming flights. Still open: BH-1/BH-2 (the v5 GET surface).

**Step H: auth and contract verification against Version 23: GO.** Read-only; only aggregates were recorded (no roster content, endpoint or token).

| Check | Result |
|---|---|
| No token / wrong token | `unauthorized` (HTTP 200); token never echoed |
| Correct token, `capabilities` | `fc.roster` v2; actions capabilities/roster/history; limits 100 days / 13 months / 2,000 sectors; base zone `Europe/Berlin` |
| Version 3 / wrong contract name / unknown action | `unsupported-contract` / `unsupported-contract` / `unknown-action` |
| Bounds | roster > 100 days → `range-too-long`; future history → `history-is-past-only` |
| `roster` (default window) | Passes the frontend `validateRoster`. 91 days (74 rostered, 14 empty, 3 unpublished); synced copy before today, airline feed from today; 96 events, 21 sectors, 19 duties, 3 windows, 12 stays, 1 warning (`unknown-code`) |
| ORT / rest family | ORT always `off/ort` with `protected: true` and the only protected code; OFF, free, leave, standby and reserve kept distinct |
| UNKNOWN ≠ OFF | Empty/unpublished days carry no codes; rest codes only from explicit off events; day states consistent with events; unknown codes kept as `unknown` |
| Provenance | Valid on every item; backend never emits `inferred`; report/pickup times `source`, association `derived`; zones `derived` |
| Time zones | Every sector local time and offset matches an independent IANA recomputation (0 mismatches, 0 null zones, sectors on both sides of a DST change) |
| Aircraft | Present on every sector, `source` only, well-formed |
| Privacy | Opaque ids only; no calendar ids, descriptions or e-mail addresses |
| `history` (default) | Passes `validateHistory`; 2025-10-01 → yesterday, not truncated, past only, synced copy, `source` |
| v5 fallback | `getStats` HTTP 200, `success`, 16/16 contract fields, five upcoming flights (≈ 17 s; within the 25 s client timeout) |

A first-run assertion "every rostered day has a day code" failed. It was a wrong test expectation, not a defect: `codes[]` lists only rest-family codes (clarified in `CONTRACT-V2.md`); the implementation is unchanged. The corrected check (every rostered day has an event on that date, and every day code has an explicit off event) passed.

Non-blocking observations:

1. Four history sectors used two airports missing from the airport table (PDX, SYX), so their zones were `null` (reported, not guessed). **Closed:** both added (`America/Los_Angeles`, `Asia/Shanghai`; cross-checked against two airport datasets), `AirportsV2.gs` regenerated, and live since Version 24 (below).
2. All stays carry a roster hotel, but none has a VERIFIED location yet (fail-closed: no matching Sheet row for the stay), so no map pins.
3. Repository status lines still said "not installed / not deployed" (fixed with this record).
4. The no-token and wrong-token checks count toward the failed-token limit (2 of 20 per 10 minutes); harmless, but repeat runs should stay well below the limit.

## Version 24: PDX/SYX zones (2026-10-05)

Owner-approved, deployed manually by the owner (no automation).

- **Preflight (read-only):** Version 23 confirmed live in Manage deployments with no unsaved editor changes; the only `.gs` difference to the Version 23 sources was the two added lines in `AirportsV2.gs` (which matches its generator); 271/271 tests; clean working tree; v5 `getStats` and v2 auth working; current roster zones recorded as a baseline.
- **Change:** only `AirportsV2.gs` replaced in the editor and saved. The saved file, copied back from the editor, was byte-identical to the repository file (4,957 bytes, SHA-256 `fdae7cd494eaac3d…`). The *untitled* ("Unbenannt") deployment moved to a new **Version 24**; same /exec URL. No other file, deployment, trigger or Script Property touched.
- **Verification (read-only, aggregates only):**

| Check | Result |
|---|---|
| v5 fallback | `getStats` HTTP 200, `success`, five upcoming flights |
| v2 auth | Wrong token → `unauthorized`; correct token → `fc.roster` v2 |
| Current roster | 21/21 sectors keep identical zones and local times (vs. the Version 23 baseline) |
| History | 41/41 sectors with valid IANA zones on both ends; no `null` zone |
| PDX / SYX | `America/Los_Angeles` / `Asia/Shanghai` |
| Full Step H suite | Same results as on Version 23 (coverage, counts, ORT, UNKNOWN ≠ OFF, provenance, IANA local times, aircraft, privacy) |

History responses are cached for 6 h per range, so the check used a range not requested before; the default range shows the new zones once its cache entry expires.

## BH-1: entry-point surface (Version 25, 2026-10-05)

Owner-approved, deployed manually by the owner one step at a time.

- **Change:** a single committed GET router (`backend/apps-script/RouterV2.gs`) is now the project's only `doGet`. It serves the read-only `getStats` contract unchanged and answers every other GET with a small JSON refusal; the web app no longer serves a page. The previous web-app entry function was renamed to a private name and the legacy wrapper file was removed. Each file edit was checked byte-for-byte against the intended source. An older, unused deployment of the project was archived; the web app now has a single active deployment. Trigger handlers are unchanged.
- **Verification (read-only):** every former GET entry is refused with JSON and returns immediately (execution log: sub-second runs, no scheduled-work side effects, no email); `getStats` unchanged (16/16 fields); contract v2 auth, roster zones (21/21 vs. baseline), history (41/41 IANA zones) and the full Step H suite unchanged; the app works on contract v2 with its settings status refreshing.
- **Rollback:** Manage deployments → the deployment → Edit → Version 24 (same URL).

## Deployment log

| Date | Step | Version | Verified by | Rollback version |
|---|---|---|---|---|
| 2026-10-04 | Phase 7: fc.roster v2 installed on the existing deployment ("fc.roster v2") | 23 | Owner (files, triggers, v5); Step H on 2026-10-05 | 22 |
| 2026-10-05 | `AirportsV2.gs` with PDX/SYX zones ("fc.roster v2 + PDX/SYX zones") | 24 | Owner (byte-identical file) + read-only checks above | 23 (pre-v2: 22) |
| 2026-10-05 | BH-1: single GET router ("BH-1: GET router (getStats only)"); unused older deployment archived | 25 | Owner (byte-identical edits) + read-only checks above | 24 |
