# Crew Intelligence — specification, architecture and UI proposal

Current status (2026-10-24): **frontend, backend and routing implemented on `v2.1-dev`;
not deployed to production. Production NO-GO.** Owner-run isolated S0–S13 validation and
teardown are complete (`CREW-GAS-TEST-SETUP.md` §13). Current source baseline `5a7dd16`;
production Git comparison reference `a3008d2`, not a served-build verification.

[RELEASE-REVIEW.md](RELEASE-REVIEW.md) reconciles implementation, measurements, acceptance
and unresolved Q1/Q4/Q6. Earlier phase-status sections below are historical implementation
snapshots: “not routed”, “not committed”, “frontend not implemented” and “simulated only”
must not be read as the current overall status. Their requirements remain binding unless
explicitly superseded; source presence is not release approval or policy clearance.
Revision 4.1 and the correction-pass acceptance criteria remain the design baseline.

### Revision 4 changes (summary)

| # | Codex R3 finding | Revision 4 | § | Binding tests |
|---|---|---|---|---|
| R4-1 | Purge used `deleteAllProperties()` (would erase unrelated User Properties) | Namespace-safe deletion of `fcx.*` only, orphans included; cache keys captured into the state record **before** the manifest is deleted; unrelated keys verified untouched | §8 | T8, T12 |
| R4-2 | Separate grant/tombstone records raced; old operations could restore access or publish | One authoritative state record `FC_CREW_STATE` with a monotonic **generation `G`**; every transition under the lock; manifests, parts and caches stamped with `G`; final re-check before any response | §4, §7, §8 | T1, T7, T13 |
| R4-3 | Long predecessor flights outside the read window; month-end cutoff dropped completed cross-month duties | Edge rule on **every** returned flight (both sides); completion = `dutyEnd ≤ now`, never month end; sealing waits for all home-month duties to complete | §5 | T2, T14 |
| R4-4 | Missing records vs grouping uncertainty conflated; inflated counts called lower bounds; "First flight together" overclaims | Two anomaly classes; suspect duty groups collapsed so "at least N" is a true lower bound; new zero wording "No earlier match in available records"; failed replacement → stale — *the lower-bound claim is superseded by CP-3 (recorded duties, no bounds)* | §6 | T4, T15 |
| R4-5 | Storage peak and reader consistency undefined | Peak formula with old + new parts coexisting, manifest, key names, recovery reserve; lock-free readers validate a per-month digest and retry; GC grace period | §7.6, §9 | T9, T16, T17 |
| R4-6 | Missing targeted tests | T12–T17 added; T1, T2, T4, T7–T9 tightened | §13 | — |
| R4.1-A | Phase 1a condition: missing long/connecting sectors; unsafe bounds | Links within 20 h on disconnect, hidden event or < 10 h rest; transitive suspect groups; selected duty's group excluded; counts are **recorded duties**, never bounds; uncertain members get no number (corrected in the correction pass) | §6.3b | T15 |
| R4.1-B | Phase 1a condition: per-month retries could mix manifests | Whole-query snapshot from one manifest; full restart; no partial counts after 3 attempts | §7.6 | T17 |
| CP-1 | Phase 1a review: an unpersisted `replaceFailed` marker let the old shard read as fresh | Mark `replacing` before replacing; fail closed by deleting the old parts if the marker cannot be written; documented limitation when nothing can be written | §7.2a | replacement-failure tests |
| CP-2 | Phase 1a review: unsupported/malformed manifests were read and written | Full manifest validation; `index-incompatible`; no commit or GC on invalid data | §7.7 | schema tests |
| CP-3 | Phase 1a review: unsupported "provable lower bound" claim; T15g accepted an over-count as verified | Counts are recorded duties; 10 h minimum-rest link; uncertain members get no number; T15g now uncertain, residual case T15h labelled recorded | §6.3b–6.5 | T15a–h |
| CP-4 | Phase 1a review: tie ordering differed from `fcv2Duties_` (3 vs 2 duties) | Same comparator as `fcv2BuildRoster_` (start, end, stable); full ties flagged `tied` | §5.1 | parity tests |

All names, ranks, flights, dates and counts are **synthetic**. Employee identifiers are never written out, not even
as fake numbers; they appear only as `<employee-id>`. Early performance/size estimates are distinguished from the later synthetic measurements in §9.4a/§16a; real release measurements remain outstanding as classified in RELEASE-REVIEW.md.

UI direction (approved in principle): the Crew Intelligence mockup artifact (six screens). §11 lists the copy changes
Revision 3 makes to it.

## 0. Approved scope (owner)

1. **Single-user only** (the owner's own Apps Script deployment). Multi-user stays excluded.
2. Colleague **names** only in the private **flight-detail** view. **Employee numbers never** in the UI or the app.
3. No names on Calendar or Today.
4. History from **2022-08-01** (the backend's existing `historyStart`), no rolling window.
5. **Opt-in, disabled by default.**
6. The v5 sync, including its colleague notes, stays **unchanged** until a replacement is separately approved.
7. **Unresolved, not assumed:** airline-policy / works-agreement permission and data-protection clearance (Q1).

## 1. Codex blockers: resolution summary

| # | Blocker (Revision 2) | Revision 3 resolution | § |
|---|---|---|---|
| B1 | Enrollment: a roster-token holder could enroll or replace the crew grant during an open window | Owner-issued **single-use enrollment code** (≥ 128-bit) set by the owner in Script Properties; consumed atomically under lock; attempt-limited; idempotent retry; replacement only via a new code; explicit expiry and recovery | §4 |
| B2 | Duty fallback to calendar days; no cross-midnight / cross-month rules; no stable ids | One **canonical duty function** shared by roster, index and selected flight; **home month** = month of first departure; ±36 h read margins with bounded extension; stable `dutyKey`; cross-shard dedupe; failures are counted anomalies, **never** a day fallback; sector-level detail preserved | §5 |
| B3 | Completeness ignored the selected month; stale counts treated as lower bounds | Relevant range includes the selected month up to the selected duty start; anomalies (missing crew list, missing ids, parser/grouping failures) tracked; three result states **verified / incomplete / stale**; stale never shown as a guaranteed bound; only **completed** duties count | §6 |
| B4 | Revocation not robust (disabled feature, lost responses, concurrency, rotation, cache) | Authenticated, **idempotent** `crewRevoke` with client `revokeId`, available while the feature is disabled; **generation transition = logical invalidation** (R4: `FC_CREW_STATE`), then **confirmed physical deletion** of the `fcx.*` namespace (R4); owner purge path; cache keys registered and bounded by TTL | §8 |
| B5 | Incremental index not crash-safe; incomplete fingerprints | **Immutable generation-suffixed shard parts + single-value committed manifest** (atomic commit point) + orphan GC; fingerprints over every grouping/familiarity input of the month's read window; neighbour-month invalidation; access-driven reconciliation; visible verification timestamps | §7 |

---

## 2. Proposed decision entry (supersedes D3 in part)

Added to `docs/DECISIONS.md` only when the build is approved:

| ID | Date | Status | Decision | Source |
|---|---|---|---|---|
| D-014 | 2026-10-22 | proposed | **Crew Intelligence, single-user, opt-in. Supersedes D3 (`docs/PLAN.md`) only for this scope.** On the owner's own deployment, after enrollment with an owner-issued single-use code, the backend may read crew lines of the owner's own rostered flights to show, in flight detail only, the colleagues on that sector and how many recorded duties the owner shared with each **before** it (history from 2022-08-01; recorded in the available roster records, never claimed as real-world counts), labelled complete, incomplete or stale, with no number where grouping is uncertain. Names appear only there; employee numbers never leave the backend; Calendar and Today show no names. The backend keeps a durable **pseudonymous** index (128-bit keyed hashes, no names, no raw ids) in the `fcx.` namespace of the User Properties store, logically invalidated (generation transition) and then physically deleted on revocation. `roster`, `history` and all other actions stay crew-free as under D3. Multi-user processing, exports and sharing remain excluded and need a new decision and legal/privacy review. The v5 sync is not changed | Owner approval in principle 2026-10-22; Codex reviews; `docs/CREW-INTELLIGENCE.md` rev. 4 |

Pointers "partly superseded by D-014" go into `docs/PLAN.md` (D3), `docs/DATA-GAPS.md` and `docs/ARCHITECTURE.md` §3.

---

## 3. Architecture

```
 PWA (owner)                         Apps Script web app — executes as the owner (deploying user)
 ───────────                         ─────────────────────────────────────────────────────────────
 Settings ── crewEnroll{code,grant} ─▶ token ✓ → enrollment code ✓ (Script Properties, single use) → grant record
 Settings ── crewIndex{} ───────────▶ token ✓ → grant ✓ → index worker (budgeted, locked, resumable)
 Flight detail ── crew{sectorId,date}▶ token ✓ → grant ✓ → resolve + own sector ✓ → canonical duty
                                        → familiarity from committed index (+ live open months)
                                        → response (names, no ids; read-only: never verifies or writes history)
 Opt-out / Forget ── crewRevoke{revokeId}▶ token ✓ → grant or revoke credential ✓ → state G+1 'revoking' → purge fcx.* → verify
 Owner (Apps Script editor) ── crewPurgeAll  (manual, no web entry point)
```

| Piece | File | Airline-specific |
|---|---|---|
| Crew-line parser `→ {rank, family, given, id\|null}` + parse diagnostics | `CondorAdapterV2.gs` `fcv2ParseCrewLines_` (pure) | **Yes — the only place** |
| Canonical duty grouping (shared with `roster`) | `RosterModelV2.gs` `fcv2GroupDuties_` extracted from `fcv2Duties_` (pure, byte-identical `roster` output) | No |
| Encounter model, familiarity query, result states | new `CrewV2.gs` (pure) | No |
| Shard codec, manifest, fingerprint, GC, purge | new `CrewIndexV2.gs` (pure core + thin store wrapper) | No |
| Routing, enrollment, grant, revoke, capabilities | `RosterApiV2.gs` | No |
| Live wrappers: HMAC, PropertiesService, LockService, CacheService | `fcv2LiveEnv_` additions | No |
| Owner-run purge | `crewPurgeAll` (editor-run; see Q7) | No |

No new trigger, no new outbound request, no new OAuth scope, no change to v5 files.

---

## 4. Enrollment and authorization (resolves B1)

### 4.1 Secrets and records

| Name | Store | Content | Who writes |
|---|---|---|---|
| `FC_V2_TOKEN` | Script Properties | existing roster token | owner |
| `FC_CREW_ENABLED` | Script Properties | `on` = crew reads allowed (kill switch) | owner |
| `FC_CREW_PEPPER` | Script Properties | ≥ 32 random bytes, base64 | owner |
| `FC_CREW_SELF` | Script Properties | owner's own `<employee-id>` (owner's data) | owner |
| `FC_CREW_ENROLL` | Script Properties | `<code>\|<expiresAtMs>`; code ≥ 128 bits from a password generator (≥ 26 base32 chars) | **owner only** |
| `FC_CREW_STATE` | Script Properties | **the single authoritative state record** (§4.0) | backend, only under the script lock |
| index (`fcx.*`) | **User Properties**, `fcx.` namespace only (§9) | manifest + shard parts | backend (index) |

A roster-token holder cannot write Script Properties, so **cannot create an enrollment code**; without a code
`crewEnroll` always fails. Script Properties are writable only by editors of the Apps Script project (owner).

### 4.0 Authoritative generation protocol (Revision 4)

`FC_CREW_STATE` is one JSON value (< 2 KB) and the **only** source of truth for access:

```json
{ "G": 7, "phase": "active", "pid": "<8 hex>", "epoch": "<16 hex>",
  "grantHash": "<sha256>", "codeHash": "<sha256>", "enrolledAt": 1793750400000,
  "revoke": null,
  "lastRevoke": { "revokeId": "<128-bit>", "G": 6, "outcome": "deleted", "deletedKeys": 64, "at": 1793664000000 } }
```

- `phase ∈ none | active | revoking | deleted`. `G` is a monotonic integer, **incremented by every transition that
  grants or removes access** (enroll, revoke, key rotation, corrupt-index invalidation). It never decreases.
- **Every write of `FC_CREW_STATE` happens under `LockService.getScriptLock()`** as read → check → single
  `setProperty`. A single property write is the atomic transition. No other record grants or removes access.
- Indexers hold the lock only for short **commit sections** (staging writes + manifest commit, target < 2 s); calendar
  reads and shard building happen outside the lock. Revocation therefore waits briefly (≤ 5 s) instead of racing.
- Every index artifact carries `G` and `epoch`: manifest, part keys, part headers, cache keys.

| Transition | Precondition (checked under lock) | New state |
|---|---|---|
| Enroll | valid code (§4.2); `phase ≠ revoking` | `G+1`, `active`, new `epoch`, new `grantHash`, `codeHash` |
| Revoke | authorised (§8.1); `phase = active` | `G+1`, `revoking`, `revoke = {revokeId, credHash: grantHash, cacheKeys, requestedAt}`, `grantHash = null` |
| Revoke complete | `phase = revoking`, deletion confirmed | same `G`, `deleted`, `lastRevoke` filled, `revoke = null` |
| Rotation / invalid index | `pid` mismatch or unreadable manifest | same as Revoke with `revokeId = 'system-<G>'` |

**Rules that make old-generation operations harmless:**
1. An operation captures `(G, epoch)` when it starts and **re-reads `FC_CREW_STATE` inside the lock before every
   write** (staging and commit); any change of `G` or `phase ≠ active` → abort without writing.
2. A manifest is readable only if `manifest.G == state.G` and `state.phase == active`. Parts and cache entries of
   another `G`/`epoch` are never read and are garbage.
3. **Final response authorisation:** `crew` and `crewIndex` re-read `FC_CREW_STATE` immediately before returning; if
   `G` changed, `phase ≠ active` or the grant no longer matches → the computed result is discarded and the response is
   `crew-revoked`. The response's linearisation point is this final check.
4. **Delayed retries never restore access:** a late `crewEnroll` retry matches only if `phase = active`, `G` equals
   the `G` returned by its first success and `codeHash` matches; otherwise `enroll-closed`. A late `crewRevoke` with
   an old `revokeId` returns the recorded `lastRevoke` outcome and **never acts on a newer generation**.

### 4.2 Enrollment protocol (atomic, single use)

1. Owner sets `FC_CREW_ENROLL` = `<code>|<now + ≤ 15 min>` in Apps Script → Project settings → Script properties.
2. App (Settings → Turn on) generates a 256-bit random **grant**, asks the owner to paste the **code**, sends
   `crewEnroll {code, grant}` inside the token envelope.
3. Backend, under `LockService.getScriptLock()` (wait ≤ 5 s, else `busy`):
   - feature on, pepper and self set; else `crew-disabled` / `not-configured`;
   - `FC_CREW_ENROLL` present, expiry in the future **and ≤ now + 15 min** (a longer expiry is refused as
     misconfigured); else `enroll-closed`;
   - constant-time compare of `SHA-256(code)` with `SHA-256(stored code)`. Wrong → increment
     `crew-enroll-failures` (CacheService, 15 min); at **5** failures the backend **deletes `FC_CREW_ENROLL`**
     (code burned) → `enroll-closed`;
   - `phase = revoking` → `busy` (enrollment never interleaves with a deletion in progress);
   - correct → **consume first**: `deleteProperty('FC_CREW_ENROLL')`; **then** write `FC_CREW_STATE` with
     `G+1`, `phase: active`, new `epoch`, `grantHash = SHA-256(grant)`, `codeHash = SHA-256(code)`, `pid`. The
     previous grant (if any) stops working at that single write.
4. Final check (§4.0 rule 3), then response `{ok, enrolled: true, G}`. The app stores `G` with the grant.

Order "consume, then state" is fail-safe: a crash between them leaves no usable code and no new grant →
owner issues a new code (recovery). Nothing can be enrolled twice with one code.

### 4.3 Retry, replacement, expiry, recovery

| Situation | Behaviour |
|---|---|
| Lost enroll response; app retries with the **same code and grant** | Code consumed; `phase = active` and `codeHash`/`grantHash` match → idempotent `{ok, enrolled: true, G}` |
| Same retry arriving **after** a revoke or a newer enrollment | `phase ≠ active` or hashes differ → `enroll-closed`; never restores access |
| Retry with same code, **different** grant | `enroll-closed` (no replacement without a new code) |
| Replace grant (new phone, lost grant, suspected leak) | Owner issues a new code → enroll → `G+1`, old grant dead |
| Code expires unused | Refused; owner may delete it; no state change |
| Roster token rotated (D-011) | Grant record independent; app deletes its local grant on token change → re-enroll needed |
| Pepper rotated | `pid` mismatch → system revoke transition (§4.0) → re-enroll (and §8.5) |
| Revoked | `grantHash` cleared by the revoke transition (§8) |

### 4.4 Request authorization (`crew`, `crewIndex`)

Token (existing, constant time, failure limiter) **and** `FC_CREW_STATE.phase == active` and
`SHA-256(grant) == grantHash` and `pid == current pid`, checked at the start **and again immediately before the
response** (§4.0 rule 3). Wrong grants count toward the existing failure limiter. Crew rate limit: 60 requests /
10 min (CacheService counter), else `rate-limited`.

### 4.5 Ownership of the requested sector

1. `date` valid, ≥ `2022-08-01`, ≤ roster window end; else `bad-range`.
2. Read only the owner's calendars for `[date − 36 h, date + 36 h]` (airline feed for days ≥ today, sync-tagged
   synced copy before, as `roster` does; dedupe by `sourceId`).
