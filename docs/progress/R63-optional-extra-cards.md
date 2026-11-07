# R63: optional additional costs with cards / XP

Status: done (engine, parser, converter, schema). Fully supported cards 353 -> 358 of 1103 (`convertRow` count). Engine 763 tests (+3); all checks green; Playwright smoke, solo, abilities pass on a temporary port.

## What changed

- `optionalAdditionalCost` gained `card`, `xp`, `reduceEnergy`; `playCostCard(def, repeat, extra)`; `playCard` and `getLegalActions` validate / enumerate the card choices, check and spend XP and apply the reduction; the client's cost-card picker also opens for an extra with a card choice.
- Parser `parseOptionalAdditionalCost` handles the new forms (including "As an additional cost to play this, you may ...").
- Cards now full: Shimmering Swimmer, Skystrike Squadron, Dune Devourer, Zaun Punk, Poppy.

## Not done

See ASSUMPTIONS R63.
