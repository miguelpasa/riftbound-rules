# R98: Give a permanent [Temporary], double a unit's Might

Status: done. Fully supported cards 512 -> 516 of 1103 (`npm run cards` full count). Regression diff: no card lost or changed, 4 gained. Engine 911 tests (+3).

## What changed

- `GRANT_TEMPORARY_TARGET` ("Give it [Temporary]", "Give a gear [Temporary]", "Give a unit at a battlefield or a gear [Temporary]") stores `temporaryOf = enteredTurn` on the object; the Beginning-Phase kill honours it only while `enteredTurn` is unchanged, so a card that left and re-entered is not Temporary. `DOUBLE_MIGHT_TARGET`.