3. Find the event with `fcv2Id_('s', sourceId) === sectorId` classified `kind: flight`; else `sector-not-found`.
4. Parse its crew lines. The owner's own line (`FC_CREW_SELF`, compared before hashing) **must** be present; else
   `sector-not-owned` with no crew data.
5. Build its canonical duty (§5) from the same read; only then answer.

---

## 5. Canonical duty reconstruction (resolves B2)

### 5.1 One grouping function

`fcv2GroupDuties_(flights)` = the existing `fcv2Duties_` chaining rule on flights in **exactly** the order
`fcv2BuildRoster_` gives it: sorted by start, then end, **stable** (identical start and end keep input order). A flight
continues the current duty iff `0 ≤ dep − prevArr ≤ 6 h`
(`FCV2_DUTY_GAP_MS_`) **and** `prev.destination === origin`. Check-in and pickup events never affect grouping
(they are not reliably present in both sources). Used by `roster` (byte-identical output, pinned by tests), the
index and the selected flight. Rule version `dutyRules = 1` is recorded in the manifest; any change invalidates the
index (§7.7). Flights with identical start **and** end make the grouping input-order dependent; their duties are
marked `tied` (grouping uncertainty, §6.3) rather than re-ordered. Phase 1a keeps a separate implementation in
`CrewCoreV2.gs` and proves membership and id parity with `fcv2Duties_`, including tied departures; extracting one
shared function from `RosterModelV2.gs` is deferred to Phase 1b (production code untouched).

### 5.2 Identity and ownership

- **dutyKey** = first 16 hex of `SHA-256(first sector sourceId)` — identical to the roster's duty id `d_…`.
- **dutyStart** = first sector's scheduled departure (epoch ms); **dutyEnd** = last sector's arrival.
- **Home month** = base-zone (`Europe/Berlin`) calendar month of `dutyStart`. A duty is stored **only** in its home
  month's shard, even if it crosses midnight or the month end.

### 5.3 Read windows (cross-midnight, cross-month)

- Indexing month M starts with window `W = [start(M) − 36 h, start(M+1) + 36 h)`, groups **all** flights in the
  window, keeps only duties whose `dutyStart` is in M.
- Calendar reads return events **overlapping** `W` (so a long flight that departs before `W.start` is returned), but
  not a predecessor that **ended** before `W.start`. **Edge rule (Revision 4), applied to every returned flight, not
  only kept duties:**
  - *backward:* if any returned flight departs before `W.start + 6 h` (including flights that depart before
    `W.start`), a predecessor ending before `W.start` could chain into it → extend `W.start` by 36 h and re-read;
  - *forward:* if any returned flight arrives after `W.end − 6 h` (including flights that arrive after `W.end`),
    a successor could start after `W.end` → extend `W.end` by 36 h and re-read;
  - repeat until neither condition holds, up to **4 extensions per side**. Still unresolved → anomaly
    `dutyUnbounded` (grouping class, §6.3) for the duties touching that edge; they are **not** indexed.
    **No fallback to calendar days, ever.**
  - Extensions can only add events; the fingerprint (§7.3) covers the **final** window.
- The selected flight's duty uses the same function and edge rule from its §4.5 window; unbounded → response state
  `incomplete`, reason `duty-unbounded`, familiarity not computed for that request.

### 5.4 Encounters and sector detail

- An **encounter** = one completed duty where colleague key K appears on ≥ 1 of its sectors' crew lists (owner's line
  also present on that sector).
- Stored per duty: `[dutyKey, dutyStart, dutyEnd, sectors[[flightNumber, route]...]]`; per key: list of
  `[dutyIndex, sectorBitmask]` — so the UI can say "last DE1234 FRA–PMI" for the actual shared sector, and counts are
  per duty, never per sector or per day.
- **Completed only (Revision 4):** a duty enters the index only if `dutyEnd ≤ now` at build time — **never** "≤ end
  of month". A duty departing 31 Oct 22:30 and ending 1 Nov 06:10 is a completed duty of its **home month October**
  and is stored in the October shard. Future scheduled duties (the synced copy holds ~2 months ahead) are never
  counted.
- **Sealing precondition:** month M is sealed only when every duty with `dutyStart` in M has `dutyEnd ≤ now` (in
  addition to the date rule of §7.5); otherwise M stays open (live) until it does.

### 5.5 Cross-shard deduplication

Aggregation keys encounters by `dutyKey`. If two committed shards claim the same `dutyKey` (possible after a
correction moved a duty across months while only one month was rebuilt), it is counted **once**, and **both** months
are flagged `unreconciled` → results depending on them are **stale** until reconciled (§7.5).

---

## 6. Familiarity and historical accuracy (resolves B3)

### 6.1 Query

For the selected sector S with canonical duty D(S): count = number of distinct `dutyKey`s for key K with
`dutyStart < D(S).dutyStart` and `dutyEnd ≤ now`, excluding `D(S).dutyKey`. Earlier legs of the same duty are the
same encounter as S and never count. Last = the latest such encounter's last shared sector.

### 6.2 Relevant range

All months from 2022-08 **through the month containing `D(S).dutyStart` (inclusive)**, restricted to duties
starting before it. If that month is open (current or not yet sealed), its live computation is part of the range.

### 6.3 Anomalies tracked per month (counts only, never content) — two classes (Revision 4)

**Missing-record class** — can only *hide* encounters (undercount), never add one:

| Anomaly | Meaning |
|---|---|
| `noCrewList` | flight with no parsable crew list |
| `ownerMissing` | crew list without the owner's line (not indexed: ownership unproven) |
| `missingId` | crew line without `<employee-id>` (that person not indexable) |
| `parseFailed` | crew-like line the parser could not read (line skipped) |
| `pending` / `uncovered` | month not yet indexed / not storable (§9.5) |

**Grouping-uncertainty class** — can *split* one real duty into two (overcount) or hide one:

| Anomaly | Meaning |
|---|---|
| `titleFailed` / `hiddenEvent` | a flight title not classifiable, or any unrecognised event (unknown code, other carrier, deadhead marker) between two duties: a hidden sector may connect them |
| `chainBreak` | two consecutive duties whose airports do not connect (`prev.destination ≠ next.origin`) with a gap ≤ the **link span** (§6.3b): a sector is probably missing, **whatever its length** |
| `shortRest` | connected duties closer than a minimum rest (10 h): a connected round trip is probably missing |
| `tiedFlights` | flights with identical start and end: grouping depends on input order (§5.1) |
| `dutyUnbounded` | §5.3 edge rule failed; duties at that edge not indexed |

### 6.3b Linking duties that may be one real duty (Revision 4.1, corrected in the Phase 1a correction pass — binding)

A missing long or connecting sector can create a false duty boundary even when the visible fragments are more than
6 h apart (e.g. FRA→LPA, *missing* LPA→PUJ of 9 h, PUJ→FRA). Two **consecutive** duties `P`, `N` (global time
order, across months) are **linked** iff `N.start − P.end ≤ LINK_SPAN` (**20 h**) **and** one of:
- `chainBreak`: `P.destination ≠ N.origin` (a sector is missing, whatever its length);
- `hiddenEvent`: an unrecognised event (unknown code, unclassifiable title, other carrier, deadhead) lies between them;
- `shortRest`: the airports connect but the gap is **shorter than a minimum rest (10 h)** — two legal duties cannot be
  that close, so a missing connected round trip (X→Y→X) is presumed.

Each duty stores `lpk` (the key of the duty it is linked to). A **suspect group** is a maximal run of linked duties;
links are transitive. Duties whose grouping depends on input order (identical start and end, §5.1) are `tied`.

- **Selected duty:** its own `lpk` is computed with the same rule. Every duty in the suspect group that contains (or
  links to) the selected duty is **excluded before the cutoff and counting** — it may be part of the selected duty.
