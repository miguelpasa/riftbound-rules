# R82: Return several units: all small units, one friendly and one enemy

Status: done. Fully supported cards 456 -> 459 of 1103 (`npm run cards` full count). Engine 851 tests (+3), client 426, scripts 31. Regression diff: no card lost or changed, 3 gained.

## What changed

- `RETURN_ALL_UNITS {maxMight}` ("Return all units with N Might or less to their owners' hands"; tokens cease to exist).
- "Return [another|a] friendly unit and an enemy unit to their owners' hands" is read as two chosen units (slots 0 and 1).

