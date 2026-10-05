# Data gaps: what the current source can and cannot prove

Source in use: **`fc-appscript-v5`** (`?action=getStats`). The rules below implement the approved state policy:
**never display a state the evidence cannot support; insufficient evidence → UNKNOWN.**

## Capability flags of the v5 source

| Flag | v5 | Notes |
|---|---|---|
| `sectors` | ✅ | Max **5** upcoming flight sectors within 60 days; flights only |
| `pickup` | ✅ partial | Matched by departure calendar date (B7): pre-midnight pickups are missing |
| `offDaysByAbsence` | ✅ partial | `daysOff` = days on which no flight/SB/RE/ORT event *starts* (max 3 blocks, 30 days) |
| `standbyWindows` / `reserveWindows` | ❌ | Only monthly counts; no SB/RE event times |
| `dayRoster` | ❌ | No per-day status array |
| `pastSectors` | ❌ | Nothing before today 00:00, so the inbound sector of a current layover is invisible |
| `reportTime` | ❌ | No briefing/report time |
| `hotels` | ❌ | The hotel database exists in the backend Sheet but is not exposed |
| `history` | ✅ | Month / year / all-time aggregates, map, achievements |

## State-by-state evidence

| State | Evidence required (confirmed) | What v5 provides | V2 behaviour with v5 |
|---|---|---|---|
| **FLIGHT** | A sector or pickup on the current duty | ✅ timestamps | `FLIGHT`, confidence `confirmed`, provenance `source` |
| **STANDBY** | An SB event covering now | ❌ | **Never shown.** Possible SB days → `UNKNOWN` |
| **RESERVE** | An RE event covering now | ❌ | **Never shown.** Possible RE days → `UNKNOWN` |
| **LAYOVER** | Last completed sector ended away from base, return not yet flown, next departure from that airport | ⚠ next departure only | `LAYOVER`, confidence `inferred`, provenance `derived`, **only** when an arrival at a non-base airport is followed by the next departure from that same airport (the inbound may come from the current payload or from sectors remembered on this device). Otherwise `UNKNOWN`. Ambiguous itineraries → `UNKNOWN` |
| **OFF** | Source can distinguish OFF from SB/RE for the day | ⚠ by absence only | **Default `UNKNOWN`** (approved rule 5). Reason shown: "No duty reported; the source cannot confirm OFF." See open item O1 |
| **UNKNOWN** | — | — | Neutral palette, explicit reason, never styled as OFF |

Future adapters that expose SB/RE events map them explicitly: **SB → STANDBY, RE → RESERVE**.

## Open items requiring validation inputs

| ID | Depends on | Question | Affects |
|---|---|---|---|
| **O1** | [V-FIXTURE] [V-B3] | v5 `daysOff` excludes days on which SB/RE/ORT events *start*. The residual ambiguities are overnight events starting the previous day, unknown roster codes, and layover days (B3). Can a guarded `OFF (inferred, derived)` be allowed when no rotation is open and no overnight event is possible? **Until approved: UNKNOWN.** | Today OFF state, 7-day strip, Calendar |
| **O2** | [V-B3] | Does the airline feed contain any event on layover days? | Layover inference across `daysOff`, Calendar bands |
| **O3** | [V-FIXTURE] | Real pickup ↔ sector timing (pre-midnight pickups, multi-sector days) | Duty Horizon pickup node, wake-up |
| **O4** | [V-FIXTURE] | Real `getStats` latency and payload size | Loading and caching strategy |
| **O5** | [V-FIXTURE] | Roster codes present in real data beyond DE/SB/RE/ORT/P/U | Unknown-code handling |

## Backend additions requested later (additive `getStats` fields; separate backend track)

1. `days[]`: per-day status for at least 45 days (date, codes, start/end)
2. SB/RE/ORT events with start and end
3. The last completed sector (for confirmed layover detection)
4. Report/briefing time per duty
5. The layover hotel record (name, address, Maps link) from the hotel Sheet
6. ISO timestamps for every display string

## Phase 4 findings (implementation against the synthetic v5 fixture)

What the V2 engine now does with each gap. "Data needed" lists what would close it (additive backend change, separate track).

