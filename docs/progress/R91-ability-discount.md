# R91: Ability cost reductions, highest-Might spell discount, Might per Trash card

Status: done. Fully supported cards 487 -> 492 of 1103 (`npm run cards` full count). Regression diff: no card lost or changed, 5 gained. Engine 885 tests (+5).

## What changed

- `ActivatedAbility.costReduction` ("This ability costs [N] less for each rune you control / if you control 4 or fewer runes"), applied to the real payment and the legal list (`abilityEnergyDiscount`); cost counts `RUNE` and `HIGHEST_MIGHT` ("This spell's Energy cost is reduced by the highest Might among units you control").
- Static count `TRASH_CARDS`: "My Might is increased by the number of cards in your Trash".

