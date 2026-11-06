# R46: card-choice costs (discard, kill, exhaust, return, recycle)

Status: done (engine, parser, converter, schema, bot, client, e2e). Fully supported cards 249 -> 257 of 1103 (`npm run cards` reports 263 because it counts 6 token defs; was 255). Engine 695 tests (+27), client 415 (+11), scripts 28 (+1); typecheck, lint, check:rules green; `reducePurity` golden hashes unchanged; `profile-ai` bot-vs-bot completes; Playwright smoke + solo + abilities 10/10 on a temporary port-5199 config (deleted, no port 5173, no peer server).

## Measurement (before coding)

Scratch scripts outside the repo (`m46.ts`, `count46.ts`, `measure.ts` in the session scratchpad) ran `convertRow` over the deduped `data/raw/cards.json` at HEAD `ba46b32` (854 partial cards) and listed the sentences whose removal makes a card full ("single blockers") that contain a discard / kill / exhaust / return / recycle cost:

| Shape                                                                                                 | Cards                                                                                                | Done                                       |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| optional trigger "you may discard 1 [and / to] ..."                                                   | Ruined Monastery, Mordekaiser (with "kill a unit or gear")                                           | yes                                        |
| optional trigger "you may pay [1] and return a unit you control here ... to ..."                      | Emperor's Dais                                                                                       | yes                                        |
| activated "Discard a gear, [1], [E]: ..."                                                             | Sky Cruiser                                                                                          | yes                                        |
| activated "Recycle N from your trash, ...: ..." (and `[1][C]` power in ability costs)                 | Vi, Garbage Grabber, Assembly Rig, Whirling Twirligig (kill a friendly gear / unit)                  | yes                                        |
| "As an additional cost to play this/me, exhaust / return a friendly unit"                             | Ki Burst, Life from Stone, Parallel Convergence, Ekko, Legion Quartermaster, Cruel Patron, Sacrifice | no (needs `PLAY_CARD.costCards`, see gaps) |
| "spend a buff" (needs the Buff state)                                                                 | Wildclaw Shaman, Monastery of Hirana                                                                 | no                                         |
| trigger moment that does not exist ("at the start of ...", "when you discard me", "when a unit dies") | Dusk Rose Lab, Bottled Constellation, Mask Mother, Flame Chompers, Solari Shrine                     | no                                         |
| "kill me" (self sacrifice), Deathknell with "here", Action-speed ability text                         | Overzealous Fan, Mournful Spirit, Malzahar, Ekko (ability)                                           | no                                         |

New full cards (8): Ruined Monastery, Emperor's Dais, Mordekaiser (the one with the play / attack trigger), Sky Cruiser, Vi (the "Recycle 1" one), Garbage Grabber, Assembly Rig, Whirling Twirligig. Cards the cost parser also touches but other blockers keep partial: Detonation Amplifier, Ziggs, Jayce, Adaptatron, Deceiver, Pickpocket, Zed, ...

The R45 "gaps" leftovers that were cheap enough: "unit or gear" targets (`KILL_TARGET.orGear`, used by Mordekaiser) and "When you play me or when I attack" heads. "If you do" chains, Predict and the discard-N effect (Jinx, Chemtech Enforcer) were measured at 1-2 cards each and left.

## Design

