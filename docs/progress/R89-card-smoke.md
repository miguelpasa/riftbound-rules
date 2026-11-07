# R89: Smoke test for every supported card (no new card support)

Status: done. Fully supported cards 486 -> 486 of 1103 (`npm run cards` full count). New `npm run smoke:cards` (scripts/smoke-cards.ts). Seeds `smoke` (12 games), `audit1` (60 games, 14 turns) and `audit2` (40 games, 12 turns): 0 failures; up to 282 of 355 supported interesting cards were actually played.

## What changed

- `scripts/smoke-cards.ts`: seeded games whose main decks are random fully supported cards (Legend's Domains, no Signature cards, three copies at most including the Chosen Champion), played by a mix of the AI and a random legal mover. It fails on any illegal intent, engine exception, or when replaying the intent log from the initial state gives a different final state hash (reduce purity).
- This is a safety net for the card-text work of R71 to R88: it proves supported cards cannot crash the engine, stall a game or make `reduce` impure. It does not prove a card does what its text says; the scenario tests do that per mechanic.

