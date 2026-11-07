# R108: Move-from and gear-ability triggers

Status: done. Fully supported cards 539 -> 541 of 1103 (`npm run cards` full count). Regression diff: no card lost or changed, 2 gained. Engine 942 tests (+3).

## What changed

- Triggers `MOVE_FROM` (a unit moving from a battlefield to another battlefield) and `USE_GEAR_ABILITY` (the player activates an ability of a gear or gear token).

