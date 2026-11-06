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

## R42: attack/defend triggers, scopes, optional targets, Weaponmaster, Repeat (A-R42)

- **ATTACK / DEFEND fire when the combat Showdown begins (UNCLEAR timing).** A unit is an Attacker iff its controller is the attacker (466.2.c, the existing combat code); both designations apply as soon as the combat Showdown starts, so the triggers go on the Chain at that point with targets chosen as in R41. The Core Rules text for attack/defend triggers was not re-read.
- **Disarm N (831, number UNCLEAR)** is the attack trigger "give an enemy unit here -N [M] this turn" (no minimum Might); several instances sum into one trigger, as docs/KEYWORD_RULES_CHECK.md records. "Here" means the same battlefield as the source; a source in a Base has no "here".
- **"You may" with a target = "up to one"; choosing nothing declines (UNCLEAR rule number).** The pending choice is the existing `TRIGGER_TARGET`; the empty answer is only offered when every slot is optional. No legal target at all skips the trigger like any other targeted trigger. A host timeout declines.
- **Weaponmaster (821, number from KEYWORD_RULES_CHECK.md):** you choose an Equipment you control when the play trigger is put on the Chain; its Equip cost minus one Power ([A], taken from the generic requirement first) is paid with an automatic rune plan when the trigger resolves; the Equipment is attached to the source unit (moving it if attached elsewhere). Not payable then: nothing happens. Non-resource Equip costs are not enforced (same as Equip, see the Equip cost note). UNCLEAR whether the payment should be chosen by the player and whether it happens on the Chain.
- **Repeat (820, number from KEYWORD_RULES_CHECK.md) repeats the effects with the SAME targets/choices (UNCLEAR).** The glossary summary says "choices made again", but only Rocket Barrage's reminder says the repeat "may make different choices", which suggests the default is the same choices. The cost is an optional additional cost ([N] Energy plus [C] Power of the spell's Domain), each at most once. Each pass re-checks target legality, so a target that became illegal is skipped on the second pass.
- **"This enters exhausted"** (Gear): Gear enters ready (359.2.d) unless this text is present.
- **Kill a gear "with Energy cost N or less"** compares the printed Energy cost (tokens count as 0).

## R43: Ambush, conditions, move triggers, temporary keywords (A-R43)

- **Ambush (822, number from docs/KEYWORD_RULES_CHECK.md; UNCLEAR wording).** The official page riftbound.gg/rules/core-rules did not render for the fetch tool, so the text was NOT verified against the Core Rules. Implemented from the printed reminder text: "You may play me as a [Reaction] to a battlefield where you have units." A Unit with Ambush played to a battlefield where its controller already has another Unit has Reaction speed for that play (Closed state and Showdown allowed, Priority still required) and may target a battlefield the opponent controls or nobody controls. Without a unit of yours there, or at the Base, the normal timing and location rules apply. UNCLEAR: whether the unit then joins an ongoing combat (the engine derives combat roles from the unit controller, so it does). Rengar ("can be played to a battlefield where there are enemy units") and Stalking Wolf ("even if you don't have other units there") are not parsed and stay partial.
- **Conditions are checked at two moments (UNCLEAR, no rule read):** a triggered ability's `when` is checked as it triggers (no Chain item is created when false, like a Legion condition) and again as it resolves (intervening-if); `entersReadyWhen` is checked as the permanent enters, before it counts for itself ("you control no other units" excludes the entering unit). The resolution check is the conservative choice: effects never happen when the board no longer matches.
- **Conditions read only public data and hand SIZES** (`evalCondition`). `where: 'here'` is false when the source is not at a battlefield. `other` excludes the source. "Units" include Unit tokens; "gear" includes Gear tokens; runes are the Rune cards on the board.
- **"When I move" fires only for moves that arrive at a battlefield** (UNIT_MOVED with `to` a battlefield). UNIT_MOVED is also emitted for recall and combat retreat to the Base and carries no cause, so moves to the Base never trigger (UNCLEAR whether a standard move to the Base counts as a move).
- **Temporary keyword grants** last until the Ending step with the other "this turn" effects and are public state (`CardInstance.tempKeywords`). Only Assault, Shield, Tank and Ganking are read (combat Might, damage assignment tier, battlefield-to-battlefield move); Deflect and Backline grants are not parsed. Granted values stack with printed ones like duplicate keywords.
- **Not hooked (cost too high):** start/end of turn triggers (the turn sequence runs in one reducer step and `fireTriggers` only sees the events afterwards, so conditions would be evaluated in the next player's Main Phase), become exhausted/ready.

## R44: Battlefield card triggers (A-R44)

- **A Battlefield card's ability is not an object.** Its Chain item carries `sourceBattlefieldId` (the `BattlefieldState` id, 'bf0' / 'bf1') and `sourceObjectId: ''`; the ability's "here" is that battlefield, its conditions are evaluated at it, and its targets use the same R41 `TRIGGER_TARGET` flow. Object ids ('oN') and battlefield ids never overlap, so effects and conditions take one `sourceId` string.
- **"You" is the player the moment is about** (UNCLEAR, no rule text read): the scoring player for "When you hold / conquer here", the combat's defender for "When you defend here" and its attacker for "When you attack here". The battlefield's controller is not used, so a player who Conquers a battlefield triggers that battlefield card's text for themselves, whoever owns the card.
- **The battlefield's trigger is put on the Chain before the units' triggers of the same moment**, within the usual order (turn player's first, so the other player's resolves first). UNCLEAR: no rule on ordering simultaneous triggers from different sources was read.
- **Hold / Conquer triggers fire even when the Final Point rule (473.1.b) denies the point.** The trigger is about conquering/holding, `BATTLEFIELD_SCORED` is emitted either way, and the existing unit "When I conquer" triggers already behaved this way (UNCLEAR: if "conquer here" text should only fire when a point is scored, only `collect` in triggers.ts changes). A battlefield already scored by that player this turn (472) does not trigger again.
- **"When you defend here" fires when the combat Showdown starts,** like unit DEFEND (R42), whether or not the defender still has units there afterwards.
- **A condition on a battlefield trigger is checked as it triggers and again as it resolves** (R43 convention). "You have 7+ units here" counts the controller's units at that battlefield (tokens included). "Your Rune Deck is empty" reads the Rune Deck size (public).
- **[Burn N] / "put the top N cards of your Main Deck into your trash"** mills up to N cards (fewer if the deck is smaller) and is never a Burn Out (432 is about drawing from an empty deck). Event `CARDS_BURNED` carries a count only; the cards are in the public Trash.
- **"You score 1 point" (Cosmic Vista) is an effect point** (`POINT_GAINED`, source `EFFECT`): it is not Hold/Conquer scoring, so it is exempt from the Final Point restriction (473.1.a.1) and does not mark the battlefield scored. The win check runs in the Cleanup that follows.
- **"You win the game" (The Grand Plaza)** ends the game as soon as the trigger resolves (`GAME_ENDED`), without waiting for a point check. It uses the normal Chain, so the opponent can respond first (UNCLEAR whether that matches the rules).
- **"Draw 1 for each other battlefield you or allies control" (Seat of Power)** counts, at resolution, the battlefields controlled by the controller other than this one (there are no allies in a 1v1 game).
- **"Each player channels 1 rune exhausted" (The Papertree)** channels for the controller first, then the opponent.
- **Not done:** static battlefield text (25 cards), triggers on other events (17), optional / paid non-targeted effects (13; a pay/decline choice does not exist yet) and effect shapes without an engine meaning (12). See docs/progress/R44-battlefield-triggers.md.
