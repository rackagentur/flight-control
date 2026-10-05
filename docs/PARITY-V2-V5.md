# Live comparison: contract v2 (candidate) vs v5 (baseline)

**2026-10-05 · Backend Version 24 · Result: GO.** No defect, no regression; every difference is an intended v2 improvement, a documented v5 limit, or a data gap.

## Method

Both contracts were fetched live from the same deployment within the same minute and passed through the app's own adapters and models (`adaptV5`/`adaptV2`, `buildRoster`, `buildDays`, `deriveState`), so the comparison is what the UI would show. Only aggregates were recorded (no flight numbers, routes, names, hotels, endpoint or token).

Overlap is bounded by v5: its flight list holds the next 5 sectors (here: today to 14 Oct) and its days-off scan reached 11 Oct. v2 covered 1 Sep – 30 Nov (57 days from today compared day by day).

## Results

| Area | Result | Class |
|---|---|---|
| Flight number, route, dep/arr instants, block | 5/5 v5 sectors match v2 exactly; no v2 sector inside v5's window is missing from v5 | match |
| Sectors outside v5's window | v2 adds 8 earlier sectors of its window and 8 after v5's 5-flight horizon | expected |
| Local times / IANA / DST | Both contracts carry identical instants and IANA zones, so the app shows correct times either way. v5's legacy display strings are wrong: all 5 arrival strings off by the origin's UTC offset (B1); 2 outstation departures in Berlin time (B5). v2's stated local times are IANA-correct | expected (known v5 defects) |
| Pickup | 1 shared pickup identical; none only in one source | match |
| Report time | v2 on 17 sectors; v5 has none | expected |
| Duty grouping | 10/10 shared-sector pairs grouped identically; v2 backend vs frontend grouping 19/19 identical | match |
| Flight days | 5/5 identical, same day labels | match |
| Standby / reserve | 2 days that v5 counts as an unspecified duty are SB in v2 | expected |
| OFF / free / leave / ORT | 2 v5 "no duty reported" days are explicit free days in v2; beyond v5's coverage v2 adds 8 OFF, 3 free, 8 leave, 2 ORT days. Every v2 rest day is a confirmed source code; ORT always protected and distinct | expected |
| UNKNOWN ≠ OFF | Today and 9 later days stay UNKNOWN ("nothing rostered") where v5 says "free of duty"; 3 days at the end of the window are "not published" | expected (by design) |
| Unknown codes | 6 (all before today) kept with their original code | expected |
| Layover | 1 day: v2 stated layover (roster hotel) outside v5's coverage | expected |
| Hotels | 12 roster hotel stays only in v2; none with a VERIFIED map location yet | expected + data gap |
| Aircraft | 21/21 v2 sectors, source only; none in v5 | expected |
| Today | UNKNOWN in both | match |
| This month | 8 flights and 68 block hours in both | match |
| Year / all-time statistics | Not in v2; v2 history covers only the synced copy (≤ 13 months) | data gap: v5 stays the source |

Defects: none. Data gaps: no VERIFIED hotel locations yet; no year/all-time totals in v2; days after the last rostered day are "not published".
