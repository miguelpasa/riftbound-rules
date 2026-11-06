# R57: movement restrictions

Status: done (engine, parser). Fully supported cards 332 -> 336 of 1103 (`convertRow` count). Engine 745 tests (+4), client 426, scripts 30; typecheck, lint, check:rules green.

## What changed

- `StaticAbility.restrict` ('NO_MOVE_TO_BASE') and affects 'ALL_UNITS'; `staticBonus` reports `noMoveToBase`; `validateMove` refuses the Base destination for affected units (so legal actions and the reducer agree).
- `CardInstance.cantMove` + effect `LOCK_MOVE_TARGET` ("It can't move this turn", cleared by `expireTurnEffects`).
- Parser: the three "can't move to base" statics and the "It can't move this turn" it-sentence.
- Cards now full: Determined Sentry, Minotaur Reckoner, Vilemaw's Lair, Hunker Down.

## Not done

Restrictions on moving to a battlefield / from the Base, "can't be chosen" restrictions, Vex's "they can't move it this turn" (needs a trigger on the opponent's play), Entrenched Boar's optional enter-ready.
