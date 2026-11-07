# R81: "... instead" alternatives on targeted Might and damage effects

Status: done. Fully supported cards 449 -> 456 of 1103 (`npm run cards` full count). Engine 848 tests (+7), client 426, scripts 31. Card-data regression diff against the previous round: no card lost or changed, 7 gained.

## What changed

- `AltAmount` on `DAMAGE_TARGET` and `BUFF_TARGET`: "<effect>. If <condition>, <stronger effect> instead." The alternative replaces the amount (a [Buff] becomes a plain +N this turn with `temp`). Conditions: the chosen unit is Empowered / attacking / already buffed; or a controller or source condition (Level N via XP, a facedown card, "this is Empowered").
- Parser: `attachInstead`; Level lines in spells; `is/it's [Empowered]` read as plain words; spells may carry the Level keyword.

## Not done

- "... instead" that replaces a different kind of effect (Smite's banish), replacement of events ("if I would die ... instead").

