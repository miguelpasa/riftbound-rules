# R94: One-way damage equal to the chosen unit's Might

Status: done. Fully supported cards 500 -> 501 of 1103 (`npm run cards` full count). Regression diff: no card lost or changed, 1 gained. Engine 896 tests (+3).

## What changed

- `DAMAGE_TARGET.amountFrom: 'SLOT_MIGHT'` with `amountSlot`: "<Choose/Ready a friendly unit>. It deals damage equal to its Might to an enemy unit ..."; `targetRequirements` also requires the dealing unit. `damageAmount` no longer needs the source object for slot- and excess-based amounts.

