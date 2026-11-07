# R88: "The first time ... each turn", token statics, units entering ready

Status: done. Fully supported cards 481 -> 486 of 1103 (`npm run cards` full count). Engine 877 tests (+4), client 426, scripts 31. Regression diff: no card lost or changed, 5 gained.

## What changed

- "The first time I conquer / move / win a combat / a friendly unit dies each turn, ..." is read as the same trigger with `oncePerTurn`.
- Statics: `onlyToken` ("Your token units have +1 [M]"), `entersReady` ("Your tokens enter ready", "Other friendly units enter ready") and the scope `OTHER_FRIENDLY_UNITS`. Played units (play.ts) and played tokens (effects.ts) consult them as they enter.

