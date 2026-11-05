# Rules Assumptions

Decisions made where the Core Rules (rev 2026-10-09) or the PRD are ambiguous.

1. **Hold at 7 points is unrestricted.** Rule 473.1.b (the "final point" restriction) is written for Conquer only, so a Hold that reaches the victory score wins normally.
2. **Mulligan is sequential in turn order** (Rule 117): p0 decides first, then p1.
3. **Keywords are deferred.** Only the keywords in `MVP_KEYWORDS` are implemented; others (Deathknell, Legion, ...) are typed but cards using them are `supportLevel: 'partial'` and resolve as `EFFECT_UNIMPLEMENTED`.
4. **PRD "Rule 607.1" does not exist.** Use Rules 432 and 473.1.b instead; never cite 607.1.
5. **Rune board is part of the base** (Rule 107.1.c): channeled runes are `RUNE` CardInstances in zone `base`.
6. **Scoring is a step of the BEGINNING phase**, modelled by `turn.step = 'SCORING'`.

- Exhausted runes may still be recycled for Power: the cost of the rune's Power ability is Recycle, not Exhaust (164.2.b). Only the Energy ability requires a ready rune. A recycled rune returns to the bottom of the Rune Deck.
- Universal Power [A] is modelled as `RunePool.universal` (pays any domain, spent after specific Power). `addUniversalPower` exists, but no card effect adds it yet (needs activated abilities, e.g. Gold tokens).
- Hidden cards placed facedown must not emit a public CARD_PLAYED (it would leak cardId); use visibleTo:[controller] or a dedicated facedown event.
- Equip keyword value is treated as an Energy cost (missing value = free); paid via auto-planned rune activations.
- Deflect N is an additional Power cost payable with any domain; stacks per instance and per targeted Deflect unit.
- Hidden: usable the turn after it is hidden; played for cost 0 with Reaction speed; placing it facedown emits a public CARD_HIDDEN (no card id) and a CARD_PLAYED visible only to its controller.
- Hidden (R23, implemented): HIDE_CARD emits a private CARD_PLAYED (`visibleTo: [controller]`, the only event with the cardId) and a public `CARD_HIDDEN { player, battlefieldId }` with no card id. Both players' logs therefore say that a card was hidden at that battlefield, while the opponent's view of the facedown card still comes from `battlefields[].facedownSlotId` and the sanitized state. `hidden.test.ts` checks that the opponent's stream has no CARD_PLAYED and no card id.
- Scenario/replay tooling: `Scenario.start()` picks the first seed whose RNG seats DECK A as p0 (the first player is random, Rule 115), so scenario tests are deterministic. `replayGame` uses `createGameWithEvents` (there is no separate `createGameWithSeating`; seating is part of `createGame`).

## Known deviations

- Quick-Draw: the attach target is chosen at play time (`PLAY_CARD` `targets[0]`, a unit you control on the board). If the controller has no unit the gear is played unattached, without an error.
- Equip is now a Chain ability (151.2.a): usable in your Main Phase in a Neutral Open state only, the opponent can respond, and the attachment happens on resolution. Its cost is still Energy only: the dataset gives a single number, but the official cost can include Power (206.1).
- If several Showdowns/Combats are staged, the turn player does not choose: the one at the lowest battlefield index starts first (323.11/323.12).
- A unit with both Tank and Backline is treated as Tank for damage assignment. Rule 467.2.c.8 lets the assigning player choose which of the two applies; the choice is not offered.
- Hide is only allowed in a Neutral Open state (and only at a battlefield you control).
- The Chosen Champion counts toward the 40-card minimum of the main deck (103.3 wording not verified verbatim).
- `getLegalActions` must only be used host-side with the full state; never forward a legal-action list built for another seat (it reveals hidden information such as hand contents).

## Verified against the official Core Rules (rev 2026-10-09, read verbatim)

Confirmed correct: Burn Out procedure and repetition (432.2, 432.3, 432.3.a-c); the Final Point rule applies to Conquer only (473.1.a.1, 473.1.b.1) and "every Battlefield" counts Conquer and Hold; Cleanup step order (323); the Turn Player chooses among staged Showdowns/Combats (323.11, 323.12, 463.1); mulligan in turn order, 0-2 cards (117); 12 Rune cards (103.4.a); the second player's extra Channel (487.7); Open/Closed x Neutral/Showdown play restrictions (308-310); Hide is a Discretionary Action in a Neutral Open State on your turn (411.1.a, 422); scoring once per battlefield per turn across Conquer and Hold (472); win check in Cleanup step 1 (323.1).

Fixed after this check: repeated Burn Out with an empty Main Deck and Trash; combat healing heals all units (468.1.a.1).

Still deviating (see REMAINING.md): the turn player's choice of staged Showdown (R11); Tank+Backline choice (467.2.c.8); Equip's Power cost.

Not verified: the keyword glossary (rules 806-832: Action, Assault, Deflect, Ganking, Hidden, Shield, Tank, Temporary, Equip, Quick-Draw, Backline) was cut off when the page was fetched; read the official PDF linked from riftbound.gg/rules/core-rules to check the exact keyword text.
