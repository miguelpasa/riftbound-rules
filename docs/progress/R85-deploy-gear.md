# R85: Deploy gear: played to a battlefield, stays there, "here" triggers and statics

Status: done. Fully supported cards 463 -> 471 of 1103 (`npm run cards` full count). Engine 866 tests (+7), client 426, scripts 31. Regression diff: no card lost or changed, 8 gained. A script test caught an over-broad rewrite (units got gear-only heads) during the round; it is restricted to gear.

## What changed

- Keyword Deploy (gear): played only to a battlefield its controller controls (`ILLEGAL_LOCATION` otherwise; the legal list offers only those locations), stays at the battlefield through the Cleanup's Recall, and is killed when an opponent holds that battlefield (`scoreBattlefield`).
- A Deploy gear acts for its battlefield: "When you hold / conquer here" (HOLD / CONQUER), "When you win a combat here" (WIN_COMBAT), "Friendly units here have [Keyword]" (new `FRIENDLY_UNITS_HERE` static scope), "if you control this battlefield" (new `CONTROLS_HERE` condition). Those gear-only phrases are rewritten only for gear.
- `isDeployGear` lives in tokens.ts (leaf module).

## Not done

- "When one or more friendly units attack here" (Demacian Standard), banished-card effects (Dockside Lock-Up), "choose one" on play-or-move (The Ball), Deploy bonuses to the hide limit.

