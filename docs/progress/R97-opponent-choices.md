# R97: Opponent-directed effects and "base Might becomes N"

Status: done. Fully supported cards 508 -> 512 of 1103 (`npm run cards` full count). Regression diff: no card lost or changed, 4 gained. Engine 907 tests (+3).

## What changed

- "Choose an opponent." is ignored (a duel has one opponent); `DRAW.eachPlayer` ("You and that player each draw N"), `PLAY_TOKEN.forOpponent` ("They play a ... token").
- Targeted `SET_BASE_MIGHT` ("Its base Might becomes N this turn"): a temporary Might change that keeps other bonuses.

