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
| **LAYOVER** | Last completed sector ended away from base, return not yet flown, next departure from that airport | ⚠ next departure only | `LAYOVER`, confidence `inferred`, provenance `derived`, **only** when the next known sector departs from a non-home airport and no earlier sector exists today. Ambiguous itineraries → `UNKNOWN` |
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
