# R62: return-self effect, battlefield / score conditions

Status: done (engine, parser). Fully supported cards 351 -> 353 of 1103 (`convertRow` count). Engine 760 tests (+3); all checks green.

## What changed

- Effect `RETURN_SELF`, conditions `CONTROLS_BATTLEFIELD` and `SCORE_NEAR`, parsed from the printed sentences ("return me to my owner's hand", "an opponent controls a battlefield", "... score is [not] within 3 points of the Victory Score").
- Cards now full: Vayne and Leona (and Corrupted Dragon / Find Your Center where their other text parsed).

## Not done

Excess-damage conditions, Deploy gear (The Good Stuff, Demacian Standard), "move an enemy unit to here".
