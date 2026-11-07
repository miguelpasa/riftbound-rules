# R90: Return a unit, its owner channels a rune; final audit

Status: done. Fully supported cards 486 -> 487 of 1103 (`npm run cards` full count). Engine 880 tests (+3), client 426, scripts 31. Regression diff: no card lost or changed, 1 gained (Retreat). Final audit of R81 to R90: smoke seed final90 (50 games) 0 failures, bot match completes, 17 browser specs pass.

## What changed

- `TARGET_OWNER_CHANNEL`: "Its owner channels N rune(s) exhausted" after a returned unit (the owner of the unit returns it, then channels).

