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

## R45: optional "you may [pay COST to] ..." abilities (A-R45)

- **When the answer is given (UNCLEAR, no rule text read):** the controller of a triggered ability decides when it RESOLVES, not when it is put on the Chain. Targets are still chosen as the trigger is put on the Chain (355.10, R41), the cost is paid only on accept. So the opponent can respond to the ability (for example by removing its target) before the controller commits resources.
- **Auto-decline:** when the cost cannot be paid at that moment (not enough Energy / Power in the Rune Pool plus runes, or fewer cards than [Burn N]) the ability is declined without asking (`OPTIONAL_EFFECT_DECIDED accepted: false`). Whether a player may "pay" with resources they could still generate is not modelled beyond `autoPlan`.
- **Payment plan:** the pending choice carries only the cost. `DECIDE_OPTIONAL.payment` is a normal rune plan (EXHAUST for Energy, RECYCLE for Power) validated by `payCost`; when it is absent the engine uses `autoPlan` (fewest recycled runes, exhausted runes first). The client offers the automatic plan only. While the choice is pending nothing else is allowed, so a player cannot pre-fill the Rune Pool by hand.
- **[C] and [A] in an optional cost:** [C] is Power of the source card's Domain (Universal when the card has none, e.g. a Battlefield card), [A] is any Power, both through the existing `PowerRequirement` machinery (`genericPower`).
- **[Burn N] as a cost** is payable only with at least N cards in the Main Deck (a smaller deck declines), unlike the [Burn N] effect (R44), which mills as many as it can.
- **Timeout / fallback = decline:** `getLegalActions` lists Decline first, so every "take the first legal action" fallback (host bot fallback, tutorial autopilot, host timeout) declines. A bot that is not stuck decides by search like any other action.
- **"You may pay [1] to ..." on a Battlefield card:** "you" is the player the moment is about (A-R44); the cost is paid by that player.
- **Rule numbers:** 357.1.a (paying a cost) and 355.10 (targets) are cited by the tests; the rule that makes "you may" optional at resolution was not found, so this reading is unverified.
- **"unit you control" = "friendly unit", "When you play me to a battlefield"** = a PLAY trigger with the `AT_BATTLEFIELD` condition (the unit stands at a battlefield as the ability triggers; it is not checked again by position at resolution beyond the R43 recheck).
- **Not done (R45, partly done in R46):** discard / kill / exhaust / "spend a buff" costs (a card or unit must be chosen; R46 did all but "spend a buff"), "then you may" chains that refer to an earlier result ("if you do"), Predict-style "you may recycle it" (hidden information in a public pending choice), optional effects of other trigger moments ("when you play a card", "when a unit dies").

## R46: card-choice costs (A-R46)

