# R107: Might-based limits: gear cost vs my Might, total Might of other units

Status: done. Fully supported cards 537 -> 539 of 1103 (`npm run cards` full count). Regression diff: no card lost or changed, 2 gained. Engine 939 tests (+4).

## What changed

- `KILL_GEAR.maxEnergyMyMight` (limit read from the source unit's current Might) and condition `OTHER_UNITS_MIGHT {n}`.

