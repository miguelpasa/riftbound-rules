# R80: Counters limited by the countered spell's cost (Hush, Defy)

Status: done. Fully supported cards 447 -> 449 of 1103 (`npm run cards` full count). Engine 841 tests (+3), client 426, scripts 31; typecheck, lint, check:rules green.

## What changed

- `COUNTER_SPELL` gained `minPower`, `maxEnergy`, `maxPower`: the legal-target check for spells on the Chain compares the printed cost of the spell. Parser: "Counter a spell with Power cost [A][A] or more" and "Counter a spell that costs no more than [4] and no more than [A]".

## Not done

- "... if an opponent has played another spell this turn" (Crumbling Sands), "Counter an enemy spell or ability that chooses a friendly unit or gear" (Not So Fast).

