# R73: Level-gated abilities, conditional discounts and enters-ready conditions

Status: done. Fully supported cards 400 -> 406 of 1103 (`npm run cards` full count). Engine 807 tests (+8), client 426, scripts 31; typecheck, lint, check:rules green.

## What changed

- `[Level N][>]` now gates triggered abilities and "I enter ready" on the controller's XP (`when: {XP n}` / `entersReadyWhen`), like `[Empowered][>]`. The Level keyword counts as parsed by the ability parser.
- Conditions `PLAYED_TO_BATTLEFIELD`, `CONTROLS_EMPOWERED`, `ENEMY_STUNNED`, `NAME_IN_TRASH`.
- "If <condition>, I cost [N] less and enter ready" is split into a self discount plus "I enter ready if <condition>".

## Not done

- Level lines that mix a static and "enter ready" (Scorchclaw), "a friendly unit or gear died this turn" (Lingering Animus), "[2][C] less" discounts with Power parts.

