# R55: Predict and Vision

Status: done (engine, parser, converter). Fully supported cards 321 -> 329 of 1103 (`convertRow` count). Engine 738 tests (+3), client 426, scripts 30; typecheck, lint, check:rules green.

## What changed

- Effect `PREDICT { count }` with a deterministic policy (keep what costs at most runes + 2, recycle the rest to the bottom); events reuse CARDS_LOOKED_AT / CARDS_RECYCLED.
- Parser: "[Predict]" / "[Predict N]" sentences; the Vision keyword line is a PLAY trigger. Converter: Predict (spells) and Vision are parsed keywords.
- Cards now full: Consult the Heavens, Clairvoyance, Eclipse, Mystic Poro, Jeweled Colossus, Mysterious Chronomancer, Dramatic Visionary, and one more.

## Not done

The interactive Predict choice (client prompt + intent), Predict with a computed count, per-player Predict, "become exhausted" triggers.
