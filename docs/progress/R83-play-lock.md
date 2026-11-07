# R83: Play locks and capped group debuffs

Status: done. Fully supported cards 459 -> 462 of 1103 (`npm run cards` full count). Engine 856 tests (+5), client 426, scripts 31. Regression diff: no card lost or changed, 3 gained (Brynhir Thundersong, Lilting Lullaby, Thousand-Tailed Watcher).

## What changed

- `PlayerState.playLock {turn, what}` and effect `LOCK_PLAYS` ("Opponents can't play cards this turn", "Its controller can't play spells this turn" after a counter). `canPlayNow` refuses a locked card; abilities are not cards and stay usable.
- `BUFF_ALL.minMight`: "Give enemy units -3 [M] this turn, to a minimum of 1 [M]".
- A countered spell now records its controller for the effects that follow it.

