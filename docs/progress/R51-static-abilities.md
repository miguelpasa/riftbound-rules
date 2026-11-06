# R51: static abilities (keyword and Might grants)

Status: done (engine, parser, converter, schema). Fully supported cards 282 -> 292 of 1103 (`cards.json` itself counts 298 with 6 token definitions). Engine 726 tests (+5), client 426, scripts 30; typecheck, lint, check:rules green; golden hashes unchanged; Playwright smoke, solo, abilities 11/11 on a temporary port.

## What changed

- `CardDef.statics` (`StaticAbility`: affects / subtype / when / might / keywords) and `engine/src/statics.ts` (`staticBonus`, `defWithGrants`), wired into `effectiveMight`, combat tier reads, the Ganking move check and Deflect surcharges. A per-database cache skips all work when no card has statics.
- Parser `parseStaticLines`: "<Your gear | Friendly units | Your Mechs | Other friendly units here | Units here | I> have [Keyword]... or +N [M]", "While <condition>, ..." and "... while <condition>"; plus the condition "you have another unit here".
- Converter: static lines are taken out of the text before keyword extraction (so a granted [Deflect] is no longer mistaken for the card's own keyword); applies to units, gear, Legends and Battlefields.
- Schema: `statics` and `costReduction` (the latter was missing in R50, see the note in ASSUMPTIONS R51).
- Cards now full include Captain Farron, Taric, Windswept Hillock, Trifarian War Camp, Master Yi, Watchful Curator, Petricite Monument, Mechanized Menace, Breakneck Mech, Allay.

## Not done

Disarm grants, "equal to the number of" values, buffed / Mighty conditions, "alone" conditions, spell grants, "can't" restrictions, static cost modifiers of other cards.
