# R56: "a unit died this turn" and reversed conditional forms

Status: done (engine, parser). Fully supported cards 329 -> 332 of 1103 (`convertRow` count). Engine 741 tests (+3), client 426, scripts 30; typecheck, lint, check:rules green; golden hashes unchanged (tracking is opt-in per card database).

## Measurement

`m56.ts` (scratchpad): 16 partial cards had an "enter ready" line that became full when stripped; the common blockers were history conditions ("a unit died this turn") and the reversed "If X, I enter ready" order.

## What changed

- Condition `DIED_THIS_TURN`, `PlayerState.diedThisTurn`, `recordDeath` (combat kills and Temporary expiry).
- Parser: the conditions, "If <cond>, I enter ready", "If <cond>, this costs [N] less".
- Cards now full: Towering Pairofant, Spoils of War, Dunebreaker (plus tokens-free count +3).

## Not done

Gear deaths, Beginning-Phase qualifiers, "Other friendly units enter ready", "Units you play ... enter ready" (static play modifiers), and the other history conditions ("you've played a spell this turn", "conquered this turn").
