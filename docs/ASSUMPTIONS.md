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
