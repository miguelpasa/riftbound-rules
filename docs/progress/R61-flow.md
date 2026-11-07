# R61: Flow

Status: done (engine, parser, converter, schema). Fully supported cards 347 -> 351 of 1103 (`convertRow` count). Engine 757 tests (+3), client 426, scripts 30; all checks green.

## What changed

- `CardDef.flowCost`, `PLAY_CARD.additionalCosts.flow` (also on the chain item); `playCard` accepts a spell from the owner's Trash only with the flag, charges the Flow cost instead of the printed one and the resolver banishes it; `getLegalActions` lists Flow plays (per mode / target).
- Parser `parseFlowCost`; converter stores it for fully supported spells; schema `flowCost`.
- Cards now full: Brittle Steel, Dredge Up, Iterative Design, Onslaught.

## Not done

Granted Flow, Flow on non-spells, other play-from-Trash permissions (about 25 cards), a dedicated client entry (the Flow play appears as one more "Play" variant with no Trash browser).
