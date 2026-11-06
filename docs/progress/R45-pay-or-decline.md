# R45: optional "you may [pay COST to] ..." abilities

Status: done (engine, parser, converter, bot, client, host timers, e2e). Fully supported cards 235 -> 249 of 1103 (`npm run cards` reports 255 because it counts 6 token defs; was 241). Engine 668 tests (+21), client 404 (+9), scripts 27 (+1); typecheck, lint, check:rules green; `reducePurity` golden hashes unchanged; `profile-ai` bot-vs-bot (real decks) completes; Playwright smoke + solo + abilities 8/8 on a temporary port-5199 config (deleted, no port 5173, no peer server).

## Measurement (before coding)

Scratch scripts outside the repo (`may45.ts`, `measure.ts`, `grep45.ts` in the session scratchpad) ran `convertRow` over the deduped `data/raw/cards.json` (868 partial cards at HEAD `d663235`). Partial cards whose text contains "you may": 264 (3 Battlefield, 12 Gear, 9 Legend, 47 Spell, 72 Unit without a single blocker; 16 / 8 / 8 / 8 / 81 where that sentence is the single blocker). By shape of the "you may" sentence:

| Shape                                                                                                       | Cards (examples)                                                                                                         | Done |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---- |
| `pay [1] / [C] / [A][A][A][A]` to <existing effect> on an existing trigger moment                           | Baccai Reaper, Icevale Archer, Sinister Poro, Protective Sands, Power Nexus, Treasure Hoard, Hall of Legends             | yes  |
| `[Burn 1]` as the cost                                                                                      | Shadow Order Disciple                                                                                                    | yes  |
| free "you may <non-targeted effect>"                                                                        | Startipped Peak (channel)                                                                                                | yes  |
| optional **targeted** effect on a known moment (R42 shape) that failed on the filler                        | Amateur Recital ("a unit at a battlefield"), Stoic Ferryman ("another unit you control here", "played to a battlefield") | yes  |
| discard / kill / exhaust / "spend a buff" / return as the cost                                              | Ruined Monastery, Mordekaiser, Emperor's Dais, Monastery of Hirana, Gear "exhaust this to draw 1" (8 gear)               | no   |
| the trigger moment does not exist ("when you play a card", "a unit dies", "become exhausted", "discard me") | Battlefield Armorer, Mask Mother, Fiora, Jayce, Seraphine, Chemtech Cask, Spirit Wheel, ...                              | no   |
| "if you do" chains, Predict ("you may recycle it"), play-from-trash, "unit or gear" targets                 | Jayce, Adaptatron, Mournful Spirit, Guardian of the Passage, Soulgorger, Consult the Heavens, Eclipse                    | no   |

The 13 optional/paid Battlefield cards R44 counted: 5 unlocked here (Hall of Legends, Power Nexus, Protective Sands, Startipped Peak, Treasure Hoard); the other 8 need discard / spend-a-buff / return costs, Sunken Temple's "Mighty" condition, Emperor's Dais' composite cost, Hallowed Tomb's champion zone or Firelights' Hideout (Accelerate grant).

Newly full cards (14): Baccai Reaper, Hall of Legends, Icevale Archer, Power Nexus, Protective Sands, Shadow Order Disciple, Sinister Poro, Startipped Peak, Treasure Hoard (pay / free "you may"); Amateur Recital, Stoic Ferryman (optional targeted, parser fillers); Mischievous Marai, The Syren, Teemo ("give me +3 [M]" / "unit at a battlefield" / "played to a battlefield" fillers).

## Design

The optional answer is a **second pending choice**, asked when the ability resolves; targets keep their R41 flow.

