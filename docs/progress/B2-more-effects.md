# B2 - More card effects, round 2 (R3)

Same method as [B-more-effects.md](B-more-effects.md): `npm run cards`, frequency pass over the sentences of the remaining partial spells and unit/gear triggers, all-or-nothing parser, scenario tests with a rule citation.

## Added

| Family                  | Parser (`engine/src/cardText.ts`)                                                                                                                                                                                    | Effect op (`types/card.ts`, `effects.ts`)                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tokens             | "Play [a/two/three/four/N] [ready] N [M] Name unit token(s) [with [Keyword]] [here / to, into, at your base]" (spells and triggers)                                                                                  | `PLAY_TOKEN {token, count, ready?, here?}`; token table in `engine/src/tokens.ts` (Recruit 1, Sprite 3 Temporary, Bird 1 Deflect, Mech 3, Sand Soldier 2)                 |
| "Choose a unit. ... it" | "Choose a [friendly/enemy] unit [at a battlefield]." then "Give it +N / -N [M] this turn[, to a minimum of M]", "Deal N to it", "Ready it", "Stun it", "Kill it", "Return it to its owner's hand", "Move it to base" | existing targeted ops with the slot of the chosen unit; side and "at a battlefield" are inherited by every "it" effect; a Choose that no effect uses now refuses the card |
| Return to hand          | "Return a [friendly/enemy] unit [at a battlefield] [with N [M] or less] to its owner's hand", "Return a gear to its owner's hand"                                                                                    | `RETURN_TARGET`; tokens cease to exist (186.1), cards are reset and go to the owner's hand                                                                                |
| Move to base            | "Move a unit from a battlefield to its base", "Move a [side] unit to base", "Move up to 2 friendly units to base"                                                                                                    | `MOVE_BASE_TARGET` (effect move, emits `UNIT_MOVED`; Cleanup fixes battlefield control)                                                                                   |
| Kill all units          | "Kill all units"                                                                                                                                                                                                     | `KILL_ALL_UNITS` (lethal damage, Cleanup trashes units / removes tokens)                                                                                                  |
| Look at the top         | "Look at the top N cards of your Main Deck. Put 1 into your hand and recycle the rest." and "... You may reveal a unit/gear from among them and draw it. [Then] recycle the rest."                                   | `LOOK_TOP {count, take?}`; events `CARDS_LOOKED_AT`, `CARD_REVEALED`, `CARD_DRAWN`, `CARDS_RECYCLED`                                                                      |
| Trigger shapes          | "[Deathknell]" followed by an em dash, "When you play me or when I hold/conquer" (two triggers), sentences after a trigger sentence join that ability                                                                | `parseTriggerText` groups sentences per ability                                                                                                                           |

## Tokens: design

- No token definitions exist in the card data, so `engine/src/tokens.ts` holds `TOKEN_CARDS` (CardDef type `TOKEN`, `stats.might`, ids `tok-recruit`, `tok-sprite`, `tok-bird`, `tok-mech`, `tok-sand-soldier`). The parser looks a token up by name, Might and the `with [Keyword]` in the text and refuses the card when no definition matches (so "Play a 1 [M] Bird unit token" without Deflect stays partial).
- Distribution: `scripts/build-cards.ts` adds the token defs to `client/public/cards.json` (schema validated) and `client/src/cards/loadCards.ts` merges them in when an older cards.json lacks them. `@riftbound/engine` exports `TOKEN_CARDS`, `tokenIdFor`, `isUnitDef`. Replay and persistence look cards up by id and keep working; sanitize needs nothing (tokens are public Board objects); deck building already ignores type `TOKEN`.
- Unit-likeness: a `TOKEN` with Might is a unit for movement (`movement.ts`), legal move / equip enumeration (`legalActions.ts`), unit lookup in `keywords.ts` and the AI evaluation. Effects, combat, cleanup, Temporary and the kill paths already handled `TOKEN` (186.1).
- Converter: a keyword inside "unit token with [Keyword]" belongs to the token, so `cardConvert.ts` no longer gives the unit that keyword (Sprite Mother is no longer Temporary, Frisky Hunter and Hunting Dog no longer have Deflect).
- `runEffects` has a 7th argument `sourceObjectId` (passed by `play.ts` for triggers): "here" is the source unit's battlefield, else the Base. Tokens enter exhausted unless the text says "ready".