| Gap | Effect in V2 today | Data needed |
|---|---|---|
| Only the **next 5 flights** | 7-day strip and Duty Horizon can end early; a warning appears in Today › Source | More sectors, or a `days[]` roster |
| **No SB/RE windows** | STANDBY/RESERVE are never shown for v5 data. Days with SB/RE/ORT appear as "Duty, details not provided" | SB/RE/ORT events with start/end |
| **Days off by absence only** (O1) | Today never shows OFF for v5 data; free days show "No duty reported" (not OFF) | Explicit OFF days, or approval of an inferred-OFF rule |
| **No past sectors** | A layover is only inferred when the inbound flight was seen (same day, or remembered on this device). First use during a layover → UNKNOWN with the reason | The last completed sector |
| **No report time** | The Duty Horizon has no briefing milestone (pickup → departure is one unlabelled phase) | Report/briefing instant per duty |
| **Pickup by calendar date** (B7) | Pre-midnight pickups and outstation pickups are missing; V2 never invents them | Pickup linked to its duty |
| **daysUntil relative to fetch day** | Handled: V2 anchors days-off to the payload's fetch day, so cached data stays correct | ISO dates |
| **Hotels not exposed** | Today offers a Maps search and your saved list only | Layover hotel record |
| **Days off list = 3 blocks / 30 days** | Days beyond the last block are "No data", never off | Full roster |
| **Positioning/deadhead sectors not exposed** (found with live data) | An itinerary jump (arrive A, next departure from B) produces no layover and a Source warning | Positioning sectors (any code), not only DE flights |
| **getStats latency ≈ 11 s** (live spike, B10: full history read per call) | V2 renders the cached roster instantly and refreshes in the background | Backend caching / lighter stats call (backend track) |