- **Assumptions (documented, not verified for this airline):**
  - **A1:** a missing sector leaves evidence — a disconnect, an unrecognised event, or a connected gap below 10 h.
    A missing connected round trip that leaves a gap of 10 h or more and no event is **undetectable** (T15h).
  - **A2:** no real duty spans more than 20 h between visible fragments (maximum augmented flight-duty period 18 h
    + 2 h margin). Fragments further apart are treated as separate duties.
- Because A1/A2 cannot be verified from the records, **no count is a claim about real-world duties**: counts are
  **recorded duties** — distinct duties as reconstructed from the available roster records since Aug 2022. They are
  never presented as exact real-world counts and never as guaranteed minimums ("at least").

### 6.3a Counting

For key K: `raw` = distinct recorded earlier duties with K (§6.1, selected group excluded); `groups` = the same with
each suspect group counted once; `uncertain` = at least one of K's recorded duties is in a suspect group of more than
one duty or is `tied`. A member who is `uncertain` gets **no number**; the UI says "Flown together before · number
unclear" (a recorded match exists, its count does not). For everyone else `raw = groups` and the number shown is that
recorded count.

### 6.4 Result states (per response)

| State | Condition | What a number means |
|---|---|---|
| **complete** | Every month in the relevant range is committed (or live), **fresh** (verified ≤ 14 days ago, not `replacing`, not `replaceFailed`, not `unreconciled`, not neighbour-flagged) and has **no missing-record anomaly** | Recorded duties in complete records since Aug 2022 |
| **incomplete** | Every month present is fresh, but ≥ 1 month is pending/uncovered or has missing-record anomalies | Recorded duties in **incomplete** records — not a minimum of real duties |
| **stale** | Any month in the range is not fresh (old verification, `replacing`, `replaceFailed`, `unreconciled`, neighbour-flagged), or the index is inconsistent (`duplicate`, `linkMismatch`), or the whole-query snapshot failed | **No current number**; at most a recorded count labelled "as of <date>" |

Grouping uncertainty is reported separately (`reasons: grouping-uncertain`) and acts **per member** (§6.3a): it can
coexist with complete or incomplete records. Precedence: stale > incomplete > complete. Response:

```json
"history": { "state": "incomplete", "basis": "recorded-duties", "from": "2022-08-01", "relevantThrough": "2026-11",
             "verifiedThrough": "2026-10-21T07:42:00Z", "pendingMonths": 20, "uncoveredMonths": 0,
             "reasons": ["missing-records", "grouping-uncertain"],
             "missing":  { "noCrewList": 3, "ownerMissing": 0, "missingId": 1, "parseFailed": 0 },
             "grouping": { "chainBreak": 1, "hiddenEvent": 0, "shortRest": 0, "tiedFlights": 0, "dutyUnbounded": 0 } }
```

### 6.5 Member classification

| `match` | Rule | UI (synthetic) |
|---|---|---|
| `recorded` | count ≥ 1, not uncertain, state complete | "6 recorded duties together · since Aug 2022" |
| `recorded` | count ≥ 1, not uncertain, state incomplete | "6 recorded duties together · history incomplete" |
| `none` | count 0, state complete | "No earlier match in available records" |
| `none` | count 0, state incomplete | "No earlier match found yet · history incomplete" |
| `uncertain` | a recorded match touches a suspect group or tie | "Flown together before · number unclear" (no number) |
| `stale` | state stale | "6 recorded as of 3 Oct · re-checking" (only when not uncertain) or "Re-checking"; never a bound |
| `suppressed` | no safe statement at all (selected duty unbounded, inconsistent index, snapshot failed) | "Earlier matches unclear"; no number |
| `unavailable` | selected line has no `<employee-id>` | "History not available for this entry" |

---

## 7. Crash-safe incremental index (resolves B5)

### 7.1 Keys (User Properties, `fcx.` namespace only)

| Key | Content |
|---|---|
| `fcx.m` | **manifest** (one value, ≤ 8 KB): `{schema, parser, dutyRules, pid, historyStart, G, epoch, mgen, months:{ "YYYY-MM": [gen, parts, digest, fp, verifiedAt, flags, missing, grouping, bytes] }, retired:[[key, retiredAt]...], cacheKeys, updatedAt}` |
| `fcx.s.<G>.<epoch>.<YYYY-MM>.<gen>.<part>` | immutable shard part (≤ 8 KB encoded); header `{G, epoch, month, gen, part, of}` + gzip/base64 JSON body |

`epoch` = random 64-bit id created at each enrollment; `G` from `FC_CREW_STATE`. Keys of another `G`/`epoch` are
never read and are garbage. `digest` = SHA-256 (128-bit) over the concatenated part bodies of that month generation.
Every key the backend creates, reads or deletes starts with **`fcx.`**; nothing else in the store is touched.

### 7.2 Commit protocol (per month)

For month M, with `(G, epoch)` captured at the start of the call:
1. **Outside the lock:** read M's window (§5.3), build the shard, compute `fp` (§7.3), `digest`, encoded size.
2. **Enter the lock** (wait ≤ 2 s, else stop this call; nothing written). Re-read `FC_CREW_STATE` and `fcx.m`:
   abort without writing if `G`/`epoch` changed, `phase ≠ active`, or `fcx.m.mgen` changed since the shard's base
   read (another commit happened; the next call retries).
3. **Admission (§9.4):** projected peak with this month's new parts ≤ budget. Not admitted → if M was previously
   indexed set `replaceFailed` (stale), else `uncovered: storage` (incomplete); commit only that small manifest change;
   leave the lock.
4. **Stage:** write the new parts `fcx.s.<G>.<epoch>.<M>.<gen+1>.<p>`. Any write error → delete the parts written in
   this attempt, set `replaceFailed`/`uncovered` as in step 3, leave the lock.
5. **Commit:** one `setProperty('fcx.m', …)` with M → `gen+1`, new `digest`, `fp`, `verifiedAt = now`, anomalies,
   `mgen+1`, neighbour flags (§7.4), and the old generation's part keys appended to `retired` with `retiredAt = now`.
   This single write is the atomic commit point.
6. **Leave the lock.** GC (§7.6) runs later, never in the same commit section.

Crash at any step: before 5 → the old manifest is valid and the new parts are orphans; after 5 → the new state is valid
and the old parts are retired. Parts are never modified in place. A manifest that fails to parse → system invalidation
transition (§4.0) and namespace purge (§8).

### 7.2a Replacing an indexed month: mark first, fail closed (correction pass — binding)

A commit for a month that already has a committed generation is a **replacement** (a detected change):
1. **Mark first:** one manifest write sets the month's status to `replacing`. Readers treat `replacing` as **stale**,
   so a crash or any later failure can never leave the old generation reported as fresh.
2. If that marker write fails: **fail closed** — delete the old generation's parts (deletion frees space, so it is the
   write most likely to succeed on a full store). Every reader of that month then finds a missing part, restarts,
   and ends with `snapshot-unavailable` (stale, no counts) until a later replacement succeeds.
3. Then admission, staging and commit as in §7.2. Any later failure tries to record `replaceFailed`; if that write also
   fails, the persisted `replacing` marker already keeps the month stale.
4. **Limitation (documented, T: "unpersisted"):** if the store accepts neither the marker write nor the deletions,
   nothing durable records the failure. The commit returns `replaceFailed-unpersisted`; the **current request** must
   answer stale, but a **later independent request** would still read the old generation as fresh until its
   `verifiedAt` passes the 14-day threshold (then stale) or a `crewIndex` re-verification detects the change. The
   threshold does not schedule that check (§7.5a). This cannot be guaranteed without a durable failure state, which
   by definition could not be written.

### 7.3 Fingerprint (every input that affects grouping or familiarity)

`fp(M) = HMAC-SHA-256(pepper, canonical list)` truncated to 128 bits, over all flight events in M's **final** read
window (after extensions), sorted by `sourceId`, each contributing:
`sourceId, start, end, normalized title, classified kind, origin, destination, HMAC(pepper, normalized crew-line block), parse diagnostics`,
plus `window bounds, parser version, dutyRules, HMAC(pepper, FC_CREW_SELF), historyStart, schema`.
The fingerprint reveals nothing without the pepper and changes on any addition, edit, deletion, time move, title
correction, crew-list change or owner-line change in the window.

### 7.4 Cross-month moves, corrections, deletions

Windows of adjacent months overlap (±36 h), so an event near a month edge affects both fingerprints. Whenever M is
rebuilt and its committed duty set changes, months **M−1 and M+1** get flag `neighbour-changed` → stale until they are
re-verified. A duty moved from M to M+1: M rebuilt (duty gone), M+1 flagged → re-verified → rebuilt (duty present);
until then results are stale, never silently wrong. Duplicate `dutyKey`s across shards → `unreconciled` (§5.5).

### 7.5 Reconciliation is access-driven, by `crewIndex` only (corrected — binding)

- **Sealing:** month M becomes eligible for a durable shard when today ≥ the 8th of M+1 (v5 writes only from the 1st
  of the current month, verified in v5 `Code.gs`; 7-day grace for late runs) **and** all its duties have completed.
  Unsealed months are **open**: computed live from the calendar on every `crew` request (not cached) and therefore
  current for that request.
- **Only `crewIndex` reconciles.** A `crew` query reads the committed index and the live open months; it never
  verifies, rebuilds, writes historical index data or touches `verifiedAt`. (The action dispatcher may perform
  security-state writes and deletions for revocation/rotation recovery, §7.5d.) Nothing runs on a schedule.
- `crewIndex` work order per call (bounded, §7.5c; decided by the shared plan, §7.5d): 1) months flagged
  `replacing` or `neighbour-changed`, and `replaceFailed` when capacity allows; 2) **damaged shards** (missing or
  corrupt); 3) unindexed months newer than the storage floor, newest first; 4) the floor month when capacity allows
  (§9.5, Q25); 5) months whose `verifiedAt` is older than the freshness threshold — or, for "Re-check history", older
  than the moment the re-check started (`verifyBefore`) — oldest first.
- Verification = re-read the month's window, recompute `fp`; equal **and the stored shard valid** → advance
  `verifiedAt` only; different, or shard missing/corrupt → rebuild (§7.2, §7.2a) and flag both neighbours.
- Visible: flight detail footnote "Checked <date>" (oldest verification in the range) and the stale wording; Settings
  shows months indexed / pending / stale / uncovered, the oldest verification and "Re-check history".

### 7.5a Freshness semantics (binding)

- **`verifiedAt`** — when that month's indexed coverage was last successfully checked against the calendar (a commit,
  or an equal-fingerprint re-verification of a **valid** stored shard). Only `crewIndex` sets it.
- **Freshness threshold: 14 days.** It is a threshold, **not a refresh schedule**: nothing re-checks a month
  automatically when it passes. A month older than the threshold is simply **stale** until a `crewIndex` call (started
  by the app, §7.5b) re-verifies it. If the app is not used, months stay stale indefinitely and are shown as such.
- **stale** — verification is overdue (older than the threshold), or the index cannot be trusted as current
  (`replacing`, `replaceFailed`, `neighbour-changed`, duplicate or link mismatch, unreadable snapshot). No current
  number is shown.
- **incomplete** — coverage is missing (months not yet indexed or not storable) or has missing-record anomalies;
  numbers are recorded duties in incomplete records. Grouping uncertainty removes numbers per member (§6.3a).
- **complete** — every relevant month is indexed, its shard valid, fresh at its verification point and free of
  missing-record anomalies.
  "Complete" describes the records **as of `verifiedAt`**, not the calendar at the moment of the query; a calendar
  change inside the threshold is not seen until the next verification.
- Stale or incomplete results are never converted into complete ones by reading; only a successful `crewIndex`
  verification changes the state.

### 7.5b Frontend trigger contract (implemented; release acceptance remains separate)

1. After an authorised enrollment (`crewEnroll` ok), request `crewIndex`.
2. When a private flight detail is opened, request `crew` for that sector.
3. If the response carries `history.indexingSuggested: true` (the shared plan, §7.5d, finds work in this answer's
   months: missing, overdue, flagged, damaged, or the floor when capacity allows), start `crewIndex` through the
   authenticated crew interface (roster token + crew grant). The hint is advisory: `true` is not a promise of
   success; `false` is not proof of completeness (unsupported manifests, capacity-blocked history and grouping
   uncertainty are `false` because indexing cannot help now). Show the state, never the hint, to the user.
4. Respect `rate-limited` and `busy` answers (back off, retry later), the per-call `processed`/`progress` response and
   the server's per-call budget; never loop without a pause.
