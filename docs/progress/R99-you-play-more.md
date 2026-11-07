# R99: Play triggers for token units, Power cost thresholds and the Nth card

Status: done. Fully supported cards 516 -> 518 of 1103 (`npm run cards` full count). Regression diff: no card lost or changed, 2 gained. Engine 915 tests (+4).

## What changed

- `PlayFilter.token` (fired by `TOKEN_PLAYED`), `minPower`, `nth` (Nth card the player played this turn); parser heads "When you play a token unit", "... a card with Power cost [A][A] or more", "When you play your second/third card in a turn".

