# R102: Compound self clauses joined by "and"

Status: done. Fully supported cards 522 -> 528 of 1103 (`npm run cards` full count). Regression diff: no card lost or changed, 6 gained. Engine 926 tests (+3).

## What changed

- `parseClause` falls back to splitting "X and Y" into two target-free clauses (both must parse; clauses with targets are never split): "Ready me and give me +2 [M] this turn", "Give me +2 [M] this turn and ready me", "Channel 2 runes exhausted and draw 1", "buff me and draw 1".