5. While the app is active (visible), continue unfinished indexing in bounded steps (a few calls, spaced); stop when
   hidden, offline, or when a call makes no progress (`processed: 0`).
6. After indexing progress, refresh the open crew detail by repeating `crew`.
7. If indexing cannot finish (storage floor, repeated errors, offline), keep showing the conservative state from the
   last `crew` response (stale / incomplete / no number) — never an unsupported count.
8. Never call `crewIndex` (or `crew`) before an explicit, successful enrollment, or after revocation, a `crew-revoked`
   / `crew-not-enrolled` answer, sign-out, reset or token change; the stored grant is removed in those cases.
9. Never store `crew` responses in persistent browser storage, service-worker caches or offline snapshots; memory
   only (§10).

### 7.5c Time budget (cooperative, unverified)

The `crewIndex` budget (≤ 6 months and ≈ 15 s per call) is **cooperative**: the elapsed time is checked between
months, so a Calendar read already in progress is never interrupted and a call can exceed 15 s by the duration of
the last read (test: "time budget is cooperative"). It is **not** a hard execution deadline. Actual Apps Script
execution time, the 6-minute platform limit, quotas, `LockService` waits and Calendar latency are **unverified** and
must be measured in the synthetic backend project before release (Phase 1d).

### 7.5d Damaged shards, eligibility and the indexing hint (targeted recovery fix — binding)

- **Integrity before verification.** A committed month is *valid* only if every part exists, its header names the
  current `G`/epoch/month/gen, the digest matches the manifest and the **encoded payload** passes strict validation
  **before any decoding** (`fcv2CrewValidPayload_`, the only acceptance rule, used by snapshot reads, the integrity
  check, the unchanged-fingerprint shortcut, the indexing plan and therefore reconstruction decisions):
  - exactly `{v, m, k, d}`; `v` equals the supported payload version (1); `m` equals the committed month;
  - `k`: unique 22-character base64url colleague keys;
  - `d`: tuples of exactly 6 fields `[key (16 hex, unique), startMinute, endMinute, lpk (16 hex or ""), sectors,
    tied]`; minutes are finite integers between 2000-01-01 and 2100-01-01, `end ≥ start`, at most 14 days, and the
    start lies in month `m` (base zone);
  - sectors: non-empty, each exactly `[flightNumber (1–12 chars), "AAA-BBB", [integer key indices within k]]`;
  - `tied` is exactly `0` or `1`.
  Nothing is coerced (no `null`→0, no truthiness, no out-of-range lookups); anything else is rejected, which makes
  the whole query stale with no counts and the month eligible for immediate rebuild. A *missing* or *corrupt* shard is scheduled for repair by
  `crewIndex` **immediately** (no freshness wait) and rebuilt from the source records through the crash-safe commit
  (§7.2, §7.2a, neighbour flags). An unchanged source fingerprint is **never** enough to skip it or to advance
  `verifiedAt`. Readers apply the same structural check: damaged content makes the whole query stale with no
  counts until the rebuild commits; a failed rebuild leaves the month `replaceFailed` (stale).
- **One eligibility decision.** `fcv2CrewIndexPlan_` (pure; store reads only, no Calendar read, no write) decides what
  indexing could do, in order: flagged months (a failed replacement only when capacity allows), damaged shards,
  unindexed months above the storage floor, the floor month when capacity allows (Q25), overdue months. `crewIndex`
  takes its next month from it; the `crew` response's `history.indexingSuggested` is `true` iff the plan contains a
  month of that answer's range.
- **The hint is advisory.** `true` means indexing is *worth attempting* — not that it will succeed (a later Calendar
  read, admission or lock can still fail). `false` means indexing cannot currently improve *this* answer — it is
  **not** proof of completeness, verification or health: it is also `false` for an unsupported or invalid manifest
  (indexing refuses to touch it), for capacity-blocked history below the floor (re-evaluated on every query, so it
  becomes `true` once capacity is available) and for grouping uncertainty (indexing cannot resolve it).
- **The 14-day threshold is not a repair delay.** Damage, flags and missing months are eligible at once; only the
  re-verification of intact, unflagged months waits for the threshold (or an owner-started re-check).
- **What a `crew` request may write.** An ordinary `crew` query never writes historical index data and never advances
  `verifiedAt`. The shared action dispatcher may, before any query runs, perform **security-state writes and
  deletions**: completing an interrupted revocation or a pepper rotation (state record and `fcx.*` purge, §8.5), and
  incrementing the rate-limit counter in the cache.

### 7.6 Whole-query snapshot reads and garbage collection (Revision 4.1 — binding)

Readers (`crew`) never take the lock. A query uses **one committed manifest for every month it depends on**:
1. Read `fcx.m` **once**; require `manifest.G == state.G`, `epoch` equal, `phase = active` (else no index → §6.4).
2. Read the parts of **all** sealed months in the relevant range referenced by **that** manifest (one bulk read).
3. Validate **every** part against that manifest: present; header `{G, epoch, month, gen, part, of}` matches the
   manifest entry; each month's concatenated digest equals the entry's `digest`.
4. Any failure in any month (a commit of an adjacent month, a GC, a generation change, a delay beyond the GC grace)
   → **discard everything read in this attempt and restart the whole query from step 1** with a fresh manifest.
   Never mix months from two manifests, never retry one month in isolation.
5. At most **3 attempts**. Exhausted → state **stale** with reason `snapshot-unavailable` and **all counts `null`**
   (members `suppressed`); no partial or per-month authoritative counts are returned.
6. Open (unsealed) months are computed live in the same request and joined to the snapshot; links (`lpk`) across the
   sealed/open boundary are checked like any other (`linkMismatch` → stale).
7. The final authorisation check (§4.0 rule 3) still runs before the response.

Because a commit can change duty identities across adjacent months (a duty moving from October to November changes
both shards), only a single-manifest snapshot guarantees that every duty is seen exactly once.

GC (in `crewIndex` calls, under the lock):
- deletes `retired` parts only when `retiredAt` is older than **120 s**, then removes them from `retired`;
- deletes orphans: `fcx.s.*` keys neither referenced by the manifest nor in `retired`. Staging and commit happen in
  the **same** lock section (§7.2), so no legitimately staged part can exist unreferenced outside the lock;
- never deletes anything outside `fcx.`.
A reader delayed beyond 120 s may find parts gone; step 4 restarts it, so the grace period is an optimisation, not a
correctness condition.

### 7.7 Global invalidation

`schema`, `parser`, `dutyRules`, `pid`, `historyStart` or `epoch` mismatch between code/properties and `fcx.m`
→ the index is **logically invalid** immediately (all results stale/absent) → purged (§8.3) and rebuilt only after a
valid grant exists. Code meeting a manifest with a **newer** schema never writes or deletes it (another deployment,
§9.3) and answers `index-incompatible`.

**Manifest validation (correction pass — binding).** Before any read, commit or GC the manifest is parsed and
validated: `schema` equals the supported version (1); `G` integer ≥ 1; `epoch` non-empty string; `mgen` integer ≥ 0;
`months` an object of `YYYY-MM` → 7-element entries (`gen`, `parts` ≤ 3, 32-hex `digest` when parts > 0,
`verifiedAt` minutes, a known status code, missing/grouping counters of the right length); `retired` entries are
`[fcx.s.* key, time]`; `cacheKeys` are `fcx.*` strings. Unparsable, unsupported or malformed → `index-incompatible`
for readers and commits, GC skipped, **nothing modified**. Only an explicit revocation or owner purge deletes such data
(§8: deletion always works).

---

## 8. Revocation and deletion (resolves B4; Revision 4: namespace-safe, generation-based)

### 8.1 Authenticated, idempotent `crewRevoke {revokeId}`

- `revokeId`: 128-bit random generated by the app, reused on every retry of the same revocation.
- Auth: roster token **and** either the current grant (`phase = active`), or — retries only — `SHA-256(grant) ==
  state.revoke.credHash` with the same `revokeId` (`phase = revoking`).
- A `revokeId` equal to `state.lastRevoke.revokeId` returns the recorded outcome without acting (lost response,
  delayed retry). Any other old `revokeId` → `stale-request`, no action; **never** acts on a newer `G`.
- **Not gated** by `FC_CREW_ENABLED`, enrollment code or index schema: deletion always works.

### 8.2 Steps

1. **Logical invalidation** — under the lock (wait ≤ 5 s; commit sections are short, §4.0; else `busy`, app retries
   with the same `revokeId`): read `fcx.m` and **capture its `cacheKeys`**, then one write of `FC_CREW_STATE`:
   `G+1`, `phase: revoking`, `grantHash: null`, `revoke: {revokeId, credHash, cacheKeys, requestedAt}`.
   From this write on every crew read, index commit, enrollment and final response check fails (§4.0). The cache
   keys are now safe in the state record, so deleting the manifest later cannot lose them.
2. **Physical deletion (namespace-safe)** — still under the lock, or in a later call with the same `revokeId`:
   - `keys = getKeys().filter(k => k.startsWith('fcx.'))` — manifest, committed parts, retired parts and **orphans of
     any `G`/epoch**;
   - delete parts first, the manifest `fcx.m` **last** (a crash mid-way leaves a manifest whose `G` is already
     invalid, so nothing is readable, and the next attempt finds the remaining keys);
   - `CacheService.removeAll(state.revoke.cacheKeys)`;
   - delete `FC_CREW_ENROLL` if present.
   - **Never** `deleteAllProperties()`; never a key outside `fcx.`.
3. **Confirm** — re-list: no key starting with `fcx.` remains **and** the count of non-`fcx.` keys equals the count
   before step 2. Yes → one write of `FC_CREW_STATE`: `phase: deleted`, `lastRevoke = {revokeId, G, outcome:
   'deleted', deletedKeys, at}`, `revoke: null`. No → stay `revoking`, response `revoke-incomplete`.
4. Response `{ok, state: 'deleted' | 'revoking', deletedKeys, cacheExpiresBy}` — sent only after the final state read.

| Case | Outcome |
|---|---|
| Lost response | Retry with same `revokeId` → recorded outcome (`lastRevoke`) or resumed deletion |
| Crash between steps | `phase = revoking` keeps everything refused; retry, or any later crew call by the owner's app, resumes step 2 |
| Concurrent indexing | Revoke waits for the indexer's short commit section; the indexer's next lock entry sees `G` changed → aborts; any parts it staged carry the old `G` and are deleted by step 2 (prefix match) |
| Indexer computing outside the lock during revoke | Its commit is refused (`G` changed); nothing published |
| Reader mid-request during revoke | Its final authorisation check fails → `crew-revoked`; no result returned |
| Deletion throws / partial | `revoke-incomplete`; retry deletes the remainder; unrelated keys untouched |
| Feature disabled (`FC_CREW_ENABLED` deleted) | Revoke still works; the kill switch alone stops processing but deletes nothing (README says so) |
| Grant lost on device | Owner purge (§8.3) |
| New enrollment after revoke | Only from `phase = deleted` with a new code: `G+1`, new `epoch` |

### 8.3 Owner purge path (Phase 1d.2A — simulated only, not deployed)

Editor-run function `crewPurgeAll()` in `CrewApiV2.gs` (a thin wrapper around the pure, Node-tested
`fcv2CrewPurgeAll_(env)`). It has no web entry point: `fcv2CrewHandle_`, `fcv2HandlePost_` and `fcv2HandleGet_`
refuse the action name (tested), and the project serves no HtmlService page, so it is not reachable through
`google.script.run` (RouterV2 guarantee). It is the only public function besides `doGet`/`doPost`, because the
editor's Run menu hides names ending in `_` (exception to the `_` naming rule, Q7; pinned by
`tests/backend-router.test.js`). User Properties are **not** visible in the Apps Script UI, so this is the owner's
only manual deletion path for the index.

What it does, under the script lock (`tryLock`, short wait; otherwise `busy`, nothing changed):

