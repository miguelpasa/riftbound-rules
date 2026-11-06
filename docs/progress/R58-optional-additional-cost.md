# R58: optional additional cost to play, "if you paid the additional cost"

Status: done (engine, parser, converter, schema, client labels). Fully supported cards 336 -> 341 of 1103 (`convertRow` count). Engine 748 tests (+3), client 426, scripts 30; typecheck, lint, check:rules green; golden hashes unchanged; Playwright smoke, solo, abilities, mobile on a temporary port.

## Measurement

`m58.ts` / `m58b.ts` (scratchpad): "When you play me, if you paid the additional cost, ..." was the biggest single unparsed head (14 pieces), with "You may pay [N] as an additional cost to play me" (8 pieces) as its other half.

## What changed

- `CardDef.optionalAdditionalCost`, `PLAY_CARD.additionalCosts.extra` (also on the chain item), `CARD_PLAYED.paidExtra`, condition `PAID_ADDITIONAL` read by `triggers.ts` for play triggers.
- `playCard` pays the extra cost and records it; `getLegalActions` offers the paid variant when affordable; the client's variant keys / labels include it.
- Parser `parseOptionalAdditionalCost`, condition "you paid the additional cost"; converter stores the cost only when the text uses it; schema property added.
- Cards now full: Clockwork Keeper, Blast Corps Cadet, Frostcoat Cub, Sea Monkey, Masa.

## Not done

See ASSUMPTIONS R58 (spell replacement effects, conditional optional costs, a dedicated UI prompt: the client shows the paid variant as another entry in the play chooser).
