# R106: Subtype-limited targets (a Mech, a non-Dragon unit)

Status: done. Fully supported cards 535 -> 537 of 1103 (`npm run cards` full count). Regression diff: no card lost or changed, 2 gained. Engine 935 tests (+3).

## What changed

- `READY_TARGET.subtype` and `RETURN_TARGET.notSubtype` checked in the target spec ("Ready another friendly Mech", "return a non-Dragon unit").