1. If `FC_CREW_STATE.purging` is already `true`, this is a **retry** of an unfinished purge: it proceeds without
   the confirmation (the persisted fence is the owner's durable intent). Otherwise Script Property
   `FC_CREW_PURGE_CONFIRM` must equal exactly `PURGE-ALL-CREW-DATA`; absent or different → `refused`, nothing changed.
2. **Durable fence** — one write of `FC_CREW_STATE`: `G+1` (only when not already fenced), `phase: deleted`,
   `grantHash: null`, `revoke: null`, `purge: null`, `purging: true` and `purgeCacheKeys` (the registered cache keys
   from the manifest and the state, merged with any an earlier run kept), verified by read-back. A failed or lost write
   → `incomplete`/`error` with nothing destroyed and the confirmation kept. Only after the verified fence is the
   confirmation deleted (consumed). While fenced, every enrollment is refused (`enroll-closed`, no failure counted,
   code neither burned nor consumed), every grant is refused, and cancellations (§8.7) still work and keep the fence.
   The `cancelled` tombstones and `codeHash` are kept.
3. Deletes `FC_CREW_ENROLL`, every `fcx.*` User Property (namespace-safe, §8.2 step 2) and the cache keys kept in the
   fence.
   It never touches `FC_V2_TOKEN`, `FC_CREW_PEPPER`, `FC_CREW_SELF`, `FC_CREW_ENABLED` or any other property.
4. Verifies: no enrollment code, no `fcx.*` key, deletion complete, cache removal succeeded. Only then one write
   removes the fence (with `purgeCacheKeys`) and records the **unbound** receipt `lastRevoke = {revokeId: 'purge-<old G>', G: <old G>, outcome: 'deleted',
   deletedKeys, at, aliases: []}` (no `credHash`, so it never answers a revoke); read back → `deleted`. Any failure or
   exception after step 2 leaves the fence (`incomplete` / `error`, never `deleted`).

It returns and logs **only** `{outcome: 'deleted'|'incomplete'|'refused'|'busy'|'error', deletedKeys, remaining}`
(no ids, names or hashes; an exception yields `error` without a message).

**When to use it:** a rollback to a backend version without the crew files while a deletion is still pending (the
app can no longer complete it); a revocation stuck at `revoke-incomplete`; a lost device whose grant can no longer
revoke.

**Procedure (owner, Apps Script editor):**

1. Project settings → Script properties → add `FC_CREW_PURGE_CONFIRM` = `PURGE-ALL-CREW-DATA`.
2. Editor → select `crewPurgeAll` in the function menu → Run.
3. Executions (or the run log): read the single line, e.g. `{"outcome":"deleted","deletedKeys":12,"remaining":0}`.
   `incomplete` or `error` after the fence → simply Run again (no property needed: the fence persists until the
   purge completes); `incomplete` with nothing done (fence write failed) → the property is still set, Run again;
   `busy` → wait a moment and run again (the property is still set); `refused` → the property value was wrong.
4. Confirm that `FC_CREW_PURGE_CONFIRM` is gone from Script properties.

Cache-key recovery (Phase 1d.2C step 1, simulated only): the cleanup keys are written into the fence **before**
anything is destroyed, so a run that fails after the manifest was deleted (interruption, or `removeAll` throwing →
`incomplete`) leaves them in `FC_CREW_STATE.purgeCacheKeys`, and the retry removes them. They are cleared only in
the final write, after removal succeeded. Cancellations while fenced keep them (Object.assign). Tested in
`tests/crew-cancel.test.js` (interrupted run, failing removal, success, fenced cancellation). Cache entries hold
only numeric counters and are generation-scoped; this closes the former P2 debt from Phase 1d.2A.

Unreadable manifest (Phase 1d.2C step 1B, simulated only): an absent manifest means "no registered keys"; a manifest
that cannot be read, is not valid JSON, is not an object, or has no `cacheKeys` list of strings is **unknown**, never
empty. The run still writes the fence (access stays blocked, confirmation consumed) but destroys nothing and answers
`incomplete`; a retry reads the manifest again. There is no automatic completion, however much time has passed.

Corrupt durable state (Phase 1d.2C step 1C, simulated only): `FC_CREW_STATE` that cannot be read, is not valid JSON,
is not an object, or has an invalid authorization, fence or cleanup field (`G`, `phase`, hashes, `purging`,
`cancelled`, `revoke`, `purge`, `purgeCacheKeys` and their key lists) is never replaced by the initial state and
never overwritten. Enrollment, `crew`, `crewIndex` and `crewRevoke` (including cancellations) answer
`crew-unavailable`; `capabilities` offers only `crewRevoke`; the purge answers `error` and destroys nothing. Only a
genuinely absent state starts from the initial state.

Purge-fence invariant (Phase 1d.2C step 1D): a state with `purging: true` is valid only with `phase: deleted`,
`grantHash: null` and no `revoke` or `purge` object; those are exactly the values the fence writes, and the only
other writer of a fenced state (a cancellation) changes nothing but `cancelled`. Stale `pid`, `epoch` and `codeHash`
are carried over and grant nothing. A fence combined with an active phase, a grant, a revocation or a pending
generation purge is contradictory and treated as corrupt (as above). A legitimate fence keeps the unchanged
capabilities contract (all actions while the switch is on; the runtime answers `enroll-closed` / `crew-not-enrolled`).

**Owner-recovery limitation (open):** a permanently corrupt manifest or `FC_CREW_STATE` keeps the purge at
`incomplete` / `error` indefinitely, and the crew data is then not deletable through this path. Recovering from it
needs a separately reviewed mechanism; none exists yet (no automatic timeout, by decision in step 1C).

**Frontend afterwards:** the app's grant now answers `crew-not-enrolled` / stale; the app cleans up its local record
conservatively. That is **not** a frontend-confirmed deletion: the confirmation is the editor log of step 3.

### 8.4 Cache keys

CacheService cannot enumerate keys. Crew cache keys are derived only from the registry in the manifest (`cacheKeys`:
aggregate chunk keys, open-month keys), all contain `G` and `epoch`, and the registry is **copied into
`FC_CREW_STATE.revoke` in the same transition that invalidates access** (§8.2 step 1). Purge removes every registered
key; any unregistered remnant belongs to an old `G` (never read again) and **expires ≤ 6 h** (CacheService maximum
TTL). The response reports `cacheExpiresBy`; cache deletion is confirmed by TTL, not by enumeration. Cache entries hold
only pseudonymous data, never names.

### 8.5 Key rotation (corrected in the Phase 1b correction pass)

Owner sets a new `FC_CREW_PEPPER` → new `pid`. Next crew call: `pid` mismatch → system revoke transition (§4.0,
`revokeId = 'system-<G>'`) → namespace purge. The system revocation records `credHash` = the grant that was current,
so **the owner's app can authenticate the resumption** if the purge is interrupted: any crew call carrying that
grant while `phase = revoking` resumes and completes the deletion (it only deletes; it never grants access, and a
caller without that grant triggers nothing). A new owner-issued enrollment code is the second recovery path: it
supersedes the stuck revocation under the lock (§8.6). No manual property editing is needed. Access under the old
pepper is never restored: every grant is bound to the current `pid`. Rotation on suspicion of exposure (Q9).

### 8.6 Re-enrollment and obsolete generations (Phase 1b correction pass — binding)

- Enrollment always creates a new generation `G+1` and epoch. An index of an **older** generation is **obsolete**:
  readers and commits treat it as absent (never reinterpreted), GC treats its keys as orphans, and the first commit
  of the new generation overwrites the root.
- In the same locked transition the enrollment purges every `fcx.*` key that does not belong to the new generation
  (namespace-safe; unrelated keys untouched) and removes the previous root's registered cache keys. If deletion fails,
  `state.purge.pending` stays set and the next `crewIndex` resumes it under the lock before indexing.
- A valid owner code also **supersedes an interrupted revocation** (including a stuck rotation): the revocation is
  recorded as `superseded` in `lastRevoke` (its id stays idempotent), and its pending deletion becomes the new
  generation's purge. Without a code, nothing changes (`enroll-closed`).
- Cache-removal failures never block a revocation, rotation or generation purge: entries are generation-scoped
  (unreachable) and expire within 6 h; the response reports `cacheCleared: false`. Exception: the owner purge
  (`crewPurgeAll`, §8.3) keeps its fence and the keys and answers `incomplete` until a retry removes them.

### 8.7 Enrollment cancellation (Phase 1d.2A — simulated only, not deployed)

Problem: an enrollment request whose answer never arrived (timeout, closed tab) leaves the app with an
**unresolved candidate grant**. Before Phase 1d.2A a revoke with that grant answered `stale-request` (it was not the
active grant), so the app could neither confirm that the candidate was dead nor stop a delayed enrollment from
activating it later; the deletion stayed pending as `unresolved-enrollment`.

**Backend (`crewRevoke`).** This section supersedes the "any other old `revokeId` → `stale-request`" bullet of §8.1
for revokes whose grant is neither the active nor the revoking grant. Order of checks, under the lock:

1. `lastRevoke` receipt with the same `revokeId` **and** a `credHash` equal to the first 32 hex digits of this
   grant's hash → the recorded outcome (idempotent). Receipts written for a known grant (revocation done,
   superseded by an enrollment, pepper rotation) carry `credHash`. A receipt **without** `credHash` (older records,
   system receipts without a grant, purge receipts) **never** answers; the request falls through to steps 2–4.
   Consequence: a lost answer of a revocation recorded before Phase 1d.2A is re-answered as `cancelled` (never as
   a false `deleted`).
2. `phase = active` and this is the active grant → normal revocation (§8.2), unchanged.
3. `phase = revoking` with this grant → resume (same `revokeId` or a system revocation), unchanged.
4. Otherwise → **cancellation**: the grant hash (32 hex) is appended to `FC_CREW_STATE.cancelled` (cap 64 entries,
   no eviction; full → `busy`). Everything else in the state is byte-identical (G, phase, grant, revoke, purge,
   epoch, index, `FC_CREW_ENROLL`). The write is read back; a failed or lost write → `crew-unavailable`, nothing
   claimed. Already tombstoned → `{state: 'cancelled', recorded: true}` without a write.
   Answer: `{ok: true, action: 'crewRevoke', state: 'cancelled', deletedKeys: 0}`.

**Backend (`crewEnroll`).** The first check: a tombstoned grant → `enroll-closed` — no failure counted, the code is
neither burned nor consumed, so the owner's outstanding code still works for a new grant. A newer active grant is
never affected by cancelling another grant.

**Capability.** `capabilities` always carries `limits.crewCancel: 1` (`fcv2CrewCapabilities_`): with every crew
action while crew is enabled, and with `crewRevoke` only while the kill switch `FC_CREW_ENABLED` is off (revocation
is never gated, §8.1). The frontend trusts a `cancelled` answer **only** when the current access answered a valid
v2 `capabilities` that lists `crewRevoke` and `crewCancel === 1` exactly (`crewCancelSupported`; absent, `2`, `"1"`
→ not trusted). It does not require the other crew actions, so crew stays hidden (`crewSupportedBy`) while a
deletion can still complete. Untrusted → `invalid-response`; the deletion stays pending and nothing is reported as
deleted.

**Capability capture.** The service asks `cancelSupported(access)` **before** each revoke dispatch, with the
access snapshot (endpoint, token, access id) the request is sent with; the runtime answers from its capability
cache for exactly that access id (unknown → false). The captured boolean validates that response; nothing current
is consulted after the await, so a capability learned for another backend never upgrades an answer. A response
resolves only the entry the request was sent for, which belongs to that request's endpoint (Stage A per-entry
evidence rule); while a deletion is pending no other endpoint can gain an entry (enrollment answers
`revoke-pending`).

**Frontend.** A trusted `cancelled` resolves only that grant entry as dead (never a deletion claim; a deletion
consisting only of cancelled candidates ends as `superseded`, the record removed). Capability is learned per access
id. Exception to "no request while crew is disabled": when a persisted pending deletion still holds any unresolved
entry (candidate or confirmed grant, both may be answered `cancelled`) and the capability for this access is unknown, the runtime fetches `capabilities` **once per access per
session** to learn `crewCancel`. Without the capability (older backend) the deletion stays pending as
`unresolved-enrollment`, as before.

## 9. Storage model (evaluation against documented limits)

### 9.1 Documented constraints (Apps Script quotas; re-verify at implementation)

| Limit | Value | Consequence |
|---|---|---|
| Property value size | **9 KB per value** | parts ≤ 8 KB encoded; manifest ≤ 8 KB |
| Property store total | **500 KB per store** | the index budget; keys + values counted conservatively |
| Properties read/write | daily quota (consumer accounts lower than Workspace) | bulk `getProperties()` per request; quota figure to be re-checked |
| CacheService | ≤ 100 KB per value, TTL ≤ 6 h, eviction possible | never authoritative |

### 9.2 Store choice

| Option | Verdict |
|---|---|
| **User Properties**, `fcx.` namespace (recommended) | Not used by any project code today (verified by search of `backend/` and the private v5 copy), but **not assumed exclusive**: crew code reads, writes and deletes only keys starting with `fcx.` and counts other keys toward the 500 KB budget; separate from production secrets in Script Properties; no new scope. The web app must execute as the owner: the private v5 manifest says `executeAs: USER_DEPLOYING` (**unverified for the live deployment**, Q4) |
| Script Properties | Shares namespace and quota with `FC_V2_TOKEN` and other production secrets → rejected for the index (used only for small crew control records, §4.1) |
| Google Sheet / Drive file | **Not used.** Automatic Sheet fallback removed. Any other store needs a new founder decision (Q5) |

