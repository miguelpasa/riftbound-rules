# R79: "Move an enemy unit to that battlefield / here" effect moves

Status: done. Fully supported cards 444 -> 447 of 1103 (`npm run cards` full count). Engine 838 tests (+3), client 426, scripts 31; typecheck, lint, check:rules green.

## What changed

- Targeted effect `MOVE_HERE_TARGET {side}`: the chosen unit (from the Base or any battlefield) moves to the source's battlefield as an effect move, raising `UNIT_MOVED` so "When I move" abilities and the Cleanup (Combat when both sides are present) see it. It fizzles if the source is not at a battlefield.
- Parser: "Move a(n) [enemy|friendly] unit to here / that battlefield / my battlefield / this battlefield" (also "you may").

## Not done

- Moves to a location of the player's choice ("to a different battlefield", Charm, Void Assault), "move me to that battlefield" (Vex), several units (Azir, Corrupted Dragon).

