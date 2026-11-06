# R54: Buff

Status: done (engine, parser). Fully supported cards 316 -> 321 of 1103 (`convertRow` count). Engine 735 tests (+3), client 426, scripts 30; typecheck, lint, check:rules green.

## Measurement

`m54.ts` (scratchpad): stripping Buff lines made 42 partial cards full, but most of those lines are "spend a buff", "buff all / up to N", "when you buff" or "instead" shapes. The simple targeted and self shapes were built; the rest need a Spend-Buff cost and mass targeting.

## What changed

- `CardInstance.buffed` (+1 Might in `effectiveMight`), `BUFF_TARGET.buff` and `BUFF_SELF.buff` (event `EFFECT_BUFF`), condition `BUFFED`; cleared on return to hand and on entering play.
- Parser: "[Buff] a [side] unit", "[Buff] / buff me", condition "I'm buffed".

## Not done

See ASSUMPTIONS R54: spend-a-buff costs, buff all / up to N, "when you buff" triggers, Buff on Legends' abilities, Sett and Lee Sin variants.