### 9.3 Execution identity and multiple deployments

- All deployments of the script (versioned and the `/dev` head) **share** the same Script and User Properties when
  executing as the owner. Rules: crew code refuses to write a manifest of another `schema`; the release checklist forbids
  testing crew code on the production project's `/dev` deployment while `FC_CREW_ENABLED=on`; tests run against
  the separate synthetic backend project (`docs/IPHONE-ACCEPTANCE.md` Setup A).
- If the deployment ever executed as "User accessing", User Properties and calendars would belong to the visitor —
  unsupported; capabilities omit crew actions unless `Session.getEffectiveUser()` equals the script owner (to verify).

### 9.4 Peak storage and admission (Revision 4; estimates **not measured**)

All sizes are **encoded UTF-8 bytes of key + value**, KB = 1,000 bytes (conservative), limit 500,000 bytes for the
whole User Properties store — including any non-`fcx.` keys (`U`), which crew code never touches but must count.

**Peak during a month replacement** (old and new generations coexist until GC):

```
peak = U                    non-crew user properties (measured)
     + C                    committed parts of all months (current generations)
     + R                    retired parts still inside the 120 s GC grace (measured)
     + O                    orphans from crashed attempts (measured; GC runs first when O > 0)
     + N                    new parts of the month being staged (≤ 3 parts × 8 KB; more → anomaly shardTooLarge, month uncovered)
     + M_res                manifest reserved at its 8 KB cap (not its current size)
     + K                    key-name bytes of every fcx.* key incl. new and retired parts
     + S                    accounting safety margin 16 KB (encoding/quota-accounting uncertainty)
admission: peak ≤ 500,000 bytes, else not staged (§9.5)
```

| Item | Estimate today (51 months) |
|---|---|
| `C`: per month 4–7 KB (~20 duties, ~40 sectors, ~80–150 distinct 22-char base64url keys; gzip barely compresses random keys) | 204–357 KB |
| `K`: ~51–102 part keys × ~40 bytes + manifest key | 2–4 KB |
| `N`: typical one part, worst three | 6–24 KB |
| `R`: steady state 0; during re-check rebuilds ≤ the months replaced in the last 120 s | 0–24 KB |
| `M_res` + `S` | 24 KB |
| `U`, `O` | 0 expected (measured at runtime) |
| **Peak** | **≈ 236–433 KB** |
| Growth of `C` | ~50–85 KB / year |

Committed history can grow until `C ≈ 500 − (M_res + S + N_max + R_max + K) ≈ 420 KB`, i.e. **between ~2027 and
~2031** depending on real sizes. Phase 1a replaces these estimates with measurements of realistic synthetic data;
Phase 1d reports real bytes (`crewIndex` returns `{U, C, R, O, K, peakLastCommit}`, no content). Reduction options if
needed (each needs approval): shared key dictionary; dropping sector bitmasks.

### 9.4a Measured (Phase 1a, synthetic — 2026-10-22, re-run after the correction pass)

Measured by `tests/crew-core.test.js` (storage test) on a generated history, Aug 2022 → Oct 2026 (51 months), one
FRA-based cabin crew member: 1,410 flights, 730 duties, short-haul days (6 crew) and long-haul rotations (12 crew), at
least 12 h between duties, colleagues drawn from synthetic pools of 700 cockpit / 2,600 cabin with a recency bias.
Real rosters may differ; these are **measurements of synthetic data, not of the owner's history**.

| Measure | Observed (seed 7) | Range over seeds 1–5, 7 |
|---|---|---|
| Encoded month body (gzip + base64) | min 2,012 · median 2,940 · p90 3,316 · max 3,844 bytes | median 2,684–2,940 · max 3,572–3,844 |
| Distinct colleague keys per month | median 76 | 68–76 |
| All 51 month bodies | 146,100 bytes | 139,844–146,100 |
| Whole `fcx.*` store after committing all months (keys + values, 52 keys) | 153,177 bytes | — |
| Manifest (compact entries) | 4,471 bytes (~88 bytes per month) | — |
| Parts per month | 1 (every month < 8,000 characters) | — |
| Growth of month bodies | ≈ 34 KB per 12 months | — |

| Calculated (not observed) | Value |
|---|---|
| Replacement **admission estimate** for the largest month (formula §9.4: store bytes − manifest + 8 KB manifest reserve + new parts + 16 KB safety) | 176,745 bytes of 500,000 — a calculated admission figure, **not an observed peak**; the fake store never held old and new generations of every month at once |

Consequences (planning only; estimates stay unverified for real data):
- The **store** limit would be reached around **2035** at ≈ 35 KB/year.
- The **manifest** 8 KB cap binds first: ≈ 88 bytes/month → ≈ 90 months → around **early 2030**. A manifest split is
  a schema change to plan before then (Q17).
- Phase 1a found and fixed a real defect: verbose manifest entries (~230 bytes/month) exceeded 8 KB after ~32 months.
- **Requirement retained for integration (Phase 1b/1d):** storage capacity must be re-validated against the real
  Apps Script property store (actual byte accounting, real gzip, real history sizes) before release.

### 9.5 Exhaustion behaviour