### Live connectivity spike (2026-10-04)
Static frontend (http://localhost:8080) → Apps Script v5 `?action=getStats`: **PASS**. Cross-origin read allowed, JSON with `success`, all contract fields present, 12.7 KB. Request is a CORS simple GET with `credentials: 'omit'`; it works because the web app is anonymous. Backend hardening (BH-2) must keep a preflight-free, credential-less request shape (e.g. a token parameter or `text/plain` POST); restricting access to "Anyone with Google account" would block this static frontend.

## Proving OFF: what V2 needs (open item O1, answered)

**Why production cannot show OFF today.** v5's only day-level evidence is `daysOff`: days on which no event whose title contains `DE`, or starts with `SB`/`RE`, or contains `ORT` begins. That is an *absence* signal built from a filtered subset of the calendar. It cannot distinguish a real day off from (a) a duty type v5 does not parse, (b) an overnight duty that started the day before, (c) a layover day (B3), or (d) leave/sickness/other codes. During the live verification the payload went further: it did **not** list the current day as free (`dutyBlock.current` > 0), so v5 itself counted the day as a duty day without saying which kind. V2 therefore shows UNKNOWN with that exact reason. V2 will not guess OFF.

**What would prove OFF** (additive backend fields; separate backend track, nothing changed yet):

1. **Explicit day codes from the airline roster.** For each day in a window, the roster's own day entries, unfiltered:
   ```json
   "days": [{
     "date": "2026-10-04",
     "events": [{ "type": "off|standby|reserve|training|flight|positioning|leave|sick|pickup|other",
                  "code": "OFF", "start": 1791072000000, "end": 1791158400000, "allDay": true }]
   }],
   "coverage": { "from": "2026-10-01", "to": "2026-11-30", "syncedAt": 1791100000000, "complete": true }
   ```
   OFF is then **confirmed** when the airline's own off code is present for the day. Mapping SB → standby, RE → reserve, ORT → training gives STANDBY/RESERVE windows at the same time.
2. **Coverage guarantee.** `coverage.complete` must assert that every roster event in the window was synced. Without it, an empty day is only an absence of data.
3. **Owner input needed:** which code (if any) does the airline roster calendar use for days off (e.g. an all-day "OFF"/"FREI"/"X" event)? If the roster has no explicit off code, OFF could at best be *inferred* from a complete, unfiltered day with zero events: that would be a new rule requiring your explicit approval.

## Live-data findings (2026-10-04)

| Finding | Effect | Where to fix |
|---|---|---|
| A flight listed **twice** with identical times | V2 merges exact duplicates (warning shown): no duplicate duty, timeline entry or itinerary gap. Month statistics are corrected by the duplicate's exact contribution and the correction is recorded (`stats.adjustments`). Duplicates outside the visible 5-flight window cannot be detected; already-departed visible duplicates are also removed from year/all-time flights and hours (year projection recomputed); route/destination counts, the map and achievements cannot be corrected from the payload | Backend dedupe is a separate decision; the legacy backend is not altered to hide it |
| BER was in the default home bases (inherited from v5's "no hotel needed" list) | **Resolved (owner decision):** crew base is FRA only. An outbound to a former "no hotel" airport and the later return form one away rotation; the days between are an inferred layover, and any non-flight duty the source lists on those days stays visible | `noHotelAirports` keeps the old list for hotel links only |
| v5 arrival strings on live data are off by the UTC offset (domestic sector shown 2 h early) | v5 formatted the instant as UTC (B1) | Already corrected in V2 |

## Future source contract: OFF as a first-class state (owner decision, 2026-10-04)

- **Never** "no flight code = OFF". Without proof the state stays UNKNOWN.
- A future source must provide **explicit OFF/FREE day events** where the airline roster has them (`type: 'off'`, airline code preserved), **and** a **coverage/completeness signal** (`coverage.from`, `coverage.to`, `coverage.complete`, `syncedAt`).
- An empty day may be interpreted as OFF **only** when the source declares the window complete; V2 will label that `confidence: inferred`, distinct from an explicit OFF event (`confirmed`).
- Normalized model already supports it: `DutyStatus 'off'`, `Window {kind:'off'}`, capability `explicitOff`; the v5 adapter sets `explicitOff: false`.

## Calendar coverage with the v5 source (Phase 5, live verification)

What the month view can genuinely show from `getStats`, and how V2 marks the rest. Nothing is synthesized.

| Calendar need | v5 provides | Month view today |
|---|---|---|
| Flights | Next 5 flights within 60 days | Flight days and rotations up to the day of the 5th listed flight (live: ~1 week) |
| Day-level duty vs free | `daysOff`: ≤ 3 free blocks within 30 days | Days up to the end of the 3rd free block: "no duty reported" (not OFF) or "duty, type not given" |
| Past days | Nothing before today 00:00 | "No data", except flights this device remembered from earlier syncs (120 days, at most 300; Phase 6 decision D2) |
| Standby / reserve / training | Monthly counts only | Never shown as SB/RE; such days are "duty, type not given" |
| OFF | Not provable (see O1) | Never shown for v5 data |
| Layovers | Derived from consecutive sectors | Inferred (dotted, italic, "Inferred") |
| Beyond coverage | — | Hatched "no data"; the coverage window is stated above the grid |

Live result (2026-10-04): 10 of 31 October days classified (4–13 Oct); September and November entirely "no data".

**To populate a full arbitrary month** a source needs (backend track, unchanged in Phase 5): the `days[]` + `coverage` contract above, a sector list not capped at 5 (at least the visible month, ideally ±1 month), and past sectors for the current month.

## Approved classifier rule: maximum inferred layover length (2026-10-04)

- An arrival at an outstation followed by the next departure from the **same** airport may be classified **LAYOVER · inferred** (provenance `derived`) only if the departure date is **at most 6 calendar days** after the arrival date.
- Calendar days are counted in the **outstation's local dates** (home time zone if the airport's zone is unknown), so DST changes do not shift the count. Example: arrive 28 Oct, depart 3 Nov = 6 → inferred; depart 4 Nov = 7 → not inferred.
- **Gap > 6 days:** no layover is inferred and the rotation is **not** connected across the gap. The days in between are **UNKNOWN** with their normal source evidence ("no flight listed", "duty, type not given", "no data", …), **never OFF**. Today explains it ("More than 6 days between arriving … and the next departure from there") and the Source panel shows a `layover-too-long` warning.
- **Explicit roster layovers** (source-stated layover windows, `confidence: confirmed`) are **never capped**, and they keep the rotation connected.
- Confirmed and inferred layovers remain visually distinct (solid vs dotted band, upright vs italic code, "Confirmed" vs "Inferred").
- Implemented in `src/model/roster.js` (`MAX_INFERRED_LAYOVER_DAYS`, `layoverCalendarDays`); tests in `tests/layover-cap.test.js` (5/6/7 days, DST, time-zone date boundary, explicit exemption, never OFF).

## Flights and destination intelligence with the v5 source (Phase 6)

What the Flights screen can genuinely show from `getStats`, and what stays a documented gap. Nothing is synthesized.

| Flights need | v5 provides | Flights today |
|---|---|---|
| Upcoming sectors | Next **5** flights within 60 days | Shown as rotations; after the 5th flight the list ends with a calm note ("your roster source shares the next 5 flights") |
| Local times, +1 day, block, home-time reference | Instants; zones from the V2 airport table | Derived (IANA); unknown airports show UTC, labelled |
| Wake-up / pickup | Pickup by departure date (B7: pre-midnight pickups missing) | Shown only when present, with alarm links |
| Layover length | Not stated | Inferred from consecutive sectors (6-day rule); "return not yet listed" when the outbound is beyond the 5-flight boundary |
| Destination city, country, zone, coordinates | V2 airport table | Local time and difference from home; coordinates only where the table has them (never guessed) |
| Weather | Not in the payload (v5's page fetched Open-Meteo itself) | Open-Meteo from the browser (D1) for the local arrival date within the 10-day forecast; otherwise "unavailable" with the reason |
| Assigned hotel | **Not exposed** (the hotel Sheet is never read by `getStats`) | Search + saved list only; "not provided by your roster source" (D4) |
| Crew intelligence | Only as text in calendar event descriptions, built from employee numbers | **Excluded** (D3), not a gap to close |
| Past flights | **Nothing** before today 00:00, no per-flight history | "Seen on this device": sectors this device observed in earlier syncs, 120 days / 300 sectors (D2) |

**Later backend contract (separate track, additive, optional fields; no change in Phase 6):**

1. `upcoming` not capped at 5 (or an explicit `upcomingLimit`, plus the window end it speaks for).
2. `history[]`: `{flightNumber, origin, destination, depTimestamp, endTimestamp}` for a requested month range. Times and route only; nothing about other people.
3. `layoverHotel` per outstation stay: `{airport, from, to, name, address, mapsUrl, phone?, verified}`. Only reviewed records; never the Places API key, raw roster text or unreviewed candidates.
4. Report/briefing time per duty (already listed above).

## Roster contract v2 (Phase 7, installed privately as Version 23, not yet enabled in the app)

What the richer contract closes once enabled (`docs/CONTRACT-V2.md`), and what stays open:

| Gap with v5 | With v2 |
|---|---|
| Only the next 5 flights | All sectors in the window (previous, current and next month) |
| No standby/reserve windows | SB/RE windows with times (source) |
| OFF not provable | OFF, free day, leave and **ORT (protected free day)** from explicit codes. Empty days stay UNKNOWN: the feed is not exhaustive (days away carry no event) |
| No report time | Check-in events give the report time (source) |
| Pickups by date (B7) | Pickup associated with the next check-in (derived); pickups exist at outstations only, so no wake-up is invented at home |
| No hotel record | Hotel from the roster's own hotel block (source); location only when VERIFIED for this stay (derived) |
| No history | Up to 13 months of my own flights from the synced calendar |
| Fixed-offset times | IANA zones and local times with offsets |

Observed on the live data (Step H, 2026-10-05): four history sectors used airports missing from the generated table (PDX, SYX), so their zones were `null` (reported, never guessed); both are now in `src/data/airports.js` and the regenerated `AirportsV2.gs` (live once a later version is deployed). No stay has a VERIFIED hotel location yet, so roster hotels show without a map pin until matching Sheet rows are verified.

Still unknowable: whether the airline published the whole next month (days after the last rostered day are `unpublished`), rotation/pairing ids (not in the feed), the airport of a standby hotel without a preceding arrival, and changes made after the feed's last refresh (the synced copy can lag the feed by up to a day).
