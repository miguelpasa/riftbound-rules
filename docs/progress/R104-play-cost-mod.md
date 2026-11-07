# R104: Cost modifiers for the cards you play (statics)

Status: done. Fully supported cards 530 -> 532 of 1103 (`npm run cards` full count). Regression diff: no card lost or changed, 2 gained. Engine 929 tests (+3).

## What changed

- `StaticAbility.playCostMod {energy, min, spellsOnly?, subtype?}`: permanents (or the Legend) of the player reduce the Energy cost of the cards that player plays, never below `min`; folded into `selfEnergyDiscount` so payment, legal actions and the client price agree.

