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

## R56: "a unit died this turn" and reversed "If <cond>, ..." forms (A-R56)

- **Tracking:** `PlayerState.diedThisTurn {turn, count}` counts units (tokens included) that died under that player's control during the given turn: lethal damage in Cleanup and Temporary expiry. Gear deaths are not tracked, so "unit or gear died" (Lingering Animus) stays partial. It is recorded only when some card in the database uses the condition, so ordinary games (and the pinned replay hashes) are unchanged.
- **Conditions:** "a unit died this turn" (either side), "a friendly unit died this turn", "an enemy unit has died this turn". "During your Beginning Phase" qualifiers (Shadow Watcher) are not parsed.
- **Reversed forms:** "If <condition>, I enter ready." and "If <condition>, this costs [N] less." are read like their "... if ..." forms.
- **Rule numbers:** tests cite 323 only; none checked against rule text.

## R57: movement restrictions (A-R57)

- **"Can't move to base" (static):** `StaticAbility.restrict = 'NO_MOVE_TO_BASE'` on SELF ("I can't move to base"), ALL_UNITS ("Units can't move to base") or UNITS_HERE (a Battlefield: "Units can't move from here to base" = units standing at it). It removes the Base as a destination for a standard move; recall in Cleanup, combat retreats and effects ("Move a unit to base") are not blocked (UNCLEAR: the text says "move", and effects that move to Base are a different action in this engine).
- **"It can't move this turn":** new effect `LOCK_MOVE_TARGET` sets `CardInstance.cantMove`, which blocks every standard move of that unit until the Ending step. Entrenched Boar's "You may have me enter ready. If you do, I can't move this turn" is not parsed.
- **Rule numbers:** tests cite 144 only; not checked against the rule text.

## R58: optional additional cost to play ("You may pay [N] as an additional cost to play me") (A-R58)

- **Model (UNCLEAR, no rule text read):** the card stores `optionalAdditionalCost {energy, power?, anyPower?}`; a play with `additionalCosts.extra = true` pays it on top of the card's cost (Energy, [C] = Power of the card's Domain, [A] = any Power) and every legal-action list offers both variants when affordable. The chain item keeps `additionalCosts.extra`.
- **"If you paid the additional cost, <effects>"** in "When you play me" triggers is read from the CARD_PLAYED event (`paidExtra`, public like the payment itself) when the trigger fires; the intervening-if is not re-checked at resolution (the answer cannot change).
- **Only kept when used:** a card gets the optional cost only when its text also has an "if you paid the additional cost" clause; otherwise the line keeps the card partial (nothing to gain from paying).
- **Not done:** "if you paid the additional cost, deal 5 to it instead" (replacement effects of spells), "If you paid ... , they cost [1][A] more instead", conditional costs ("If you've played a spell this turn, you may pay ..." Crescent Guardian), required Energy/Power additional costs.
- **Rule numbers:** tests cite 356.2 only.

## R59: modal spells ("Choose one —") (A-R59)

- **Model:** `CardDef.modes` holds the effects of each mode; `PLAY_CARD.mode` picks one when the card is played (like a target), the chain item keeps it, and only that mode's effects run. Targets are enumerated and validated per mode. Legal actions list one play variant per mode (and per target / payment variant of that mode).
- **Scope:** spells whose text is "Choose one —" followed by lines "- <effects>" (each mode parses as a spell). Modal abilities and triggers ("When I become exhausted, choose one ..."), "choose one that hasn't been chosen this turn", "Choose one you haven't already chosen" and modes with unparsed effects keep the card partial.
- **Client:** each mode is another entry in the play chooser, labelled "Mode N" (the card text shows what each mode does); there is no dedicated mode picker yet.
- **Rule numbers:** tests cite 356 and 359 only.

## R60: Spend XP ability costs (A-R60)

