# PR #1 release review screenshots (2026-11-16)

Synthetic review mode only (`?review`): fictional places (HOME/AWAY/EAST/WEST/SOUTH) and flights (SAMPLE nn),
permanent "Sample data · not your roster" banner. Captured headless in Chrome from the merged branch, served
locally, with every non-local host unresolvable (no external request was attempted). The review dock is hidden
via injected CSS for legibility; nothing else is altered. Device time zone Europe/Berlin.

| File | Viewport | Theme | Screen |
|---|---|---|---|
| 01-mobile320-dark-today-flight.png | 320×760 | dark | Today, flight duty: next event, countdown, wake-up/pickup |
| 02-mobile390-dark-calendar-off-vs-unknown.png | 390×844 | dark | Calendar: OFF, ORT, RE, Duty, `?` unknown, hatched no-data |
| 03-mobile390-light-flights-detail.png | 390×844 | light | Flights: multi-sector rotation, wake-up/pickup, UTC offsets |
| 04-tablet768-dark-radar-standby.png | 768×1024 | dark | Flights in standby window (Radar), sample schedule |
| 05-desktop1280-dark-today-standby.png | 1280×860 | dark | Today, standby: window, Duty Horizon, week strip |
| 06-desktop1280-light-settings.png | 1280×860 | light | Settings: theme, time display, part-time schedule |
