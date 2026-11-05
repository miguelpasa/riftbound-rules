# Rules Assumptions

Decisions made where the Core Rules (rev 2026-10-09) or the PRD are ambiguous.

1. **Hold at 7 points is unrestricted.** Rule 473.1.b (the "final point" restriction) is written for Conquer only, so a Hold that reaches the victory score wins normally.
2. **Mulligan is sequential in turn order** (Rule 117): p0 decides first, then p1.
3. **Keywords are deferred.** Only the keywords in `MVP_KEYWORDS` are implemented; others (Deathknell, Legion, ...) are typed but cards using them are `supportLevel: 'partial'` and resolve as `EFFECT_UNIMPLEMENTED`.
4. **PRD "Rule 607.1" does not exist.** Use Rules 432 and 473.1.b instead; never cite 607.1.
5. **Rune board is part of the base** (Rule 107.1.c): channeled runes are `RUNE` CardInstances in zone `base`.
6. **Scoring is a step of the BEGINNING phase**, modelled by `turn.step = 'SCORING'`.

- Exhausted runes may still be recycled for Power: the cost of the rune's Power ability is Recycle, not Exhaust (164.2.b). Only the Energy ability requires a ready rune. A recycled rune returns to the bottom of the Rune Deck.
- Universal Power ([A]) is not modelled in the Rune Pool; a cost's "any domain" Power is paid with Power of any single domain. Revisit if a card needs to add [A] to the pool.
- Hidden cards placed facedown must not emit a public CARD_PLAYED (it would leak cardId); use visibleTo:[controller] or a dedicated facedown event.
- Equip keyword value is treated as an Energy cost (missing value = free); paid via auto-planned rune activations.
- Deflect N is an additional Power cost payable with any domain; stacks per instance and per targeted Deflect unit.
- Hidden: usable the turn after it is hidden; played for cost 0 with Reaction speed; placing it facedown emits only a public CARD_HIDDEN (no card id).
- Hidden (as implemented, found by scenarios/hidden.test.ts): HIDE_CARD emits a CARD_PLAYED with `visibleTo: [controller]` and NO public event; `CARD_HIDDEN` exists in the event union but is never emitted, so the opponent learns of a facedown card only from `battlefields[].facedownSlotId` in their view. The earlier note about a public CARD_HIDDEN is not what the code does; add it in the engine if the client log needs it.
- Scenario/replay tooling: `Scenario.start()` picks the first seed whose RNG seats DECK A as p0 (the first player is random, Rule 115), so scenario tests are deterministic. `replayGame` uses `createGameWithEvents` (there is no separate `createGameWithSeating`; seating is part of `createGame`).

## Known deviations

- Quick-Draw: the attach target is chosen at play time (`PLAY_CARD` `targets[0]`, a unit you control on the board). If the controller has no unit the gear is played unattached, without an error.
- Equip bypasses the Chain/cost model: it is resolved immediately as an activated ability with an Energy-only cost (no Chain item, no Reaction window for the opponent).
- Burn Out with an empty Trash stops after one Burn Out when drawing several cards (approximation of 432.3).
- If several Showdowns/Combats are staged, the turn player does not choose: the one at the lowest battlefield index starts first (323.11/323.12).
- Combat healing (468.1.a.1) heals only the units at the combat battlefield; the rule heals all units, but no non-combat damage exists yet.
- A unit with both Tank and Backline is treated as Tank for damage assignment (467.2.c.8).
- Hide is only allowed in a Neutral Open state (and only at a battlefield you control).
- The Chosen Champion counts toward the 40-card minimum of the main deck (103.3 wording not verified verbatim).
- `getLegalActions` must only be used host-side with the full state; never forward a legal-action list built for another seat (it reveals hidden information such as hand contents).
