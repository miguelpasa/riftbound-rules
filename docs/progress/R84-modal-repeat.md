# R84: Modal spells with Repeat, damage to a unit in a Base

Status: done. Fully supported cards 462 -> 463 of 1103 (`npm run cards` full count). Engine 859 tests (+3), client 426, scripts 31. Regression diff: no card lost or changed, 1 gained (Rocket Barrage).

## What changed

- A Repeat cost line may precede "Choose one" modes; the converter stores `repeatCost` on modal spells (the engine already repeats the chosen mode).
- `DAMAGE_TARGET.inBase`: "Deal N to a unit in a base" (either player's Base).

