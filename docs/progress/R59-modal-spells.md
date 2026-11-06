# R59: modal spells

Status: done (engine, parser, converter, schema, client labels). Fully supported cards 341 -> 344 of 1103 (`convertRow` count). Engine 751 tests (+3), client 426, scripts 30; typecheck, lint, check:rules green; golden hashes unchanged; Playwright smoke, solo, abilities pass on a temporary port.

## What changed

- `CardDef.modes`, `PLAY_CARD.mode` (shape-checked in the reducer), `ChainItem.mode`, `spellEffects(def, mode)` used by target validation, legal actions and the resolver.
- Parser `parseModalSpell` ("Choose one —" plus dash lines); converter stores the modes; schema `modes`.
- Cards now full: Lost to the Sands, Flurry of Feathers, Mesmerize.

## Not done

Modal triggers and abilities, the "not chosen this turn" variants, modes with unparsed effects (Rocket Barrage "in a base", Encore), and a dedicated mode picker in the client.
