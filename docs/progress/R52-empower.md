# R52: Empower

Status: done (engine, parser, converter, client text). Fully supported cards 292 -> 299 of 1103 counting the 6 token definitions in `cards.json` (293 -> 299 vs R51's 292 without them is +7). Engine 729 tests (+3), client 426, scripts 30; typecheck, lint, check:rules green.

## Measurement

`m52b.ts` (scratchpad): treating each keyword line as supported and counting partial cards that turn full: Empower 24, Level 7, Flow 4, Predict 3, Vision 2. Empower was the biggest.

## What changed

- `CardInstance.empowered`, effect `EMPOWER_SELF` (event `EFFECT_EMPOWERED`), condition `EMPOWERED`.
- `activateAbility` refuses a second Empower while Empowered; the flag is cleared when a permanent enters play or returns to hand.
- Parser: "[Empower] <cost>" -> ability "<cost>: Empower me"; "[Empowered][>] I have ..." -> conditional static (`parseStaticLines`); "[Empowered][>] When I conquer, ..." -> trigger with `when: EMPOWERED`.
- Converter: `Empower` is a parsed keyword. Client: ability description "Empower this", event text.
- Cards now full: Punching Poro, Shadow Fiend, Serene Ascetic, Steel Paws, Nasus, Covert Informant (+1 from the R51 follow-up parse fix).

## Not done

Empower cost modifiers ("costs [N] less if / for each rune"), Disempower, Legend Empower, other [Empowered] effects.
