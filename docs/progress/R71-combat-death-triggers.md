# R71: Combat and death triggers: win a combat, combat ends, unit dies, died alone, once each turn, gear "play this"

Status: done. Fully supported cards 383 -> 394 of 1103 (`npm run cards` full count). Engine 788 tests (+13), client 426, scripts 31; typecheck, lint, check:rules green; reducePurity golden hashes unchanged.

## What changed

- New trigger kinds `WIN_COMBAT`, `COMBAT_END`, `UNIT_DIES` (with `CardTrigger.dies: {side, here?, batch?}`) and `CardTrigger.oncePerTurn` (per-object `onceTurn` record).
- `UNIT_KILLED` now carries `controller`, `cardId`, `at` (battlefield id or 'base') and `alone`; new `COMBAT_ENDED {battlefieldId, winner, participants}` event, emitted only when some card in the database has a combat-end trigger (so replay hashes of other games do not change).
- Condition `DIED_ALONE` (`not` for "didn't die alone"), read from the death event for Deathknell triggers.
- Parser: "When I win a combat", "When a combat that I was in ends", "When [another] a friendly / an enemy unit [here] dies [while I'm at a battlefield]", "When one or more friendly units die", "Once each turn, ...", "If I [didn't] die alone", and gear "When you play this".

## Not done

- "Stunned enemy unit" deaths, "if I haven't been dealt damage" combat conditions, "When you buff / exhaust / ready" triggers.

