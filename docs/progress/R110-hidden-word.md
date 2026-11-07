# R110: "A card from [Hidden]" means played from face down

Status: done. Fully supported cards 541 -> 542 of 1103 (`npm run cards` full count). Regression diff: no card lost or changed, 1 gained. Scripts 33 tests (+1).

## What changed

- Text normalisation turns " from [Hidden]" into " from face down" so the Hidden bracket is not read as the keyword (Ember Monk).