Admission runs inside the commit section (§7.2 step 3) on **measured** sizes (bulk read of all keys' sizes):
- not admitted, month **never indexed** → `uncovered: storage` (small manifest change) → **incomplete**;
- not admitted, month **previously indexed** with a detected change → `replaceFailed` → **stale** (§6.4); the old
  parts stay as the last valid generation but are no longer claimed to be current;
- a write that throws despite admission → delete the parts staged in this attempt; same two outcomes; manifest
  otherwise unchanged.
Build order newest → oldest means exhaustion leaves the **oldest** months uncovered; UI: "History back to <month>
(storage limit reached)". No automatic eviction, no fallback store. The manifest write itself must always fit: it is
reserved at 8 KB in every admission.

---

## 10. Privacy: what is read, retained and deleted

| Data | Read | Retained | Deleted |
|---|---|---|---|
| Crew lines (rank, `<employee-id>`, names) of owner's flights 2022-08 → now | During indexing (month windows) and for the selected sector | **Never** retained as such | — |
| `<employee-id>` | Transiently | Never; only HMAC-SHA-256 (pepper) truncated to **128 bits** | — |
| Pseudonymous index: keys, duty keys/times, own flight numbers/routes, anomaly counts, fingerprints | — | User Properties until revoke/rotation/purge | `crewRevoke`, `crewPurgeAll`, rotation |
| Colleague names + ranks | Selected, owned sector only | **Not on server.** On device: memory only (10 min, ≤ 8 sectors) | Opt-out, Sign out, Reset, token change, 10 min hidden |
| Grant | — | Device (next to the roster token); server keeps only its SHA-256 | Revoke / re-enroll |
| Cache entries | — | ≤ 6 h, pseudonymous only, epoch-scoped | Registered keys removed; rest expires |
| Tombstone | — | `revokeId`, state, timestamps, counts (no crew data) | Owner may delete |

Safeguards:
- **No crew data in logs, diagnostics, exports or offline caches.** No `Logger.log`/`console` of crew content. Every
  crew code path catches exceptions and returns **codes only**; exception messages never include parsed text — the
  project uses Stackdriver exception logging (`exceptionLogging: STACKDRIVER` in the private manifest), so an
  uncaught error message could otherwise land in Cloud Logging. Test: forced failures produce no crew text in
  thrown messages.
- Responses never include `<employee-id>`, keys, crew bases, booking codes, other sectors' crew, or index internals.
- Device: not in `localStorage` (except `crew.enabled` and the grant), `roster.v1`, IndexedDB, service-worker cache
  (POST is not cached; test pins it), exports, diagnostics or About.
- Only editors of the Apps Script project can read the stores; owner must remain the sole editor (Q6).
- The crew lists remain in the owner's own roster calendar (feed + synced copy) and in v5 notes; Crew Intelligence
  neither creates nor deletes them. The app says so.
- Single user only; airline-policy and data-protection clearance unresolved (Q1).

---

## 11. UI changes from Revisions 3–4 (mockup copy updates)

| Mockup element | Revision 4 |
|---|---|
| "Flown together 6×" | **Replaced** by "6 recorded duties together · since Aug 2022" (complete) or "· history incomplete" (incomplete); footnote "Recorded in your roster since Aug 2022 · counted per duty before this flight · checked 21 Oct" |
| "First flight together since Aug 2022" + **New** tag | **Replaced** by "No earlier match in available records"; the **New** tag is removed |
| "At least 6×" | **Removed.** Members whose recorded matches touch a grouping uncertainty show "Flown together before · number unclear" (no number); there is no "at least" anywhere |
| New: stale | Neutral (no copper ring): "6 recorded as of 3 Oct · re-checking" or "Re-checking"; banner "History is being re-checked" |
| Opt-in sheet | Adds step "Paste the enrollment code from your Apps Script settings"; wording: "counts shared duties" |
| Settings | Months indexed / pending / uncovered, oldest check date, missing-record and grouping counts, "Re-check history", "Forget crew data" (revoke) |
| States board | Adds `revoke-pending` ("Deleting… will finish next time you're online"), `crew-revoked`, `index-incompatible` |

---

## 12. Performance strategy (release targets; synthetic evidence in §9.4a/§16a)

| Metric | Target | Measurement |
|---|---|---|
| Pure core CPU, 52 synthetic months × 45 events | < 2 s in Node | Phase 1a benchmark |
| Shard size distribution | median ≤ 6 KB, max ≤ 8 KB per part | Phase 1a synthetic; Phase 1d real (`crewIndex` reports bytes) |
| Peak storage (§9.4) | measured peak ≤ 450 KB with today's history | Phase 1a synthetic; Phase 1d real |
| Commit section (lock held) | ≤ 2 s per month | Phase 1a fake env with simulated write latency; Phase 1d real |
| Initial backfill | ≤ 8 `crewIndex` calls, ≤ 3 min wall clock | Phase 1d, owner-run; response `timings` (ms per month, events, bytes — no data) |
| Warm `crew` | p50 ≤ 3 s, p95 ≤ 6 s (read-only: snapshot + live open months; no reconciliation) | App measures (memory only), owner records 10 samples |
| Per call worst case | ≈ 15 s server work, **cooperative** (can be exceeded by one in-progress Calendar read, §7.5c); < 30 s client timeout | Budgeted loops; slow fake-env test; real timings unmeasured |
| Properties quota use | ≤ 5 % of the daily quota on a heavy day | Count reads/writes per call in tests; check documented quota |

If targets fail: half-month windows; fewer verification steps per call; never a full scan in one request.

---

## 13. Synthetic acceptance tests (binding for Phase 1a/1b; Node, fake env, no live data)

The fake environment models: a script lock with interleaving control (tests can pause any call at any step), a
User Properties store with the 9 KB / 500 KB limits measured in UTF-8 key + value bytes and injectable write failures,
a CacheService with TTL, and two calendars with synthetic events. All crew text and identifiers are generated at runtime.

| # | Scenario | Expected (binding) |
|---|---|---|
| T1 | **Enrollment takeover:** token only, no code; expired code; expiry > 15 min; 5 wrong codes then the right one; correct code reused with a different grant; two concurrent enrolls with one code; enroll while `phase = revoking`; delayed retry of a successful enroll **after** a revoke | Exactly one success per code; code burned after 5 failures; `busy` during revoking; delayed retry → `enroll-closed`, `G` unchanged, no access restored; idempotent retry before any later transition returns the same `G` |
| T2 | **Cross-midnight / cross-month duty:** FRA 22:30 → LPA → FRA 06:10 spanning 31 Oct/1 Nov; long chain hitting window edges | One duty, home month October, present in the October shard only, **counted after it completes**; edge extension works; > 4 extensions → `dutyUnbounded` (grouping class), not indexed, no day fallback; roster duty output byte-identical |
| T3 | **Historical cutoffs:** selected flight in 2024 with encounters before and after; earlier leg of same duty; encounter on 2022-07-31; future duties in synced copy | Only duties starting before the selected duty count; same-duty legs excluded; pre-2022-08 ignored; future duties never counted |
| T4 | **Missing records / incomplete coverage:** crew line without id; flight without crew list; owner line missing; unparsable line; unindexed months; selected month open | `unavailable` member; anomalies in the **missing** class; state `incomplete`, reason `missing-records`; numbers are **recorded duties** (`basis: recorded-duties`), never a minimum; selected month included in range |
| T5 | **Deleted / corrected events:** delete a past flight; change a crew list; move a duty across a month edge; correct a title | Fingerprint mismatch → rebuild; neighbours flagged; results `stale` until reconciled; duplicate dutyKey counted once and flagged |
| T6 | **Interrupted writes:** crash after staging, after commit before GC, during GC; corrupted manifest | Only old or new consistent state is ever readable; orphans GC'd; corrupted manifest → system invalidation (`G+1`) + namespace purge |
| T7 | **Concurrent indexing and revocation:** revoke while an indexer computes outside the lock; revoke waiting for a commit section; indexer resuming after revoke; reader whose request spans the revoke | Revoke transition `G+1` before any later commit; indexer commit refused; its staged parts deleted; reader returns `crew-revoked`; no result computed under the old `G` is ever returned or published |
| T8 | **Failed deletion and retry:** deletion of some `fcx.*` keys throws; lost response; retry with same `revokeId`; retry after `FC_CREW_ENABLED` removed; old `revokeId` arriving after a re-enrollment | `revoke-incomplete` then `deleted`; idempotent; works with the feature disabled; old `revokeId` → recorded outcome or `stale-request`, **new generation untouched** |
| T9 | **Storage exhaustion:** store near 500 KB; a month needing > 3 parts; write throwing a quota error; never-indexed vs previously-indexed month | Nothing partial committed; never-indexed → `uncovered` (`incomplete`); previously indexed with a detected change → `replaceFailed` (`stale`); last valid generation intact |
| T10 | **Stale results:** month verified 15 days ago; neighbour-changed flag; pid change; newer schema manifest | State `stale`, never shown as a lower bound; pid change → system revoke + purge; newer schema → `index-incompatible`, no writes |
| T11 | **Privacy:** all responses, thrown errors, cache values, shards, state record | No id-shaped token, no names in shards/caches/errors/state; `roster`/`history` unchanged; repo hygiene passes |
| **T12** | **Unrelated-property preservation:** store pre-filled with non-`fcx.` keys (including `fcx`-like names such as `fcxa`, `FCX.m`, `fc.x`); full index; revoke; owner purge; GC; pid rotation | Every non-`fcx.` key byte-identical before/after; all `fcx.*` keys gone, including orphans of older `G`/epochs; cache keys removed from the registry captured in the state record **before** the manifest was deleted; non-`fcx.` bytes counted in admission |
| **T13** | **Generation races:** (a) enroll ↔ revoke interleaved at every step; (b) delayed enroll retry after revoke; (c) delayed revoke retry after re-enroll; (d) indexer staged under `G` commits after `G+1`; (e) `crew` computes under `G`, revoke lands before its final check; (f) rotation during indexing | (a) linearisable, final state matches one serial order; (b) `enroll-closed`; (c) recorded outcome / `stale-request`, new grant still valid; (d) commit refused, parts purged; (e) `crew-revoked`; (f) system revoke, nothing old readable |
| **T14** | **Cross-month and long-predecessor duties:** long-haul predecessor ending 5 h before the initial window start and chaining into a 1 Nov sector; duty starting 31 Oct ending 1 Nov; duty completed only after the month's date-based seal day; selected flight whose predecessor lies outside its ±36 h window | Backward extension finds the predecessor; one duty with the correct `dutyKey` and home month; October duty preserved in the October shard; month not sealed until all its duties completed; selected-flight duty equals the indexed duty |
| **T15** | **Linking and uncertainty (R4.1, correction pass):** (a) missing middle sector (`chainBreak`); (b) missing long sector, fragments 11 h apart; (c) unrecognised event between connected fragments 11 h apart; (d) transitive A~B~C; (e) selection of a later fragment; (f) selected duty unbounded; (g) connected fragments 8 h apart (`shortRest`); (h) residual A1: connected gap ≥ 10 h, no event | (a)–(d), (g): member `uncertain`, **no number**; (e) earlier fragment of the selected group not counted (`none`, 0); (f) all suppressed; (h) `recorded`, count 2, `basis: recorded-duties`, no exactness or minimum claim — documented residual risk |
| **T16** | **Capacity at peak:** committed history near the limit, replacement of a month with old and new parts coexisting, retired parts inside GC grace, orphans present, non-`fcx.` keys present, manifest near 8 KB | Admission uses measured peak (formula §9.4); refused replacement → `replaceFailed` (stale), refused new month → `uncovered` (incomplete); no write ever exceeds 500 KB; manifest write always fits |
| **T17** | **Whole-query snapshot (R4.1):** (a) commit of an **adjacent** month between manifest read and part read; (b) commit that **moves a duty identity** from October to November while a query spans both; (c) reader **delayed beyond 120 s** while GC removes retired parts; (d) corrupted part header / digest mismatch; (e) continuous commits until retries are exhausted | (a)–(d): the query restarts from a new manifest and returns a result equal to one committed state — the moved duty counted exactly once, never twice, never zero; no mixed-manifest data; (e) after 3 attempts state `stale`, reason `snapshot-unavailable`, every count `null`; GC never deletes retired parts younger than 120 s |

Each Revision 4 correction is accepted only when its tests pass: R4-1 → T8, T12; R4-2 → T1, T7, T13; R4-3 → T2, T14;
R4-4 → T4, T15; R4-5 → T9, T16, T17. Revision 4.1: conservative linking → T15 (a)–(g); whole-query snapshot → T17 (a)–(e).

---

## 14. Implementation phases

| Phase | Scope | Gate |
|---|---|---|
| 0 | This spec (rev. 4) + mockup | Owner + Codex approve; Q1–Q14 answered; D-014 approved |
| 1a | **Done (synthetic, 2026-10-22; correction pass applied).** Pure core: adapter parser + diagnostics, `fcv2GroupDuties_` extraction, encounter model with suspect groups, shard codec, manifest, fingerprint, digest, admission, state machine incl. generation protocol; fake environment; T2–T6, T9–T17 (pure/fake env); size/CPU benchmark | All binding tests pass; roster output byte-identical; size estimates replaced by measurements |
| 1b | Backend handlers (enroll, index, crew, revoke, purge) on the fake env; T1, T7, T8, T13 end-to-end | Not deployed; reviewed by Codex |
| 1c | Frontend behind capability (Settings, enrollment, Crew section, memory-only service, Condor rank pack) | Pixel-identical without capability; screenshots of all states (Light/Dark, 320/390/430 px) |
| 1d | Release, each step separately approved: frontend → backend version (rollback recorded) → owner sets properties → enrollment → backfill | §12 live measurements recorded; revoke verified; v5 untouched |
| 2 | Optional Today count chip | Separate approval |
| 3 | v5 notes retirement | Separate approval |

v5 retirement plan (unchanged from Revision 2): R0 untouched → R1 owner comparison → R2 approved v5 guard
(skip `buildColleagueHistory`/`generateColleagueNotes`, new version, rollback) → R3 old notes stay → R4 close I-005.

---

## 15. Remaining risks

| Risk | Status |
|---|---|
| Airline-policy / works-agreement / data-protection clearance | **Unresolved** (Q1); blocks release, not design |
| Store capacity: full history may outgrow 500 KB between ~2027 and ~2031 | Estimated only; exhaustion handled safely but coverage becomes incomplete; needs a later storage decision |
| Live execution identity (`USER_DEPLOYING`) and effective-user check | Unverified on the live deployment |
| Exact Properties daily quota; whether Google counts key bytes toward 500 KB | Re-check against current documentation; design counts keys conservatively |
| `LockService` fairness and wait behaviour under contention | Unmeasured; revoke may answer `busy` and rely on app retry |
| Whether bulk `getProperties()` is a consistent snapshot | Not assumed; digest validation + retries (§7.6) make it unnecessary |
| Shared stores across deployments (`/dev` head) | Mitigated by schema refusal + process rule; not technically enforced |
| Chain-break detection relies on airport discontinuity; a missing sector that leaves airports connected (e.g. missing round trip X→Y→X) is undetectable | Accepted limitation; may still overcount in rare cases → documented as "available records" |
| Calendar time to read a month window | Unmeasured; budgets may need half-month windows |
| Owner-only editor assumption for the Apps Script project | Owner to confirm (Q6) |
| Employee id changes split a person in two; name-only lines never matched | Accepted limitation |
| Synced-copy gaps before some date look like quiet months | Reported as covered-but-empty; cannot be distinguished from no flying |
| Stackdriver exception logging could capture crew text if a code path throws raw content | Mitigated by catch-and-code rule + test T11 |
| Enrollment code exposure on the owner's own devices | Single use, ≤ 15 min, 5-attempt burn |

## 16. Implementation readiness assessment

**Phase 1a status (2026-10-22, after the correction pass): implemented and passing on synthetic data only.**

Completed in Phase 1a (`backend/apps-script/CrewCoreV2.gs`, **not deployed**, not in the installed project, not
loaded by the roster sandbox):
- duty grouping with `fcv2Duties_` parity (including tied departures) and `tied` flags; linking (`chainBreak`,
  `hiddenEvent`, `shortRest`) and suspect groups;
- monthly ownership with window extension, completion and sealing; selected-duty reconstruction;
- recorded-duty counting with selected-group exclusion; result states complete / incomplete / stale; per-member
  uncertainty without numbers;
- generation transitions (enroll, authorize, final check, revoke, system revoke), namespace-safe purge;
- manifest validation, crash-safe commit with mark-first / fail-closed replacement, GC, whole-query snapshot reads;
- encoding, byte accounting and replacement admission.

Tests: `tests/crew-core.test.js` + `tests/fixtures/crew.synthetic.mjs` — 43 tests (parity incl. ties, T1, T2, T3, T4,
T6, T7, T8, T9, T10, T12–T17, T15a–h, schema validation, replacement failure, privacy, storage measurement); full
suite 998/998.

**Deferred (not in Phase 1a):** Condor crew-line parser in the adapter; extraction of a shared `fcv2GroupDuties_` from
`RosterModelV2.gs` with a byte-identical roster test; fingerprints (§7.3) and rolling verification / reconciliation
(§7.4–7.5, T5); backend handlers, real `LockService`/`CacheService` behaviour, enrollment-failure counter; frontend;
storage-capacity validation against the real property store.

- **Phase 1b:** implemented in simulation (§16a); awaiting review and commit approval.
- **Not ready:** Phases 1c–1d until Q1 (clearance) and Q4 (execution identity) are resolved.

## 16a. Phase 1b status (2026-10-22, simulated only — not committed, not deployed, not routed)

**Implemented**

| Area | Where | Notes |
|---|---|---|
| Condor crew-list parser | new `backend/apps-script/CrewCondorV2.gs` (not deployed) | `RANK [id] FAMILY, GIVEN (BASE)`; id optional; malformed rank lines → `parseFailed`; names with digits rejected; duplicates once; v5 enrichment ("CREW HISTORY", "Colleague …", "Original Notes:"), hotel and booking lines never crew. Reuses the installed `fcv2ClassifyEvent_` read-only; `CondorAdapterV2.gs` is **unchanged** and its outputs are byte-identical with the crew files loaded |
| Positioning / unrecognised events | `fcv2CrewNormalizeEvent_` | Deadheads (`DH/…`), other carriers and unknown codes become hidden events → `hiddenEvent` links (no guessing) |
| Canonical duty grouping | `CrewCoreV2.gs` `fcv2CrewGroupDuties_` | **Calls the roster's own `fcv2Duties_`** (same Apps Script scope) on flights sorted exactly as `fcv2BuildRoster_` sorts them — no second copy of the chaining rule and **no extraction or edit of `RosterModelV2.gs`**; roster/capabilities/classification output byte-identical (regression test) |
| Fingerprints | `fcv2CrewFingerprint_` | Pepper-keyed HMAC over every flight and hidden event of the final read window (times, flight number, airports, crew lines as keyed hashes, parse failures), window bounds and rule versions |
| Partitioned manifest (schema 2) | `CrewCoreV2.gs` | Root `fcx.m` + one immutable year document per year (`fcx.y.<G>.<epoch>.<YYYY>.<ygen>`); publication = staged year documents, then one root write; validation of root and year documents (digests); torn reads restart the whole query; GC of retired year documents and parts; schema 1 is not read (never deployed) |
| Reconciliation | `fcv2CrewHandleIndex_`, `fcv2CrewTouchMonth_` | Bounded (≤ 6 months and ≤ 15 s per call), resumable, newest first; equal fingerprint → re-verify only; changed → replace (mark-first, fail-closed) and flag both neighbours stale until re-verified; `verifyBefore` = owner-started "Re-check history"; **storage floor**: after the first space refusal no older month is attempted, so coverage stays one contiguous recent range |
| Simulated handlers | new `backend/apps-script/CrewApiV2.gs` (not deployed, **not routed**) | `crewEnroll`, `crewIndex`, `crew`, `crewRevoke` behind the roster token; separate crew grant; single-use enrollment code; generation checks and final authorisation before every response; allow-listed responses; fixed-window rate limit (60 / 10 min; revocation exempt); pepper rotation → system revoke + purge; errors as codes only |

**Tests:** `tests/crew-api.test.js` (21) + `tests/crew-core.test.js` (43); full suite 1019/1019; offline check current.

**Measured (synthetic, Node; not Apps Script timings)**

| Measure | Result |
|---|---|
| Manifest, 4 / 20 / 40 years — single (Phase 1a) | 5,993 / 29,609 / 59,129 bytes (cap 8,000 exceeded from ≈ 7 years) |
| Manifest, 4 / 20 / 40 years — partitioned | root 272 / 1,008 / 1,928 bytes + 1,443 bytes per year document |
| 51-month history through the handlers | root 318 bytes; whole `fcx.*` store 153,648 bytes (57 keys) after GC |
| 20 synthetic years (2022-08 → 2042-07) through real commits | store limit reached: 152 months indexed (back to 2029-12), older months uncovered as one block; store 461,817 of 500,000 bytes; 27 index calls; ≈ 0.9 s Node CPU |
| Implication | the **store** (≈ 12.5 years of synthetic history ⇒ ≈ 2035 for a history starting Aug 2022) is now the only capacity limit; the manifest no longer is |

**Defects found and fixed during Phase 1b:** rate-limit window never reset under steady traffic (TTL refreshed on every request) → fixed windows; storage exhaustion produced holes where smaller older months still fitted → storage floor; "re-check all" could not terminate → `verifyBefore`.

**Phase 1b correction pass (Codex-reproduced lifecycle defects):**
- *P1 re-enrollment stranded the index* (older-generation root reported `index-incompatible` forever) → obsolete
  generations are treated as absent and purged at enrollment, resumable (§8.6).
- *P1 interrupted pepper rotation left `revoking` with no usable credential* → the system revocation records the then-
  current grant as resume credential; an owner code can supersede it; cache-removal failures no longer block (§8.5).
- *P2 uncovered months were never retried* → `crewIndex` retries only the floor month (directly below the covered
  range), automatically when at least one full part fits beyond every reserve, or on request (`retryUncovered: true`);
  coverage stays contiguous after every call.
- Tests: 6 new regression tests (re-enrollment, interrupted re-enrollment purge, interrupted rotation with
  authenticated recovery, owner-code recovery, cache-removal failure, capacity recovery with a contiguity check after
  every call); `tests/crew-api.test.js` 27, `tests/crew-core.test.js` 43; full suite 1025/1025.
- **Historical re-verification contract (completed):** only `crewIndex` reconciles; the 14-day value is a threshold,
  not a schedule; `verifiedAt` / stale / incomplete / complete defined (§7.5a); frontend trigger contract (§7.5b);
  cooperative time budget (§7.5c); `crew` responses carry a read-only `history.indexingSuggested` hint. Tests: 4 added
  (crew queries never verify or write; overdue stays stale under repeated queries until `crewIndex`; interrupted
  indexing stays incomplete; cooperative budget) plus the unenrolled/revoked case; crew 74, full suite 1029.
- **Targeted recovery fix:** (1) an unchanged fingerprint skipped deleted/corrupt shards forever and re-"verified"
  them → integrity check before the shortcut; damaged shards repaired at once through the crash-safe commit; the
  snapshot reader now applies the same structural check (it had accepted a re-signed, structurally invalid shard
  as complete). (2) `indexingSuggested` used its own rules → it now comes from the same pure plan as `crewIndex`
  (unsupported schema, capacity-blocked floor and grouping uncertainty → false; capacity regained → true). Tests: 7
  added (repair A–D, three hint cases); crew 81, full suite 1036.
- **Encoded payload validation:** structural checks ran after a lossy decode (`null`→1970 dates, flag `2`→false,
  version 999 accepted) → strict validation of the encoded payload before decoding, one contract for every reader;
  the post-decode validator was removed. Valid records decode identically (verified against the previous decoder for
  all 51 synthetic months). Tests: 15 added (12 malformed variants incl. non-finite and both bad-flag forms, a valid
  re-signed control, a failed reconstruction, the semantics-preservation check); crew 96, full suite 1051.

**Not done / blockers (documented, not bypassed)**
- Live `LockService`, `CacheService`, `PropertiesService`, Calendar access and Apps Script `Utilities` (gzip, HMAC) — all faked; real byte accounting, timings and quota use unmeasured.
- The handlers are not wired into `RosterApiV2.gs`; `capabilities` does not advertise them (Phase 1d, separate approval).
- No frontend.


## 16b. Phase 1d.2B: routing, live adapters, execution-identity gate (local only — NOT deployed)

**Routing.** `fcv2HandlePost_` (`RosterApiV2.gs`) unchanged up to and including the token check (failure limiter)
and the contract check. Then, for `crew`, `crewEnroll`, `crewIndex`, `crewRevoke` only and only when
`fcv2CrewAvailable_()` (a `typeof` check of **every** function in the three crew files, so an older copy of one
file also counts as missing): `fcv2CrewRoute_` (`CrewApiV2.gs`) inside `try/catch` → `{ok:false,
error:'crew-unavailable'}` without details. Without the crew files the four names fall through to the unchanged
`unknown-action`; `crewPurgeAll` and every other name are unchanged. The crew env is built lazily (`env.crew()`,
at most once per request) only for these actions and for `capabilities`; a wrong token, the limiter or a wrong
contract answer before any crew code runs (tested: User Properties never opened, Session never called).

**Live env (`fcv2CrewLiveEnv_(base)`).** Token, clock and the calendar readers come from the roster env
(`fcv2LiveEnv_`), so the CalendarApp/sync-tag mapping is shared, not duplicated, and roster output is unchanged.
`props` = Script Properties, `store` = User Properties (only `fcx.*` is touched), `cache` = Script Cache, `lock` =
`LockService.getScriptLock().tryLock(10 s)` with `releaseLock` in `finally` (a non-reentrant fake proves no nested
locking), `readRaw(from, to)` = synced copy (sync-tagged events only) for `[from, min(to, start of today))` plus
airline feed for `[max(from, start of today), to)`. Deps in the formats of the synthetic handler deps (tested for
equality, including the DST days and month boundaries in Europe/Berlin): `hash` = the roster's `fcv2Hash_`,
`hmacHex`/`hmacKey` via `Utilities.computeHmacSha256Signature` (hex / first 22 web-safe base64 chars = 128 bits),
`pack`/`unpack` = UTF-8 → gzip → standard base64 and back (round trip with the synthetic format), base-zone
`localDate`, `monthOf`, `monthStart`, `dayStart` via `fcv2LocalDate_` / `fcv2StartOfDay_` (never UTC), `newId` =
`Utilities.getUuid()` without dashes.

**Execution-identity + configuration gate (fail closed).** Script Property `FC_CREW_OWNER` = the owner's Google
account email (set by the owner; never in Git). Identity verified ⇔ `FC_CREW_OWNER` non-empty **and** the
effective user's email non-empty **and** equal (trimmed, case-insensitive); any exception or empty value → not
verified; without `FC_CREW_OWNER` the Session service is never called. This checks **which account the script runs
as** (so crew data is processed and stored only under the owner's account); it is **not** authentication of the
HTTP caller — the roster token and the crew grant remain the only caller authentication.
- Full mode ⇔ crew files available, identity verified, `FC_CREW_ENABLED = on`, `FC_CREW_PEPPER` and `FC_CREW_SELF`
  set. `crew`, `crewEnroll`, `crewIndex` need full mode, else `crew-disabled`.
- Revocation-only mode ⇔ crew files available and identity verified. `crewRevoke` needs at least this mode, else
  `crew-unavailable` (never a false confirmation; the app stays pending; the owner's fallback is `crewPurgeAll`).
- Purge fence and tombstones (§8.3, §8.7) are unchanged.
- **Platform note (UNVERIFIED, founder decision item):** the effective user's `getEmail()` may need the
  `userinfo.email` OAuth scope; without it, it returns `''` or throws, so crew stays unavailable and the roster is
  unaffected.

**Capabilities.** Base answer byte-identical unless crew is at least revocation-only; full → the four crew actions +
`limits.crewCancel: 1`; revocation-only → `crewRevoke` + `limits.crewCancel: 1`; never `crewPurgeAll`. Any crew
exception → the base answer. The frontend consumers (`crewSupportedBy`, `crewCancelSupported`, Settings
`testContract`) accept all three shapes (tested; no frontend change).

**Partial-deployment matrix** (`tests/crew-routing.test.js`, fake Apps Script services): no crew files; crew files
without configuration; each of owner/switch/pepper/self missing, owner mismatch, Session throws, empty email; switch
off; full; pending deletion with the switch off; interrupted purge with the switch on and off; a missing crew file
or an older file without one function. In every case roster/history/stats/departures/flight answers are
byte-identical to the no-crew baseline and nothing is logged.

**Cache-cleanup debt (P2) — assessment.** The crew handlers cache only numeric counters (rate window, enrollment
failures); the manifest's `cacheKeys` registry stays empty and the live adapters add no cache entries, so nothing
needs cleanup today and no change is made. Before any crew answer is cached (e.g. aggregate chunks), each key must
be registered in the manifest **before** it is written, so revocation and purge can remove it (§8.4).

**Deploy order (when approved; not done):** frontend first (already tolerant), then add the three crew files and the
updated `RosterApiV2.gs` in one version; set `FC_CREW_OWNER` only when crew should start; rollback = the previous
version (the crew files and the hook leave with it) — run `crewPurgeAll` first if a deletion is pending (§8.3).

## 17. Decisions requiring founder approval

| # | Decision | Proposal |
|---|---|---|
| Q1 | Airline-policy / works-agreement permission and data-protection clearance for this personal use | Founder to obtain; not assumed |
| Q2 | Durable incremental index in **User Properties** (`fcx.` namespace), no Sheet/Drive fallback | Yes |
| Q3 | On storage exhaustion: keep the last valid generation; new months uncovered (incomplete), failed replacements stale | Yes |
| Q4 | Confirm the live web app executes as the owner (deploying user) | Founder to confirm in Manage deployments |
| Q5 | Future storage beyond 500 KB (only if measurements require it) | Decide later, separately |
| Q6 | Founder stays the only editor of the Apps Script project | Founder to confirm |
| Q7 | Editor-run `crewPurgeAll` as an exception to the `_` naming rule | Yes |
| Q8 | Enrollment by owner-issued code in Script Properties (≤ 15 min, single use, 5-attempt burn) | Yes |
| Q9 | Pepper rotation on suspicion only | Yes |
| Q10 | Freshness **threshold** 14 days (not a refresh schedule, §7.5a); sealing on the 8th of the next month and only after all home-month duties completed | Yes |
| Q11 | Encounter = canonical duty (per duty, not per sector/day) | Yes |
| Q12 | Stale results shown with their "as of" date rather than hidden | Yes |
| Q13 | Phase 2 Today count chip | Defer |
| Q14 | **New (R4):** drop the "New" tag; zero wording "No earlier match in available records"; "some duty records unclear" for grouping uncertainty | Yes |
| Q15 | **New (R4.1, corrected):** link rules — 20 h span (A2), 10 h minimum-rest link (`shortRest`); counts are recorded duties; residual A1 accepted as documented | Yes |
| Q16 | **New (R4.1):** "Earlier matches unclear" wording for suppressed counts | Yes |
| Q17 | **New (Phase 1a):** plan a manifest split before the 8 KB cap (≈ early 2030 on synthetic data) | Plan in Phase 1b design; no action now |
| Q18 | **New (correction pass):** UI wording "N recorded duties together", "Flown together before · number unclear"; no "at least" | Yes |
| Q19 | **New (1b):** keep the Condor crew parser in its own file (`CrewCondorV2.gs`) instead of `CondorAdapterV2.gs`, so the installed adapter stays byte-identical | Yes |
| Q20 | **New (1b):** reuse `fcv2Duties_` directly instead of extracting a shared function from `RosterModelV2.gs` | Yes |
| Q21 | **New (1b):** partitioned manifest (schema 2) replaces the Phase 1a single manifest; resolves Q17 | Yes |
| Q22 | **New (1b):** storage floor — on exhaustion keep one contiguous recent range; older months reported uncovered | Yes |
| Q23 | **New (1b):** "Re-check history" re-verifies months verified before the moment it was started (`verifyBefore`) | Yes |
| Q24 | **New (1b correction):** an owner enrollment code may supersede an interrupted revocation (recovery without manual property editing) | Yes |
| Q25 | **New (1b correction):** automatic floor retry when ≥ one 8 KB part fits beyond all reserves; explicit `retryUncovered` otherwise | Yes |