- **When the cards are chosen (UNCLEAR, no rule text read):** at the same moment as the R45 answer. For an optional triggered ability the cards travel in `DECIDE_OPTIONAL.costCards` and are paid on accept together with Energy / Power / Burn; for an activated ability they travel in `ACTIVATE_ABILITY.costCards` and are paid when the ability is activated (before it goes on the Chain). The engine checks the whole choice (count, all distinct, each qualifying) before paying anything; a bad choice leaves the state untouched.
- **"you may discard 1 and channel 1 rune exhausted" (Ruined Monastery)** is read as one optional action whose first part is a cost: accepting discards, then channels. Declining does neither. UNCLEAR whether the printed text means two independent options.
- **Auto-decline** (as in R45): an optional ability whose card cost has fewer qualifying cards than it needs is declined without a prompt; an activated ability with such a cost is simply not offered.
- **Kill as a cost:** a killed unit receives lethal damage and the Cleanup moves it to the Trash (so Deathknell and other death triggers fire as for any kill); a gear goes to the Trash at once (a token ceases to exist). The killed unit may be the ability's own source unless "another" is printed (a self-kill is not parsed yet).
- **Exhaust as a cost** needs a ready friendly unit. **Return** sends a unit or gear to its owner's hand (a token ceases to exist, 186.1; damage and bonuses are cleared). **Discard** moves a hand card to its owner's Trash. **Recycle N from your trash** puts the chosen cards at the bottom of the Main Deck in the order chosen (no shuffle).
- **Friendly only:** kill / exhaust / return are costs only when the text says "friendly" or "you control" (an enemy choice is an effect, not a cost, and keeps the card partial). "Unit you control here" / "another" are scoped to the source's battlefield / not the source.
- **Hidden information:** discarding reveals the card because the Trash is public; the `COST_CARDS_PAID` event names the cards after they are discarded (the opponent never saw the hand or the list of candidates). The legal choices are enumerated only for the payer.
- **"Kill a unit or gear"** (Mordekaiser) is one target slot that accepts either kind (`KILL_TARGET.orGear`); a gear is killed like `KILL_GEAR`.
- **Deathknell with "here"** (Mournful Spirit) stays partial: the engine keeps no "where it died", and the unit is already in the Trash when the ability resolves.
- **Enumeration cap:** `getLegalActions` lists at most `MAX_TARGET_COMBOS` (48) choices of cost cards per ability / optional effect, in object order. The engine accepts any legal choice, so the client builds the intent from its own candidate list when a combination is not listed (matters for "Recycle 3" from a big Trash).
- **Rule numbers:** tests cite 357.1.a (paying a cost), 145.1 (activated abilities), 355.10, 186.1, 323, 140, 340.1, 106, 473.2; the rule that lets a cost be chosen from hand / board was not located, so everything above is unverified.
- **Not done:** additional costs to play a card ("As an additional cost to play this, exhaust a friendly unit": Ki Burst, Life from Stone, Parallel Convergence, Ekko, Legion Quartermaster, Cruel Patron, Sacrifice) need `PLAY_CARD.costCards`; "spend a buff" (needs the Buff state); self-sacrifice ("kill me"); "kill N of ... and/or ..." beyond one component; a second card component in one cost.

## R47: additional costs to play a card (A-R47)