- **Data** (`types/card.ts`): `CostCardChoice {kind: DISCARD | KILL | EXHAUST | RETURN | RECYCLE, count?, what?: unit | gear | unitOrGear | spell, here?, another?}`; `OptionalCost.card` and `AbilityCost.card` (plus `AbilityCost.power` / `anyPower` for `[1][C], ...:`). One card component per cost.
- **Engine module** `costCards.ts`: `costCardCandidates` (the one qualifying rule, also exported to the client), `costCardsPayable`, `costCardCombos` (choices of `count` cards, capped at `MAX_TARGET_COMBOS`), `costCardsLegal` (exactly `count` distinct qualifying cards) and `payCostCards` (mutates the working copy, emits `COST_CARDS_PAID {player, sourceId, kind, cardIds, cardNames}`). Kill = lethal damage (Cleanup trashes, Deathknell fires) or `killGear`; Return = `returnToHand`; Exhaust needs a ready unit; Discard hand -> Trash; Recycle Trash -> bottom of the Main Deck.
- **Optional triggers** (`optional.ts`): `optionalPlan` takes the source id and returns null (auto-decline) when the card cost has too few candidates. `decideOptional` validates `costCards` first (`MISSING_TARGET` when absent, `ILLEGAL_TARGET` when wrong, nothing paid), then pays rune cost, cards, Burn, and resolves. `getLegalActions` lists Decline first, then one accept per card combination (capped), each with the automatic payment plan. A timeout, the host bot fallback, the tutorial autopilot and the mock fallback therefore still decline.
- **Activated abilities** (`abilities.ts`): `ACTIVATE_ABILITY.costCards` is validated before the cost is paid; `[C]` / `[A]` in the cost go through `payCost`; `abilityCandidates` emits one candidate per cost-card combination x target combination; no candidate means not offered.
- **Reducer**: `costCards` must be a list of at most 16 ids (`UNKNOWN_INTENT` otherwise). Protocol, replay allow-list and hostTimers needed no change (both intents were already allowed; the timeout looks for the decline explicitly).
- **Hidden information**: the pending choice only carries the public cost. Candidates are enumerated for the payer alone (`getLegalActions` gives the opponent `[]`). A discarded card is public in the Trash from then on; the event names it only after it left the hand. Test: the opponent's view contains no hand id before or after (except the discarded one, now in the Trash) and the drawn card stays redacted.
- **Parser** (`cardText.ts`): `splitOptional` consumes cost parts (`pay [..]`, `[Burn N]`, a card phrase) joined by " and " and ended by " to " (or by the effect itself after an " and ": "discard 1 and channel 1 rune exhausted"). Card phrases: `discard 1 / a gear / two cards`, `kill (a|another|N other) friendly (unit|gear|unit or gear|units and/or gear) [you control] [here]`, `exhaust ...`, `return ... to its owner's hand`, `recycle N [type] from your trash`. Kill / exhaust / return need "friendly" or "you control". `parseAbilityCost` takes the same phrases plus `[C]` / `[A]`. "Kill a unit or gear [here]" is a chooser; heads "When you play me or when I attack / defend". A Deathknell with "here" is refused (the place of death is not kept).
- **Converter / schema**: `convertRow` stores whatever the parser returns; `resources/card-schema.json` now types `triggers[].optional` and `abilities[].cost.card` (a `costCardChoice` definition) and a script test checks the stored shape and schema validity.
- **Bot**: `AIController` scores the accept / decline candidates and the activation candidates like any action (tested: it answers a pending discard choice with a legal intent).
- **Client**: `CostCardPicker` (list of toggle buttons with name, type / Might and where the card is, a `n/need` counter, confirm enabled only for exactly `need` cards, min 44px rows, scrolls inside the dialog) built from `costCardCandidates` on the player's own view. `OptionalPrompt` shows "Cost: Pay 1 Energy, Discard 1 card" and the picker replaces the accept button (Decline needs no card). `AbilityCostPrompt` + `useBoardUi.activateAbility` handle activated abilities: Activate (button or context menu "(choose cards)") opens the picker, then a targeted ability continues with click-to-target restricted to the variants that pay with those cards; Escape / Cancel does nothing. `describeAbility` shows power and card costs; `describeEvent` words `COST_CARDS_PAID` (exhaustive switch).
- **Dev / e2e**: `?mock&costcard=1` (Cinder Grunt "When you play me, you may discard 1 to draw 2" and "Discard a card, [E]: Give me +2 [M] this turn", one in hand, one ready in the base, two extra runes). `e2e/abilities.spec.ts`: pick-and-accept, decline, activate with a discard cost.

## Golden hashes

`reducePurity.test.ts` golden hashes did not change: no fixture card has a card cost, and the new intent fields / event only exist for such cards.

## Rules and UNCLEAR items

Tests cite 357.1.a, 145.1, 355.10, 186.1, 323, 140, 340.1, 106, 473.2. UNCLEAR (docs/ASSUMPTIONS.md "R46"): when the cards are chosen, Ruined Monastery's "discard 1 and channel" as one optional action, kill-as-cost through lethal damage, the Recycle order, Deathknell "here".

## Gaps and risks

1. **Additional costs to play a card** (7 cards measured: Ki Burst, Life from Stone, Parallel Convergence, Ekko, Legion Quartermaster, Cruel Patron, Sacrifice) are the next natural step: the same `CostCardChoice` on `CardDef.additionalCost` and `PLAY_CARD.costCards`, with the picker opened before the play.
2. **The picker is a list, not click-on-the-board.** Units are named with their location, but are not highlighted on the board while choosing. Wiring the cost into `targetStep` would need the cost cards in the same variant keys as the targets.
3. **Enumeration cap**: beyond 48 combinations the engine lists a prefix; the client builds the intent itself, the bot only ever sees the prefix.
4. **Kill as a cost may hit the source itself** unless "another" is printed.
5. "Spend a buff" (Wildclaw Shaman, Monastery of Hirana), self sacrifice ("kill me"), trigger moments that do not exist and Deathknell "here" remain.
6. **Old guests**: a guest on a build without `costCards` in the hint list ignores the field and sends a bare accept, which the engine rejects with `MISSING_TARGET`; host and guest should be updated together.
