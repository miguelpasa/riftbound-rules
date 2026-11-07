# R77: Mandatory discards: "Discard N, then ..." triggers and Deathknells

Status: done. Fully supported cards 431 -> 439 of 1103 (`npm run cards` full count). Engine 830 tests (+4), client 426, scripts 31; typecheck, lint, check:rules green.

## What changed

- `OptionalCost.mandatory`: the optional-ability machinery (pending OPTIONAL_EFFECT choice, DECIDE_OPTIONAL with `costCards`) reused for costs that cannot be declined. `decideOptional` rejects a decline, `getLegalActions` lists only the accepts (the decline is kept only when nothing can be paid), the prompt hides the decline button, and the host timeout falls back to the first listed answer.
- At resolution a mandatory discard asks for min(N, hand size) cards; an empty hand just runs the effects.
- Parser: trigger bodies "Discard N" and "Discard N, then <effects>" (also in Deathknell and Legion forms).

## Not done

- Discard inside spells (Lunar Boon, Invert Timelines), each-player discards.

