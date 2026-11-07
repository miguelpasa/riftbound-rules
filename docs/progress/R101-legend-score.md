# R101: Legend triggers: win a combat, hold, conquer

Status: done. Fully supported cards 520 -> 522 of 1103 (`npm run cards` full count). Regression diff: no card lost or changed, 2 gained. Engine 923 tests (+3).

## What changed

- Legends may carry `WIN_COMBAT`, `HOLD` and `CONQUER` triggers read from "When you win a combat / hold / conquer" (`parseCardAbilities` option `legend`); `collect` fires the Legend of the scoring or winning player.