- **Order of choices (UNCLEAR, no rule text read):** the cost cards (`PLAY_CARD.costCards`) are validated together with the targets, before anything is paid; the engine does not care in which order the player decides them. The client asks for the cost cards first, then the targets and location. If the rules say targets come first only the prompt order changes.
- **Paid with the rest of the cost (357.1.a assumed):** the card-choice part is paid when the Energy / Power part is paid, atomically; a rejected play changes nothing (358.5). `COST_CARDS_PAID` precedes `CARD_PLAYED`.
- **A discard cost never takes the card being played** (it is still in the hand while its cost is paid). UNCLEAR whether the rules would let a card pay for itself.
- **The cost cards may be the spell's own target** (kill / return it): the play is legal and the spell fizzles. The legal-action list hides those pairs; a hand-built intent works.
- **[Mighty] = 5 or more Might** (Sacrifice's reminder text); current Might outside combat, with buffs and attached equipment. No rule number located.
- **Hidden cards** keep their additional cost when played from the facedown zone (the existing comment in `playHiddenCard` says additional costs still apply).
- **Repeat's card cost** (`[Repeat] - Discard 1`, Square Up) is the optional additional cost of Repeat; paying it needs a card other than the spell; with no other card in hand only the plain play is offered. A card with both a required card cost and a Repeat card cost is rejected (none exists).
- **Legend cost modifiers** ("As an additional cost to play a spell, you may exhaust me ... to reduce the cost", Starry-Eyed Songstress) are a cost modifier of other cards, not an own additional cost; the card stays partial.
- **Rule numbers:** tests cite 357.1.a, 358.5, 359.2, 323, 820; none of the sentences above was checked against the rule text.
- **Not done:** required additional costs with an Energy / Power part, "if you paid the additional cost" effect text, Repeat with several costs or granted Repeat, board-click cost picking.

## R49: "When you play a <card>" triggers (A-R49)

- **Source's own play (UNCLEAR, no rule text read):** a permanent's "When you play a spell / unit / ..." ability does not fire for the play of that same card ("When you play me" is the separate PLAY form). "Another" is kept in the filter for fidelity but every non-self play already counts as another.
- **Which permanents listen:** the player's units and gear on the board and their Legend in its zone. Triggers fire after the play (CARD_PLAYED), before the played card resolves, with the played card's controller as the controller of the ability.
- **Filters:** card type (spell / unit / gear), the printed Energy cost ("with Energy cost [7] or more", "that costs [5] or more"), "on an opponent's turn" (the active player is not the player who played) and "during a showdown" (a Showdown is in progress). Power-cost, "from face down", "[Mighty]" and "if you spent" qualifiers are not parsed; those cards stay partial.
- **Ready me:** new effect `READY_SELF`; "buff me" is still unmodelled (no Buff state).
- **Rule numbers:** tests cite 303 only; not checked against the rule text.

## R50: self cost reductions (A-R50)

- **Where it applies:** the card's printed Energy cost, before Accelerate / Repeat / additional costs are added (the existing order: increases first, then discounts, clamped at 0, Rule 356.6 in the existing tests). It stacks with the Legion discount; a "minimum of [N]" is measured against the cost after Legion.
- **"For each" counts (UNCLEAR, no rule text read):** only the player's own side, never the card itself. Gear = gear on the board; exhausted units, [Mighty] units (Might 5+, as in R47) on the board; cards in the Trash (any type); cards with the same name in the Trash; cards played this turn (the existing play record, Hidden plays included).
- **"If" conditions** reuse the R43 Condition language (a subtype you control, counts); evaluated when the card is listed as playable and again when it is played.
- **Not done:** "to play from anywhere other than your hand", Power reductions ([A] / [C]), "for each battlefield you conquered this turn" and "if an enemy unit died this turn" (no per-turn tracking), reductions of OTHER cards (Legends, battlefields, "your spells cost less"), "the next card you play costs less".
- **Rule numbers:** tests cite 356.6 only.

## R51: static abilities (A-R51)

- **Model:** `CardDef.statics` grants Might and / or keywords to SELF, friendly units, friendly gear, friendly units of a subtype, my other friendly units at my battlefield, or all units at the source's battlefield (Battlefield cards). A condition is evaluated live from the source's controller. Sources: permanents on the board, a Legend in its zone, Battlefield cards. Read by `effectiveMight` (Might), combat tiers, Ganking moves and Deflect.
- **Only Assault, Shield, Tank, Ganking and Deflect** are read at runtime from a grant (as with temporary grants). "Disarm" grants (Clanging Sentry) are not supported.
- **Granted Assault / Shield** count in combat like printed ones (role based), stacking with them.
- **"Other friendly units here"** needs the source to stand at a battlefield; a source in the Base grants nothing to units here.
- **Battlefield sources** use the target unit's controller for the condition (the Battlefield itself has no controller for it).
- **Not done:** "equal to the number of ..." values (Repair Specialist, Ancient Warmonger), "while I'm buffed / [Mighty]", "attacking or defending alone", spell keyword grants (Kai'Sa), "can't" restrictions, static cost changes of other cards.
- **Rule numbers:** tests cite 143.2, 809, 144.4.c.1 only; not checked against the rule text.
- **R50 correction:** `resources/card-schema.json` lacked `costReduction`, so the card build silently dropped those cards; fixed here (the R50 count of 282 only became true in `client/public/cards.json` with this change).

## R52: Empower (A-R52)

- **Model (UNCLEAR, reminder text only, no rule text read):** "[Empower] <cost>" is an activated ability "<cost>: Empower me. Use only if not Empowered." It goes on the Chain like any non-[Add] ability (so it needs a Neutral Open state on your turn, or a Reaction) and sets `CardInstance.empowered` when it resolves. Empowered is lost when the permanent leaves the board (returned to hand) and a permanent always enters un-Empowered. Disempowering ("Disempower me, [T]:", Legend Boy Who Shattered Time) is not modelled.
- **"[Empowered][>] ..."** is a static (or a trigger) that applies only while the source is Empowered: new condition `EMPOWERED`. Static / trigger lines other than "I have <keyword | +N [M]>" or "When I hold / conquer / ..." stay partial.
- **Costs:** Energy, [C] / [A] Power and "Discard N" costs parse (the existing ability cost parser). "This ability costs [N] less if / for each ..." modifiers are not parsed: those cards (Baccai Sandspinner, Frostcoat Mother, Grumpy Rockbear, ...) stay partial.
- **Keyword:** `Empower` is now a parsed keyword (no longer a blocker by itself); `Empowered` is not extracted as a keyword.
- **Rule numbers:** tests cite 145.1 only.

## R53: XP, Hunt and Level (A-R53)

- **XP (UNCLEAR, reminder text only, no rule text read):** each player has an XP counter (`PlayerState.xp`, absent = 0, public, never decreases yet). "Gain N XP" adds to the controller's counter; "for each friendly unit" counts the controller's units on the board.
- **Hunt N** = "When I conquer or hold, gain N XP" (the reminder text), as two triggers. Several instances sum.
- **Level N** lines ("[Level 3][>] I have +1 [M] and [Ganking].") are statics that apply while the controller has at least N XP (condition `XP`). Higher levels do not replace lower ones ("... instead" text is not parsed); a Level line with other content (cost reductions, "enter ready", draw triggers, "instead") keeps the card partial.
- **"When I move to a battlefield"** is the same MOVE trigger as "When I move" (the engine only fires it for moves to a battlefield, as in R43).
- **Not done:** spending XP ("Spend N XP: ..." costs, Legend abilities), "if you've gained XP this turn", "when it wins a combat, gain XP", Buff (no Buff state), Level effects on spells or on costs.
- **Rule numbers:** tests cite 303 and 143.2 only.

## R54: Buff (A-R54)

- **Model (from the printed reminder "give it a +1 [M] buff if it doesn't have one"):** a Buff is the flag `CardInstance.buffed`: +1 Might, at most one per unit, lost when the permanent returns to hand and cleared when a permanent enters play. It stays when the unit dies to the Trash but is cleared on its next play. "Spend my buff" is not modelled.
- **Parsed:** "[Buff] a [friendly|enemy] unit" / "Buff a unit" (target chosen like any unit spell), "[Buff] me" / "buff me", and the condition "I'm buffed" (statics and "if" clauses).
- **Not parsed (cards stay partial):** "buff all units here", "buff up to N units", "buff another friendly unit", "If it's already buffed ... instead", "Spend my buff ...", "when you buff ...", "any number of buffs" (Lee Sin), "buffed units have ...".
- **Rule numbers:** tests cite 143.2 only.

## R55: Predict and Vision (A-R55)

- **Rules (from the reminder text):** Predict N = look at the top N cards of your Main Deck, recycle any of them and put the rest back in any order (Predict 1: "you may recycle it"). Vision = "When you play me, look at the top card of your Main Deck. You may recycle it."
- **Deterministic policy (no choice UI yet, like LOOK_TOP):** a looked-at card stays on top, in its original order, when its printed Energy cost is at most (your channeled runes + 2); the others are recycled to the bottom. Players cannot choose; a Predict-heavy deck is slightly weaker or stronger than the real game depending on the heuristic. Hidden information is preserved: the opponent only sees CARDS_LOOKED_AT / CARDS_RECYCLED counts.
- **Not done:** the interactive choice (pick what to recycle and the order), "Predict equal to its Power cost" (The Empyrean, needs Show Off), "they [Predict]" for each player (Rakelstake), "When I become exhausted, [Predict]" (no exhausted trigger).
- **Rule numbers:** tests cite 359 only.
