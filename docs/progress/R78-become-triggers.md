# R78: "When I become exhausted / ready / Empowered" triggers

Status: done. Fully supported cards 439 -> 444 of 1103 (`npm run cards` full count). Engine 835 tests (+5), client 426, scripts 31; typecheck, lint, check:rules green; golden hashes unchanged (the diff is computed only when a card needs it).

## What changed

- Trigger kinds `BECOME_EXHAUSTED`, `BECOME_READY` (fed by new `BECAME_EXHAUSTED` / `BECAME_READY` events that `reduce` synthesises by diffing the board's readiness before and after an intent, only when some card has such a trigger) and `BECOME_EMPOWERED` (from `EFFECT_EMPOWERED`).
- Parser heads "When I become exhausted / ready / [Empowered]" and "When you play me or when I become exhausted".
- The event log describes the two new events.

## Not done

- "Choose one" bodies (Riven, Jayce, Reckless Innovator), becoming Mighty or buffed, triggers for other players' permanents.

