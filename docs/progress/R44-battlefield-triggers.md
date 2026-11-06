# R44: Battlefield card triggers

Status: done. Fully supported cards 226 -> 235 of 1103 (`npm run cards` reports 241 because it counts 6 token defs; was 232). Engine 647 tests (+16), client 395 (+2), scripts 26 (+3); typecheck, lint, check:rules green; `reducePurity` golden hashes unchanged; `profile-ai` bot-vs-bot (6 games, real decks) completes; Playwright smoke + solo + abilities 5/5 on a temporary port-5199 config (deleted, no port 5173).

## Measurement (before coding)

Scratch scripts outside the repo (`bf44.ts`, `bf44b.ts`, `bf44c.ts` in the session scratchpad) ran `convertRow` over the deduped `data/raw/cards.json`: 76 Battlefield cards, 0 full. Text shapes of the 76:

- **"When you hold / conquer / defend here, ..." : 34 cards.** Rewritten to the unit forms ("When I hold, ...") only 2 parsed unchanged (Grove of the God-Willow, Reaver's Row). The rest are blocked by their effect, not by the head: optional/pay/mandatory-choice effects 13, other effect shapes 12 (this combat grants, discard, reveal, Buff, delayed ready, cost changes, excess damage, Academy's Repeat grant, ...).
- Triggers on other events (a unit dies / is played / moves / is returned here, start of Beginning Phase, combat starts, hide): 17.
- Static or replacement text ("Units here have +1 [M]", cost modifiers, "can't" rules, "while you control this battlefield"): 25.
- Cheapest: the head forms plus effects that already exist or are one tiny op. Implemented 9: Grove of the God-Willow (draw), Reaver's Row (targeted "you may move a friendly unit here to base"), Altar to Unity (Recruit token in base), Cosmic Vista (Rune Deck empty condition + score a point), The Grand Plaza (7+ units here + win the game), Shadow Temple and Minefield (`BURN`), The Papertree (each player channels), Seat of Power (draw per other battlefield).

## What was added

| Area         | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Files                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Source model | `ChainItem.sourceBattlefieldId` (optional, absent for every existing item so persisted/replayed games and hashes are unchanged); `sourceObjectId` is `''` for those items. `itemSourceId`, `hereOfSource` (object -> its battlefield, battlefield id -> itself) and `cardIdOfSource` are the single place where "here" is resolved.                                                                                                                                                                                           | `types/chain.ts`, `sources.ts`, `effects.ts` (`spec.here`, `playTokens`), `conditions.ts`                         |
| Triggers     | `collect` adds the battlefield's HOLD/CONQUER (from `BATTLEFIELD_SCORED`, controller = scorer) and ATTACK/DEFEND (from the combat `SHOWDOWN_STARTED`, controller = attacker / defender); same `when`, auto-target / `TRIGGER_NO_TARGET` / pending `TRIGGER_TARGET` flow as units. Resolution in `playResolver`; `abilityItemEffects`, `chooseTriggerTarget`, `getLegalActions` use `itemSourceId`.                                                                                                                            | `triggers.ts`, `play.ts`, `legalActions.ts`                                                                       |
| Effects      | `BURN` (+ event `CARDS_BURNED`), `WIN_GAME`, `CHANNEL.eachPlayer`, `DRAW.perOtherBattlefield`, condition `COUNT.where: 'runeDeck'`.                                                                                                                                                                                                                                                                                                                                                                                           | `types/card.ts`, `types/event.ts`, `effects.ts`, `conditions.ts`                                                  |
| Parser       | `parseBattlefieldAbilities` rewrites "When you hold/conquer/defend/attack here" to the unit heads and reuses `parseCardAbilities` (all-or-nothing; refuses abilities, statics, non-battlefield triggers). New sentences: `[Burn N]` / "Put the top N cards of your Main Deck into your trash", "Each player channels N rune(s) exhausted", "You win the game", "Draw N for each other battlefield you (or allies) control", token "in your base"; conditions "your Rune Deck is empty", "you have 7+ / N or more units here". | `cardText.ts`, `scripts/lib/cardConvert.ts` (Battlefield wiring), `index.ts`                                      |
| Client       | Chain inspector shows "<Battlefield card name> (battlefield ability)"; `describeEvent` names the battlefield for `CHAIN_ITEM_ADDED`, `TRIGGER_TARGETED`, `TRIGGER_NO_TARGET` and words `CARDS_BURNED`; the target banner and `useBoardUi` use `itemSourceId` and `cardNameOf` resolves battlefield ids.                                                                                                                                                                                                                       | `ChainInspector.tsx`, `viewObjects.ts`, `describeEvent.ts`, `TargetBanner.tsx`, `useBoardUi.ts`, `interaction.ts` |

The card schema needed no change (`triggers` / `effects` are open objects).

## Design notes

- **Hidden information:** a battlefield source is public (the Battlefield card is face-up). Effects read only public data and hand sizes; the leak tests pass unchanged and a scenario checks the opponent's sanitized chain item.
- **Pending choices:** the existing `TRIGGER_TARGET` flow; the bot answers (test), the `legal[0]` host fallback and `hostTimers` resolve through `getLegalActions`, which now enumerates targets with the battlefield as source. "You may" targeted triggers (Reaver's Row) offer the empty answer.
- **Presets / deck coverage:** `deckSupportStats` and `buildPresetDecks` are driven by `supportLevel`, so battlefields now count as full when parsed; `preview-decks` gives 58 legal presets, 0 diagnostics.
- **Final Point:** hold/conquer triggers still fire when the point is denied (see ASSUMPTIONS "R44"; consistent with the existing unit triggers).
- **Golden hashes** unchanged: no fixture card uses the new fields and the optional `sourceBattlefieldId` is only written for battlefield items.
- **Incident:** a scripted edit with `String.replace` and a `$` + backtick in the replacement duplicated `cardText.ts`; it was repaired in place (diff verified against the intended change). A `git show HEAD:...` restore was denied by the permission classifier and not retried.

## Rules and UNCLEAR items

Tests cite 473.2 (Conquer/Hold triggers), 315.2.b, 472, 473.1.b, 466.2.c, 355.10, 432, 194 and 106. UNCLEAR items are in docs/ASSUMPTIONS.md "R44": who "you" is, trigger ordering between a battlefield and its units, firing when the Final Point rule denies the point, when "win the game" resolves.

## Not done (counts of the 67 still-partial Battlefield cards)

- Static / replacement text (25): "Units here have +1 [M] / [Ganking]", cost modifiers, "can't be played / move", victory score +1, Black Market, ...
- Triggers on other events (17): a unit dies / is played / moves / is returned here, start of Beginning Phase, combat starts, hide.
- Optional or paid effects (13): "you may pay [1] to ...", "you may discard 1 and channel 1", Startipped Peak ("you may channel"), Sigil of the Storm (recycle a rune of your choice). Needs a non-targeted optional/pay choice.
- Other effect shapes (12): "this combat" keyword grants (Durand Memorial, Fortified Position), discard-then-draw, reveal/look, Buff, delayed "at the end of this turn", cost increases (Vaults of Helia), Repeat grant (The Academy), Accelerate grant (Firelights' Hideout), excess damage (Trapping Grounds), "activate the conquer effects" (Reckoner's Arena).

## Risks

1. `sourceObjectId: ''` for battlefield items: code that assumes a non-empty object id would misbehave; all in-repo readers use `itemSourceId` or tolerate a missing object.
2. Firing on denied Final Point scoring and the ordering with unit triggers are unverified against the Core Rules text.
3. "You win the game" is a normal Chain item and ends the game on resolution.