- **Model (UNCLEAR, patch-note wording only):** "Spend N XP" is a cost part of an activated ability (`AbilityCost.xp`): the ability needs at least N XP, pays it on activation (`XP_SPENT`) and the effect resolves from the Chain. Level statics read the XP live, so spending XP can switch a Level effect off (matches the glossary: Level is a threshold, not a cost).
- **Verified against search-result summaries only (no rule text):** Empower stays until the permanent leaves play (R52), a Buff is +1 Might with at most one per unit (R54), Predict looks at the top cards, recycles any and returns the rest in any order (R55), Level is a threshold that turns off when XP drops below N (R53). The Core Rules PDF could not be read here (no page fetch tool), so rule numbers are still unchecked.
- **Not done:** optional "you may spend N XP to ..." triggers (Kha'Zix), "spend N XP as an additional cost to play me" (Poppy), Legend abilities (Voidreaver, Keeper of the Hammer), "spend a buff".
- **Rule numbers:** tests cite 145.1 only.

## R61: Flow (A-R61)

- **Rules (reminder text):** "[Flow] <cost>: You may play this from your trash for its Flow cost. Then banish it." A spell with a Flow cost may be played from its owner's Trash with `additionalCosts.flow`; the Flow cost replaces its printed cost (no other additional costs or discounts are combined with it); after it resolves it goes to the Banishment zone instead of the Trash. Timing and targets are those of the spell. Only spells with a plain `[Flow] [N][C][A]` cost line are parsed.
- **Not done:** Flow granted by other cards ("give a spell in your trash [Flow] equal to its cost", Kennen), Flow on units or gear, Flow with the Repeat or Accelerate extras, other play-from-Trash permissions ("you may play this from your trash for [1][C][C]").
- **Rule numbers:** tests cite 356 and 359.3 only.

## R62: return-self effect, battlefield-control and score conditions (A-R62)

- **"Return me / this to its owner's hand"** (`RETURN_SELF`): the source leaves the board to its owner's hand (tokens cease to exist; damage, buffs and other state reset as for any return). Nothing happens when the source already left the board.
- **Conditions:** "an opponent controls a battlefield" (enemy controls at least one) and "your / an opponent's score is [not] within 3 points of the Victory Score" (points >= victory score - 3). The 3 is the printed value; it is not derived from the Victory Score.
- **Not done:** conditions on other combat facts ("if you assigned N or more excess damage"), Blitzcrank's "move an enemy unit to here", Deploy.
- **Rule numbers:** tests cite 323 and 473 only.

## R63: optional additional costs with cards or XP (A-R63)

- **Extends R58:** `optionalAdditionalCost` may also carry a card choice (`card`: "You may discard 1 / kill a friendly unit or gear / return a friendly gear as an additional cost to play me"), an XP part (`xp`: "You may spend N XP ...") and `reduceEnergy` ("If you do, I cost [N] less"). The cards are chosen with the play (`PLAY_CARD.costCards`, validated before anything is paid, R46 / R47 rules); XP is spent (event `XP_SPENT`) when the card moves to the Chain; the reduction applies with the other discounts. Variants are offered only when the cost is payable.
- **Kept only when used:** the line is stored when the text has an "if you paid the additional cost" clause or an "If you do, I cost [N] less" on the same line; otherwise the card stays partial.
- **Not done:** Zed-style tokens ("if you paid, play a 0 [M] Shadow Clone"), "I cost [1] less for each Energy it costs" (Atakhan), "exhaust your legend" (Bard), Chronobreak's "pay any amount of Power", conditional optional costs (Crescent Guardian), Dragon Roost.
- **Rule numbers:** tests cite 356.2 only.

## R64: Shadow Clone token (A-R64)

- New token definition `tok-shadow-clone` (a 0 [M] Shadow Clone unit, no keywords), parsed by "play a 0 [M] Shadow Clone unit token". A Reflection token was NOT added: its printed text (a Temporary copy) is not understood.
- **Rule numbers:** test cites 186.1 only.

## R65: counted draws, mass return, "Ready a unit and give it ..." (A-R65)

- **Counted draws:** "draw N for each battlefield you [or allies] control" counts every battlefield the controller controls (the existing R44 form excludes the source's own); "draw N for each of your [Mighty] units" counts the controller's units with Might 5 or more (as in R47 / R50). "Or allies" has no effect in a 1v1 duel.
- **Mass return:** "Return all units and gear to their owners' hands" (Downwell) returns every unit, gear and token on the board of both players (tokens cease to exist); object order, no targets.
- **"Ready a unit and give it [Keyword] this turn"** is read as two sentences about the same chosen unit.
- **Rule numbers:** tests cite 359 and 323 only.

## R66: Empower leftovers (A-R66)

- **Kill-cost Empower:** "[Empower] — Kill a friendly unit" becomes the ability "Kill a friendly unit: Empower me" (any R46 card-choice cost after "[Empower]").
- **Empowered Deathknell:** "[Empowered][>][>>][Deathknell][>] <effect>" is a Deathknell that fires only if the unit was Empowered when it died (the flag stays on the object in the Trash until it is played again); the "[>>]" icon is ignored.
- **Not done:** Empower with alternatives ("[1] or [C]"), Empower cost modifiers, "Your units that are [Empowered] have ...", Empowered replacement effects (Gangplank).
- **Rule numbers:** test cites 145.1 only.

## R67: counted statics (A-R67)

- **Model:** `StaticAbility.per` multiplies `might` by a count taken from the source's point of view (other exhausted friendly units, other same-name units at my battlefield, friendly token units, friendly Temporary units at my battlefield, friendly gear, buffed friendly units at my battlefield, enemy units at my battlefield, your points); with `perKeyword` the count becomes the value of Assault / Shield ("I have [Assault] equal to the number of gear you control"; nothing is granted at 0). The source itself is never counted.
- **Gear count** includes gear-like tokens (Gold) and gear on the board only.
- **Not done:** "for each time I'm Empowered" (Kayle), conditional counts of "units and/or gear", "[Assault] equal to my [Shield]".
- **Rule numbers:** tests cite 143.2 only.

## R68: Legend activated abilities (A-R68)

- **Model:** a Legend sits in its zone and may use activated abilities from there (cost, timing, targets, Chain as for any permanent's ability); "[E]" exhausts the Legend object (it is ready at the start; "Ready your legend" and the Awaken step ready it). Legends may have YOU_PLAY triggers (R49) and abilities; other trigger kinds on Legends keep the card partial.
- **Not done:** Legend text of other shapes (excess damage, "become Mighty", "when you or an ally hold", Starry-Eyed Songstress' cost modifier, Hexplosives Expert's Bomb token), Legion-conditioned abilities.
- **Rule numbers:** tests cite 145.1 only.

## R69: "Equip [N]" without keyword brackets (A-R69)

- Some printings write the Equip keyword as plain text ("Equip [1] ([1]: Attach this to a unit you control.)"). A line starting with "Equip [" is read as "[Equip] [" so the structured Equip cost (Rule 818) is parsed. No engine change.

## R70: filtered "here" statics (A-R70)

- `StaticAbility.onlyKeyword` / `onlySubtype` restrict a static to units with that printed keyword or subtype: "Units here with [Tank] have +1 [M]", "Units here with [Temporary] have [Shield]", "Champion units here have +1 [M]". Only the printed keyword list is consulted (not temporary or granted keywords). "Champion" is the unit's subtype list entry.
- **Not done:** "Units here with [Temporary]" using granted Temporary, defending-alone statics, "units here" conditions on battlefield control.
- **Rule numbers:** test cites 143.2 only.

## R71: Combat and death triggers: win a combat, combat ends, unit dies, died alone, once each turn, gear "play this" (A-R71)

- **Died alone:** no other friendly unit stood at the dying unit's location (Base or battlefield) when the batch of deaths began; units dying at the same time count as company. UNCLEAR: the exact definition of "alone" for Deathknell.
- **Win a combat:** the side that has units left when the combat resolves (468.3). A tie or a wipe-out has no winner. The units that count are the winner's survivors standing at the battlefield at that moment (attackers are recalled afterwards).
- **Batch deaths:** "one or more units die" triggers once per Cleanup batch.
- **Once each turn:** counted when the ability goes on the Chain.
- **Rule numbers:** tests cite 303, 323.4 and 468.

## R72: Turn triggers: start of Beginning Phase and end of turn, rune effects, rune and facedown conditions (A-R72)

- **Inline resolution:** the whole start-of-turn sequence runs inside one reduce call, so these abilities do not use the Chain and cannot be responded to. UNCLEAR: the real rules put them on the Chain.
- **Order:** start-of-Beginning abilities run before the Temporary kills; end-of-turn abilities run in the Ending step before damage is removed.
- **Recycle from Trash:** the oldest cards in the Trash are recycled (the real text lets the player choose).
- **Ready runes:** the lowest-numbered exhausted runes are readied.
- **Rune comparison:** counts runes in play (not the Rune Deck).
- **Rule numbers:** tests cite 315.2, 317.1, 317.2, 160, 323.4 and 431.

## R73: Level-gated abilities, conditional discounts and enters-ready conditions (A-R73)

- **Played to a battlefield:** a unit, gear or token the controller played this turn that now stands at a battlefield (a unit moved there after being played also counts).
- **Level:** the gate is checked when the ability triggers (and the unit enters), using the controller's current XP.
- **Rule numbers:** tests cite 359.2 only.

## R74: Restrictions: no combat damage, can't be chosen by enemies, only-at-battlefield abilities, damage equal to my Might (A-R74)

- **No combat damage:** the unit's Might is left out of the side's damage total (like a Stunned unit); it still takes damage and can still be assigned damage.
- **Less Might than me:** compares printed Might plus Might bonuses of both units (no static or role bonuses, to avoid circular reads).
- **Can't be chosen:** applies when the chooser (the player casting or activating) is not the unit's controller; abilities and spells of the controller can still choose it. Hidden-information plays are unaffected.
- **Damage equal to my Might:** read when the effect resolves (0 if the source left the board); [Assault] / [Shield] sum the values of the source's current keywords including granted ones.
- **Rule numbers:** tests cite 143.2, 145.1, 355.10, 462 and 467.2.

## R75: Return from Trash to hand, buff up to N units, ready enemies, ready a legend (A-R75)

- **Trash choices:** the returned card is chosen when the ability goes on the Chain (like any target, R41); with exactly one legal card it is taken automatically.
- **Only your own Trash:** "your trash" means the controller's.
- **Tokens** never reach the Trash, so they cannot be returned.
- **"Up to N other":** the source itself is excluded; the choice may be empty.
- **Rule numbers:** tests cite 160 and 303.

## R76: "You may play me to an open / occupied enemy battlefield" (A-R76)

- **Open battlefield:** a battlefield with no units of either player on it, whoever controls it.
- **Occupied enemy battlefield:** an opponent controls it and has at least one unit there.
- **Control after playing:** playing to a battlefield nobody else occupies contests it; the Showdown that follows lets the player establish control and Conquer (once per turn per battlefield). UNCLEAR: the real rules may establish control without a Showdown.
- **Rule numbers:** tests cite 359.2.

## R77: Mandatory discards: "Discard N, then ..." triggers and Deathknells (A-R77)

- **Discard choice:** the controller chooses which cards to discard from their hand (hidden until discarded; the Trash is public).
- **Short hands:** discarding more cards than you hold discards the whole hand.
- **Timeout:** when the choice times out the lowest-numbered cards are discarded.
- **Rule numbers:** tests cite 340.1.

## R78: "When I become exhausted / ready / Empowered" triggers (A-R78)

- **Net change only:** a permanent that is exhausted and readied again inside one intent shows no change.
- **Awaken:** the Awaken step readies the turn player's permanents, so "When I become ready" triggers at the start of every turn for exhausted ones.
- **Timing:** the triggers go on the Chain after the intent that caused the change finishes, like other triggers.
- **Rule numbers:** tests cite 303 and 315.1.

## R79: "Move an enemy unit to that battlefield / here" effect moves (A-R79)

- **Effect move:** it ignores "can't move" locks and does not exhaust the unit; a moved enemy unit does not contest the battlefield, but the Cleanup stages a Combat when both players have units there.
- **Who attacks:** the Combat is staged by the existing Cleanup rule (323.8), not by who moved the unit.
- **Rule numbers:** tests cite 355.10 and 462.

## R80: Counters limited by the countered spell's cost (Hush, Defy) (A-R80)

- **Printed cost:** the limits compare the countered spell's printed Energy and Power costs (not what was actually paid after reductions or surcharges).
- **Rule numbers:** tests cite 359.3.

## R81: "... instead" alternatives on targeted Might and damage effects (A-R81)

- **Attacking:** a unit at the combat battlefield whose controller is the combat's attacker.
- **Level:** the XP check is made when the effect resolves.
- **Rule numbers:** tests cite 359.3 and 466.2.c.

## R82: Return several units: all small units, one friendly and one enemy (A-R82)

- **Both choices required:** with no legal enemy unit the spell cannot be played and the trigger is skipped; the real text may return the friendly unit alone (UNCLEAR).
- **Rule numbers:** tests cite 160.

## R83: Play locks and capped group debuffs (A-R83)

- **Lock scope:** applies to the rest of the turn in which it was set; a Cards lock is never weakened by a later Spells lock. Hidden plays go through the same timing check.
- **Minimum:** each unit loses min(N, Might - minimum), never below the minimum.
- **Rule numbers:** tests cite 143.2, 354 and 359.3.

## R84: Modal spells with Repeat, damage to a unit in a Base (A-R84)

- **Repeat with modes:** the repeat uses the same mode and targets (the real text lets the player choose differently, UNCLEAR; same reading as R42).
- **Rule numbers:** tests cite 355.10 and 820.

## R85: Deploy gear: played to a battlefield, stays there, "here" triggers and statics (A-R85)

- **Deploy gear exposure:** the client shows it among the units at the battlefield (all non-hidden objects there are listed); it has no combat Might.
- **Opponent holds:** the gear dies when the opponent scores a Hold at its battlefield; a Conquer by the opponent does not kill it by itself.
- **Rule numbers:** tests cite 303, 323.6, 359.2, 468.3 and 473.

## R86: Damage to all enemy units here, "... here" Might statics (A-R86)

- **Here:** the battlefield the source stands at when the effect resolves; the effect fizzles if it is in a Base.
- **Rule numbers:** tests cite 143.2 and 466.2.c.

## R87: Excess combat damage conditions and "deal that much" (A-R87)

- **Excess:** per enemy unit, assigned damage minus max(1, its current Might) plus the damage already on it (never below 0), summed.
- **Scope:** only the attacker's assignment counts; the record lasts for the rest of the turn.
- **"After an attack":** a Conquer without combat has no excess, so the condition fails by itself.
- **Rule numbers:** tests cite 467.2.

## R88: "The first time ... each turn", token statics, units entering ready (A-R88)

- **"First time":** the first occurrence per turn is the same as "once each turn" (counted when the ability goes on the Chain).
- **Enter ready:** checked when the unit enters; a static source that is itself entering is not counted for itself ("Other").
- **Rule numbers:** tests cite 186, 303 and 359.2.

## R89: Smoke test for every supported card (no new card support) (A-R89)

- **Coverage:** a game plays only the cards that are drawn and affordable, so each run covers a subset; vary `--seed`.
- **Rule numbers:** none (tooling).

## R90: Return a unit, its owner channels a rune; final audit (A-R90)

- **Owner:** the player who owns the returned unit channels, even if the caster controlled it.
- **Rule numbers:** tests cite 355.10 and 431.

## R91: Ability cost reductions, highest-Might spell discount, Might per Trash card (A-R91)

- **Ability discount:** never below 0 Energy; Power parts are not reduced.
- **Highest Might:** current Might (with bonuses) of the controller's units on the board, 1 Energy per point.
- **Rule numbers:** tests cite 143.2, 145.1 and 156.

## R92: Tentacle tokens, "when I score", "when an opponent scores" (A-R92)

- **"When I score":** read as scoring by Hold or Conquer only (UNCLEAR for other point sources).
- **"When an opponent scores":** any point the opponent gains, including Burn Out points.
- **Rule numbers:** tests cite 186 and 473.

## R93: Board-counted gives, buff all units here (A-R93)

- **Here-scope:** does nothing when the source is in a Base (equal to the printed "if I am at a battlefield").
- **Exhausted count:** the controller's exhausted units on the board.
- **Rule numbers:** tests cite 143.2.

## R94: One-way damage equal to the chosen unit's Might (A-R94)

- **Dealer:** the first chosen unit's current Might when the spell resolves (0 if it left the board).
- **Rule numbers:** tests cite 143.2 and 355.10.

## R95: Combat-role statics and "Stun an attacking unit" (A-R95)

- **Alone:** no other friendly unit at the combat's battlefield.
- **Scope:** only the source's own role (statics for "a friendly unit that defends alone" are not read).
- **Rule numbers:** tests cite 355.10 and 466.2.c.

## R96: Look at the top cards with type and cost limits, rest to the Trash (A-R96)

- **Choice:** still deterministic: the first matching card from the top; an unrestricted take picks the most expensive card (UNCLEAR: the real text lets the player choose).
- **Power limit:** "no more than [A]" is read as at most 1 generic Power on the printed cost.
- **Rule numbers:** tests cite 159.

## R97: Opponent-directed effects and "base Might becomes N" (A-R97)

- **Base Might:** applied as a this-turn modifier of (N - printed Might); permanent buffs and equipment still add.
- **Choose an opponent:** always the other player.
- **Rule numbers:** tests cite 143.2, 160 and 186.

## R98: Give a permanent [Temporary], double a unit's Might (A-R98)

- **Temporary:** the keyword is stored on the instance, not the card; "without [Temporary]" restrictions are ignored (granting twice changes nothing).
- **Double Might:** adds the unit's current Might as a this-turn bonus.
- **Rule numbers:** tests cite 816.

## R99: Play triggers for token units, Power cost thresholds and the Nth card (A-R99)

- **Token units:** only effect-played tokens trigger "a token unit" heads; "a unit" heads still mean cards.
- **Nth card:** counted from the cards the player played this turn (Hidden plays included).
- **Rule numbers:** tests cite 303.

## R100: Hide / play-from-face-down triggers (and a fix: hiding is not playing) (A-R100)

- **Hide vs play:** a hidden card is placed, not played; it triggers "When you hide" only.
- **Rule numbers:** tests cite 811.

## R101: Legend triggers: win a combat, hold, conquer (A-R101)

- **Legend scope:** the Legend triggers for its controller's holds, conquers and combat wins (not an ally's).
- **Rule numbers:** tests cite 303, 468.3 and 473.

## R102: Compound self clauses joined by "and" (A-R102)

- **Order:** effects run left to right.
- **Safety:** only used when no specific pattern matches, so existing parses are unchanged (regression diff: 0 changed).
- **Rule numbers:** tests cite 359.3.

## R103: Keywords printed as plain words (A-R103)

- **Scope:** only at the start of a line and only before a parenthesised reminder.
- **Rule numbers:** the script test cites 799.

## R104: Cost modifiers for the cards you play (statics) (A-R104)

- **Energy only:** Power reductions ("[1][A] less") are not modelled.
- **Stacking:** several modifiers apply one after another, each bounded by its own minimum.
- **Rule numbers:** tests cite 156.

## R105: Turn-wide enter-ready and one-shot spell discount (A-R105)

- **Tokens:** played tokens also enter ready under the turn-wide effect.
- **Discount use:** any spell play consumes it, even one that would have cost less.
- **Rule numbers:** tests cite 156 and 359.2.

## R106: Subtype-limited targets (a Mech, a non-Dragon unit) (A-R106)

- **Subtype match:** against the card's subtype / tag list, case-insensitive.
- **Rule numbers:** tests cite 355.10.

## R107: Might-based limits: gear cost vs my Might, total Might of other units (A-R107)

- **No source:** a spell has no source unit, so the Might limit is 0 for it (nothing legal).
- **Rule numbers:** tests cite 143.2 and 355.10.

## R108: Move-from and gear-ability triggers (A-R108)

- **Move from:** fires only for battlefield-to-battlefield moves; moves to the Base are not reported because recalls share the event (same UNCLEAR as R43).
- **Rule numbers:** tests cite 145.1 and 303.

## R109: Audit after R91 to R108 (no new cards) (A-R109)

- **Not covered:** the two-browser multiplayer and reconnect specs were not run in this session.

## R110: "A card from [Hidden]" means played from face down (A-R110)

- **Rule numbers:** the script test cites 811.

## X1 / X5: split damage, discount order, play from Trash ignoring cost (UNCLEAR readings)

- **Split damage (559.3.d):** the player chooses the targets when the spell is played or the ability is put on the Chain; the engine splits on resolution in the order the targets were chosen: 1 each, then lethal-first, overflow on the last target. The rules let the controller choose any valid split, so this is a simplification; picking the targets in a different order is the player's lever. With fewer damage than targets, the later picks stop being targets (559.3.d.8).
- **Discount order (560.4):** discounts may be applied in any order and a minimum belongs to its own discount. The engine always takes the order that gives the lowest cost (Energy only; Power discounts are not modelled). More than six simultaneous discounts use a greedy order (discounts with a minimum first).
- **Play from the Trash, ignoring its cost (560.1.a, 595.3):** the unit is played to its owner's Base (choosing a battlefield is not modelled), enters exhausted unless an enter-ready effect applies, fires CARD_PLAYED (its own "When you play me" and other players' "When you play a card" triggers) and counts as a card played this turn for Legion. It does not use the Chain and cannot be responded to separately from the effect that played it. The "[A]" in "no more than [A]" is read as at most 1 Power.

## X8 / X9: Burn Out on look and mill, stun / discard / Mighty triggers (UNCLEAR readings)

- **Burn Out (607.1.b-c):** looking at the top cards (Look-at-top, Predict, Vision) or milling (Burn) while the Main Deck is empty burns out once first (Trash shuffled in, the opponent gains 1 point) and then the action runs on the new deck. A deck with fewer cards than asked for does not burn out for these actions (only draws do, 591.4). The `[Burn N]` cost is not payable with a short deck instead of burning out. Reveal effects are not implemented.
- **Stun triggers:** "When you stun an enemy unit" fires when an effect controlled by you newly stuns an enemy unit; "one or more" is read as once per stun effect target, so a mass stun fires it once per unit (UNCLEAR). Stunning an already-stunned unit does nothing and fires nothing.
- **Discard triggers:** discards only happen as card-choice costs and mandatory discards (COST_CARDS_PAID, kind DISCARD); "When you discard one or more cards" fires once per such payment for the discarding player's permanents and Legend. "When you discard me" (a card in the Trash) is not implemented.
- **Becomes Mighty (709):** compared per reduced step: a unit on the board with Might below 5 before and 5 or more after fires once for the controller's permanents; a unit entering the board already Mighty does not (its inherent Might counted in the hand, 711), and a unit that goes below 5 and back up inside one step does not fire.


## X2 / X7

- X2 (637.1.a.1, 639.1): "base Might becomes N" is stored as the unit's base (`baseMightSet`); the newest assignment wins and +/- effects apply on top in any order. No general layer engine: no other card has dependent trait or ability altering effects.
- X7 (575): when a unit has both a Recall and a Banish replacement for the same death, the engine applies Recall (the owner would choose to keep the unit). Recall is not a move (no move triggers); a recalled unit that was in combat leaves it. A replaced death is not a death: no Deathknell or "when a unit dies" trigger fires, and it does not count for "a unit died this turn".
- X7 standing replacements: a one-shot marker (Highlander) is used before a standing one (Zhonya's, Soraka); with several standing sources the first on the board in object order applies. A Hidden gear counts only while it is on the board (a face-down card is not). Zhonya's kills the gear even if the saved unit then lives only because of it.
- X7 damage: prevention is applied before doubling (the unit's owner orders them, 575). Combat damage dealt to one unit in the same damage step is one instance, so "prevent the next damage" stops all of it; Ki Barrier still lets an assigner count the unit's full lethal damage (assignment is unchanged). Kill effects set lethal damage but are not damage and ignore prevention. "Prevent ... spell and ability damage" counts any source that is not combat, including your own.
- X7 optional replacements: the unit's CONTROLLER is asked (575 says the owner of the object acted on; Altar of Blood says "its controller"; for a unit they are the same except for stolen units). Only payable offers are made, so a player with no resources is never asked. One question per unit and one unit at a time; declining any offer lets the unit die this turn (no second chance from another source). "Once each turn" is tracked per source (`deathUsedTurn`). Mordekaiser may kill only ANOTHER friendly unit (killing himself would not save him). Altar of Blood applies only while a combat is in progress at that battlefield.
- X3: an object keeps its id when it changes zones, so "same object" is tracked as a generation that only counts for objects a Chain item targets. A target is invalidated by leaving or entering the Board (not by moving between Base and a battlefield). Abilities that choose targets as they are put on the Chain record them at that moment. Resolution still re-checks the targeting requirements (563.2.c.3).
- X6: triggers are first placed on the Chain in the old default order (turn player's first), then the controller may reorder their own simultaneous different triggers before anyone gets Priority or chooses targets. Triggers from different players are not interleaved (583.3.b.1: each player orders their own, turn player first). The order choice is a permutation of at most the triggers fired by one event batch.

## X-loc: choosing battlefields and locations (A-X-loc)

- **Targets:** a chosen battlefield is a Target of kind `battlefield`; a moved unit's Base is written as the battlefield id `base` (the Base of the unit's controller). Slots stay positional: the unit first, then where it goes.
- **Effect moves:** the controller of the spell or ability chooses the destination (rule 596 only says units move "when instructed"). A unit cannot be moved to the location it is already at, and a unit in a Base cannot be moved to a Base. An effect move does not exhaust the unit; a unit arriving at a battlefield its controller does not control contests it (190.3).
- **"Unforgiven":** "to or from its base" lets a unit in a Base go to any battlefield and a unit at a battlefield go to its Base.
- **Siphon Power:** the debuff stops at the stated minimum Might; units that arrive at the battlefield later this turn are not affected (the effect is applied once, on resolution).

## X-bomb: Bomb tokens (A-X-bomb)

- **Where:** the controller chooses the battlefield when the ability goes on the Chain; several Bombs from one effect all go to that one battlefield.
- **Death ability:** it is a trigger of the dead token, resolved from its last known battlefield (`GameState.lki`); "an enemy there" is an up-to-one target, so with no enemy there the Bombs are still killed. Only the Bomb's controller's other Bombs there are killed.