- **Card data** `CardTrigger.optional?: OptionalCost` (`{energy?, power?, anyPower?, burn?}`; `{}` = a free "you may"). `effects` are the effects after "to". `power` is [C] (Power of the source card's Domain, universal for a card without one), `anyPower` is [A].
- **Suspension** (`play.ts` `runTrigger`, called by the unit and battlefield trigger branches of `playResolver`): when an optional trigger resolves and `item.optionalDecision` is unset, the resolver puts a copy of the item back on top of the Chain and sets `flow.pendingChoice = {kind: 'OPTIONAL_EFFECT', player, chainItemId, cost}`. `resolveTop` (now exported from `chain.ts`) does not emit `CHAIN_ITEM_RESOLVED` while it is suspended. If the cost cannot be paid at that moment the ability is declined without a prompt (`OPTIONAL_EFFECT_DECIDED accepted: false`).
- **Blocking**: like `TRIGGER_TARGET`, every intent except the answer and `CONCEDE` is rejected (`WRONG_PHASE`), `actorToAct` returns the controller, the Cleanup keeps the choice (`cleanup.ts`), `askNextTrigger` never overwrites it.
- **Intent** `DECIDE_OPTIONAL {chainItemId, accept, payment?}` (`optional.ts` `decideOptional`): validates player and item; on accept it checks [Burn N] against the deck size, builds the Energy/Power `TotalCost`, uses `payment` or `autoPlan`, pays with **`payCost`** (the machinery PLAY_CARD, abilities and Weaponmaster use), mills the Burn cards, sets `optionalDecision = 'ACCEPT'`; on decline sets `'DECLINE'`. Then `resolveTop` runs the same resolver again, which emits `OPTIONAL_EFFECT_DECIDED` and runs (or skips) the effects. The reducer then continues like after a PASS_PRIORITY (`showdownAfterPass` inside a Showdown). Payment errors (`INVALID_PAYMENT`, `INSUFFICIENT_RESOURCES`) leave the state untouched and the choice pending.
- **Payment plan**: chosen by the player when `payment` is sent (any rune plan `payCost` accepts), else the engine's `autoPlan`. `getLegalActions` spells the automatic plan out in the accept intent (omitted when the Rune Pool already pays). The client offers the automatic plan only (while the choice is pending the player cannot activate runes by hand).
- **legalActions**: `[decline, accept?]` for the controller, `[]` for the opponent. **Decline is listed first** so every "take the first legal action" fallback declines (host bot fallback `applyBotFallback`, tutorial autopilot, mock game fallback); `hostTimers` additionally looks for the decline explicitly.
- **Effects added** (needed by the cards): `BUFF_SELF` ("give me +N [M] this turn"), `READY_LEGEND`. "Score N point(s)" now also parses as a bare imperative.
- **Parser** (`cardText.ts`): `splitOptional` for trigger bodies that `parseEffectSentences` cannot take as they are: `you may pay [1][C][A] to ...`, `you may [Burn N] to ...`, free `you may ...`; conditions (`if ... , you may ...`) go through the existing `splitCondition`; all-or-nothing as before (costs like `[E]`, "discard", "and" chains refuse the card). Fillers: "a/another unit you control (here)" = friendly, "move a unit at a battlefield to its base / your base", head "When you play me to a battlefield" (PLAY + `AT_BATTLEFIELD`).
- **Converter / schema**: nothing changed; `triggers` is an open object in the card schema and `convertRow` already stores whatever the parser returns (a script test checks the stored shape and schema validity).
- **Bot**: no engine-side bot code. The pending choice is in `getLegalActions`, `AIController` scores accept vs decline like any action (tested).
- **Hidden information**: the choice and its cost are public data copied from the card; accepting reveals nothing the Chain does not already show. The sanitize test checks that the opponent's view equals the real choice and leaks no hand card.
- **Client**: `OptionalPrompt` (modal like `ChoicePrompt`) shows the card name and text, "Cost: Pay 1 Energy" / "Burn 1 card ..." / "No cost.", the automatic payment ("Payment exhausts 1 rune.") and two buttons ("Pay and do it" / "Yes, do it", "Decline (do nothing)"); the opponent sees "Your opponent is deciding whether to use X." `describeEvent` words `OPTIONAL_EFFECT_DECIDED` (exhaustive switch + test). Protocol (`INTENT_TYPES` is exhaustive by construction) and the replay-log allow-list accept `DECIDE_OPTIONAL`; a loopback test drives it from the guest seat. **Host timeout declines** (never pays for a player).
- **Dev/e2e**: `?mock&optional=1` puts a Cinder Grunt with "When you play me, you may pay [1] to draw 1" in the human's hand plus two extra ready runes; `e2e/abilities.spec.ts` plays it, passes, and accepts / declines.

## Golden hashes

`reducePurity.test.ts` golden hashes did not change: no fixture card has `optional`, and `optionalDecision` / `OPTIONAL_EFFECT` only appear for optional triggers.

## Rules and UNCLEAR items

Tests cite 357.1.a (paying a cost), 355.10 (targets), 340.1 (the newest item resolves), 466.2.c, 473.2, 106, 649. UNCLEAR (docs/ASSUMPTIONS.md "R45"): that the decision happens at resolution rather than when the ability is put on the Chain, the silent decline of an unaffordable cost, [Burn N] needing N cards as a cost, the `AT_BATTLEFIELD` reading of "played to a battlefield".

## Not done (counts from the measurement)

- Costs that need a choice of card (discard, kill, exhaust, return, "spend a buff"): about 25 cards (Ruined Monastery, Mordekaiser, Mask Mother, Emperor's Dais, Monastery of Hirana, ...). They need card ids in `DECIDE_OPTIONAL` (hand choice) and a prompt for it.
- "If you do" chains and results that later sentences refer to (Jayce, Adaptatron, Guards!), Predict, play-from-trash.
- "Unit or gear" targets (Mournful Spirit, Mordekaiser): needs a combined target kind and a kill op that handles both.
- Other cheap leftovers measured but left: "this combat" grants (2 battlefields), delayed ready ("at the end of this turn"), Buff (+1 buff state, ~12 cards), reveal/look shapes (each unique), discard N effects (Jinx, Chemtech Enforcer: need a hand choice), "When you play a card/spell" triggers (Diana, Ravenbloom Student, 2 each), new trigger moments.

## Risks

1. **Resolution-time prompt vs rules**: if the real rules ask when the ability is put on the Chain, only `runTrigger`/`triggers.ts` change.
2. **Suspended item is a copy** on the Chain: code that holds a reference to the popped item across `resolveTop` would see the old one (none does).
3. **Auto plan only in the UI**: a player cannot pick which runes pay; the engine and wire already accept any plan.
4. **Old guests**: a guest on a build without `DECIDE_OPTIONAL` rejects a legal-hint list containing it (`INTENT_TYPES`); host and guest should be updated together.
5. **Unaffordable = silent decline**: the player is not told why an optional effect did not offer itself except in the event log.
