# R93: Board-counted gives, buff all units here

Status: done. Fully supported cards 495 -> 500 of 1103 (`npm run cards` full count). Regression diff: no card lost or changed, 3 gained. Engine 893 tests (+5).

## What changed

- `GRANT_KEYWORD_TARGET.valueFromMight` (Brawl), `DEBUFF_TARGET.timesExhausted` (exhausted friendly units), `BUFF_TARGET.timesEnemiesThere` (enemy units at the target's battlefield), and `BUFF_ALL` with `buff`, `here`, `others` ("[Buff] all units here", "buff all other friendly units there"; an "if I am at a battlefield" lead-in is implied by the here-scope).

