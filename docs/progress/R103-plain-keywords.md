# R103: Keywords printed as plain words

Status: done. Fully supported cards 528 -> 530 of 1103 (`npm run cards` full count). Regression diff: no card lost or changed, 2 gained. Scripts 32 tests (+1).

## What changed

- Card text normalisation brackets `Ganking`, `Hidden`, `Action`, `Tank`, `Backline`, `Reaction` when one starts a line and a reminder follows (three printings write them without brackets).