## Deterministic stand-ins (gaps, no choice UI)

- LOOK_TOP chooses for the player: the first matching unit/gear from the top for "reveal a unit/gear", and for "put 1 into your hand" the card with the highest Energy cost (first on ties). A real choice needs a pending-choice step for the controller (hidden information).
- Token location: with no location the token goes to the Base (the printed "or to battlefields you control" choice is not modelled); "here" at a battlefield is the source's battlefield; a Deathknell token goes to the Base.
- Move to base only. "Move an enemy unit" and other moves with a destination need a destination choice plus the contest/showdown rules.

## Tests

- `engine/src/cardText.test.ts` (+6): token sentences and refusals, "it" forms and refusals, return / move / kill-all, look sequences, token and multi-sentence triggers.
- `engine/src/scenarios/effectsMore.test.ts` (+19): Temporary Sprite lifetime, Recruit tokens enter exhausted, a ready token moves and ceases to exist when killed, "here" at a battlefield and in the Base, Deathknell tokens, a missing token def fizzles, "it" buffs / chained "it" effects / enumeration, Return (reset, token, Might limit, gear), Move to base (control drops, UNIT_MOVED, up to two), Kill all units, Look at the top (dearest card, gear reveal, none found).
- `scripts/lib/cardConvert.test.ts` (+1), `client/src/game/describeEvent.test.ts` (new events).
- Totals when written: engine 549 tests, client 354, scripts 14; `check:rules` 549 blocks.

## Coverage (`npm run cards`)

- Fully supported cards (excluding the 5 token defs now in cards.json): 118 -> 141 of 1103 (spells 42 -> 52, units 39 -> 52, gear 31). Some of the unit gain may come from the parallel Legion work. From this round: Sprite Call, Sprite Burst, Recruit the Vanguard, Fight or Flight, Flash, Gust, Rebuke, Factory Recall, Stacked Deck, The Ruination, Sprite Mother, Faithful Manufactor, Industrious Mechsmith, Machine Evangel, Ferrous Forerunner, Hunting Dog, Carrion Dredger, Frisky Hunter, Royal Guard, Trevor Snoozebottom, Ornn.

## Skipped and why

- **Gold gear tokens** (Wages of Pain, An Offer You Can't Refuse, Bushwhack, The Waters' Wage, Blood Money, Plundering Poro, Draven, ...): a Gold token only has an activated ability ("[Reaction] Kill this, [E]: [Add] [A]") and the engine has no activated abilities yet (`ACTIVATE_ABILITY` is rejected). An inert token would make the cards wrongly "full", so they stay partial. Prerequisite: an activated-ability system for permanents (cost payment, Reaction timing, Add Power).
- Bomb / Reflection / Shadow Clone / Tentacle tokens (Deploy, copy, abilities on tokens); tokens "to a battlefield" (Rally for War, battlefield choice); conditional token cards (Guards!, Production Surge, Arise!, Hexplosive Minefield).
- "Move an enemy unit" / "Move a friendly unit" with a destination (Charm, Ride the Wind, Void Assault, Temptation, ...): needs a destination choice plus the contest/showdown rules.
- Look at the top with a real choice or other tails (Reinforce, Wild Claw, Baited Hook, Trifarian Captain cost filters, Lightning Rush "put the rest into your trash"; Called Shot and Double Trouble need Repeat; Command: Attack is modal).
- Highlander / Tactical Retreat ("the next time it would die ... recall it instead") need a replacement-effect hook in Cleanup. Shadow's Call, Last Stand, Cleave, Block need keywords granted until end of turn (no per-instance keyword grants). Retreat needs "Its owner channels".
- `[Predict]` and `[Flow]` stay deferred keywords (Predict needs a reorder choice, Flow plays from the Trash).
