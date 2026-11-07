# R65: counted draws, mass return, ready-and-grant

Status: done (engine, parser). Fully supported cards 360 -> 365 of 1103 (`convertRow` count): Right of Conquest, Show of Strength, Downwell, Perfect Execution and one more. Engine 767 tests (+3); all checks green.

## What changed

- `DRAW.per` ('BATTLEFIELD' | 'MIGHTY_UNIT'), effect `RETURN_ALL_BOARD`, the sentence split "Ready a unit and give it ...", and their parser forms.

## Measurement

`m65.ts <type>` (scratchpad) lists the cards with exactly one unparsed piece: for spells the list is long and every entry is a different shape (moves with locations, "instead" replacements, "when it dies this turn" delayed triggers, discards with a choice).

## Not done

Move effects (need a location choice), replacement effects ("... instead"), delayed "this turn" triggers, discard-and-draw effects.
