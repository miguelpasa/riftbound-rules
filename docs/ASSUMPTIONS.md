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
- Equip cost (R36, 818): the converter parses the printed cost into `CardDef.equipCost` (`energy`, `power` = [C] Power of the Equipment's domain, `anyPower` = [A]); Equip pays Energy and Power via `computeTotalCost`/`autoPlan`. All 41 Equip cards now have a cost. A card with no parsed cost stays free. Non-resource parts (Kill a friendly unit, Recycle 2 cards, Spend 1 XP; 3 cards) are recorded in `equipCost.nonResource` but NOT enforced; "[A] or exhaust a friendly unit" is charged as [A]; `[3][A]` reduces Energy by the chosen unit's Might (`energyReducedByMight`).
- Deflect N is an additional Power cost payable with any domain; stacks per instance and is charged for every time a Deflect permanent (Unit, Gear or Token) is chosen as a target (R36, 809; no per-object dedupe). Abilities that target are NOT charged yet, even though targeted triggers and activated abilities now exist (R41; see "R41" below).
- Quick-Draw has Reaction speed inherently (R36, 819): `canPlayNow` treats QuickDraw as Reaction.
- Hidden Gear (R36, 811) is played to the battlefield where it was hidden (via `PlayHooks.hiddenAt`); Cleanup then recalls it to the Base like any non-unit permanent at a battlefield (323.6). Temporary applies to Units, Tokens and Gear (816). The converter drops `Temporary` from SPELL/LEGEND/BATTLEFIELD rows (the bracket there is part of an effect, e.g. "Give it [Temporary]").
- Hide timing decision (R36): kept Neutral Open only. Rule 811 says "during an Open State", but Hide is a Discretionary Action and 411.1.a limits those to a Neutral Open State on your turn, so Showdown Open States do not allow it.
- Hidden: usable the turn after it is hidden; played for cost 0 with Reaction speed; placing it facedown emits a public CARD_HIDDEN (no card id) and a CARD_PLAYED visible only to its controller.
- Hidden (R23, implemented): HIDE_CARD emits a private CARD_PLAYED (`visibleTo: [controller]`, the only event with the cardId) and a public `CARD_HIDDEN { player, battlefieldId }` with no card id. Both players' logs therefore say that a card was hidden at that battlefield, while the opponent's view of the facedown card still comes from `battlefields[].facedownSlotId` and the sanitized state. `hidden.test.ts` checks that the opponent's stream has no CARD_PLAYED and no card id.
- Scenario/replay tooling: `Scenario.start()` picks the first seed whose RNG seats DECK A as p0 (the first player is random, Rule 115), so scenario tests are deterministic. `replayGame` uses `createGameWithEvents` (there is no separate `createGameWithSeating`; seating is part of `createGame`).

## Known deviations

- Quick-Draw: the attach target is chosen at play time (`PLAY_CARD` `targets[0]`, a unit you control on the board). If the controller has no unit the gear is played unattached, without an error.
- Equip is now a Chain ability (151.2.a): usable in your Main Phase in a Neutral Open state only, the opponent can respond, and the attachment happens on resolution. Its cost (Energy and Power) now comes from `CardDef.equipCost` (see above).
- Several staged Showdowns/Combats (323.11/323.12, 463.1): the Cleanup pauses on `flow.pendingChoice` and the turn player answers with `CHOOSE_STAGED`; with exactly one candidate nothing is asked. Host timeout policy for an undecided choice: see docs/progress/R11-R13-showdown-order.md.
- A unit with both Tank and Backline (467.2.c.8): the damage assignment is accepted if it is legal for either choice, there is no separate prompt (the order you assign in is the choice). `autoAssign` treats it as Tank.
- Hide is only allowed in a Neutral Open state (and only at a battlefield you control); confirmed by 411.1.a (R36).
- The Chosen Champion counts toward the 40-card minimum of the main deck (103.3 wording not verified verbatim).
- `getLegalActions` must only be used host-side with the full state; never forward a legal-action list built for another seat (it reveals hidden information such as hand contents).

## Verified against the official Core Rules (rev 2026-10-09, read verbatim)

Confirmed correct: Burn Out procedure and repetition (432.2, 432.3, 432.3.a-c); the Final Point rule applies to Conquer only (473.1.a.1, 473.1.b.1) and "every Battlefield" counts Conquer and Hold; Cleanup step order (323); the Turn Player chooses among staged Showdowns/Combats (323.11, 323.12, 463.1); mulligan in turn order, 0-2 cards (117); 12 Rune cards (103.4.a); the second player's extra Channel (487.7); Open/Closed x Neutral/Showdown play restrictions (308-310); Hide is a Discretionary Action in a Neutral Open State on your turn (411.1.a, 422); scoring once per battlefield per turn across Conquer and Hold (472); win check in Cleanup step 1 (323.1).

Fixed after this check: repeated Burn Out with an empty Main Deck and Trash; combat healing heals all units (468.1.a.1).

Still deviating (see REMAINING.md): Equip's Power cost.

Not verified: the keyword glossary (rules 806-832: Action, Assault, Deflect, Ganking, Hidden, Shield, Tank, Temporary, Equip, Quick-Draw, Backline) was cut off when the page was fetched; read the official PDF linked from riftbound.gg/rules/core-rules to check the exact keyword text.

## R38: activated abilities, Legion effects (A-R38)

- **[Add] abilities skip the Chain (UNCLEAR).** Rule 168 says abilities that Add put Energy / Power in the Rune Pool; 166.1 says it goes to the controller's pool. The printed reminder says abilities that add resources cannot be reacted to. Rule 430 (the full [Add] text) and the Chain handling of Add abilities (chain.ts cites 340.2.a / 346.1) were not readable. Engine choice: an ability whose effects are all [Add] resolves at once, needs no Priority and no timing check (like ACTIVATE_RUNE, 164.2), even when the card prints no [Reaction]. Other abilities use the Chain with canPlayNow (Reaction abilities in a Closed state or Showdown, the rest only in a Neutral Open state on your turn).
- **[Add] [C]** adds Power of the source card's first Domain (Universal if it has none). **[Add] [A]** adds Universal Power. **[Add] [N]** adds N Energy.
- **Legion is checked when the ability triggers** (after the card is on the Chain), not when it resolves. Rule 812 text was not read verbatim (summary in KEYWORD_RULES_CHECK.md). The Legion cost reduction is an Energy discount applied before the play is recorded; the source never counts for itself.
- **Gold** is tok-gold, a TOKEN without Might (a gear-like permanent) with the printed ability: Reaction, Kill this, exhaust: Add [A]. Tokens without Might count as gear for "Kill a gear" and Return-to-hand. A killed Gold ceases to exist (186.1).
- Not enumerated by getLegalActions: [Add] abilities (offered by getAbilityActivations, like rune activations), so the bot never spends Gold or Seals.

## R41: targeted triggered and activated abilities (A-R41)

- **Targets are chosen when the trigger is put on the Chain, by its controller (UNCLEAR rule number; 355.10 is the spell version).** The Core Rules text for triggered abilities was not re-read; the engine reuses the spell target check (`spellTargetsLegal`) and re-checks at resolution (fizzle).
- **No legal target: the triggered ability is not put on the Chain (UNCLEAR).** Reported with `TRIGGER_NO_TARGET`. **Exactly one legal choice is taken automatically** (a convenience, not a rule). With several, the controller chooses before anyone may act.
- **Several triggers waiting for targets are asked in Chain order** (the turn player's first). Which controller orders simultaneous triggers is the existing convention from R5.
- **Deflect is not charged** when an opponent's triggered or activated ability targets a Deflect permanent (UNCLEAR whether and when 809 applies to triggers). Spells still pay it.
- **Timeout default** for a human who does not choose: the first enumerated combination (lowest object id).
- **`ACTIVATE_ABILITY.targets`** are validated before the cost is paid; extra targets on a target-free ability are rejected (`ILLEGAL_TARGET`).
