# R86: Damage to all enemy units here, "... here" Might statics

Status: done. Fully supported cards 471 -> 477 of 1103 (`npm run cards` full count). Engine 869 tests (+3), client 426, scripts 31. Regression diff: no card lost or changed, 6 gained.

## What changed

- `DAMAGE_ALL.scope: 'here'` (the source's battlefield) and `amountFrom` ("damage equal to my Might"): "Deal N to all enemy units here".
- Static text "Other friendly units have +1 [M] here" and "I have an additional +1 [M]" are normalised to the existing static forms.

