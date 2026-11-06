# R47: additional card-choice costs to play a card

Status: done (engine, parser, converter, schema, legal actions, bot, client, e2e). Fully supported cards 257 -> 265 of 1103 (`npm run cards` reports 271 because it counts 6 token defs; was 263). Engine 711 tests (+16), client 420 (+5), scripts 30 (+2); typecheck, lint, check:rules green; `reducePurity` golden hashes unchanged; `profile-ai` bot-vs-bot (real decks) completes; Playwright smoke + solo + abilities 11/11 on a temporary port-5199 config (deleted, no port 5173, no peer server).

## Measurement (before coding)

Scratch script outside the repo (`m47.ts` / `t47.ts` in the session scratchpad, adapted from R46's `m46.ts`) ran `convertRow` over the deduped `data/raw/cards.json` at HEAD `955c753` and listed the sentences whose removal makes a partial card full ("single blockers") that mention an additional cost. 229 raw rows contain "additional cost" (mostly Accelerate / Hidden / Repeat reminder text); the single blockers were:

| Shape                                                                                                          | Cards                                                                  | Done |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---- |
| "As an additional cost to play this, exhaust a friendly unit." (spell)                                         | Ki Burst, Life from Stone                                              | yes  |
| "... return a friendly unit to its owner's hand." (spell / unit)                                               | Parallel Convergence, Ekko                                             | yes  |
| "... return a friendly gear to its owner's hand." (unit)                                                       | Legion Quartermaster                                                   | yes  |
| "... kill a friendly unit." (unit)                                                                             | Cruel Patron                                                           | yes  |
| "... kill a friendly [Mighty] unit." (spell)                                                                   | Sacrifice                                                              | yes  |
| `[Repeat] - Discard 1` (the optional additional cost of Repeat is a card choice)                               | Square Up (cheap leftover, same machinery)                             | yes  |
| Legend "As an additional cost to play a spell, you may exhaust me and three friendly units to reduce its cost" | Starry-Eyed Songstress (cost modifier of OTHER cards, not an own cost) | no   |

No required additional cost with an Energy / Power part and no "if you paid the additional cost" conditional effect text were a single blocker, so neither shape was built (the engine only has the card-choice part). 8 cards unlocked.

## Design

- **Card data** `CardDef.additionalCost?: { card: CostCardChoice }` is a REQUIRED additional cost (the object leaves room for an Energy / Power part later). `CostCardChoice.mighty` (new) restricts to units with Might 5+ (`MIGHTY_MIGHT`, `costCards.ts`). The optional additional cost of Repeat is `CardDef.repeatCost.card` (`{energy: 0, power: 0, card: {kind: 'DISCARD'}}`).
- **Intent** `PLAY_CARD.costCards?: string[]` (shape-checked in `reducer.ts`, accepted by the protocol/replay allow-lists already because the type is unchanged). `play.ts playCard` picks the cost with `playCostCard(def, repeat)`: the required one, else Repeat's card part when Repeat is paid. Before anything is paid it checks `costCardsLegal` (missing = `MISSING_TARGET`, bad = `ILLEGAL_TARGET`, stray cards on a card without one = `ILLEGAL_TARGET`, required cost + Repeat card cost = `KEYWORD_RESTRICTION`); after the Energy / Power payment succeeds it calls `payCostCards` on the paid working copy, so a bad choice or a bad rune plan leaves the state untouched and the whole play is atomic (358.5). `COST_CARDS_PAID` is emitted before `CARD_PLAYED`.
- **Qualifying rule**: `costCards.ts qualifies` is shared with R46. New: a DISCARD never takes the card being played (it is still in hand); `mighty` uses `effectiveMight` outside combat.
- **Legal actions** (`legalActions.ts`): one PLAY_CARD per choice of cost cards (`costCardCombos`, object order, cap 48 via `MAX_TARGET_COMBOS`; with many target choices fewer card choices each so the list stays near 48 per card). A card whose cost cannot be paid yields no PLAY_CARD (not playable); the Repeat variant disappears when there are not enough cards to discard. For KILL / RETURN the pairs where the chosen cost card is also the spell's target are not listed (it would fizzle). The first listed choice is the lowest object id, which is what fallbacks (`legal[0]`) and the bot's tie-break use; the bot scores the resulting states like any play.
- **Hidden / Reaction / Ambush**: unchanged. A facedown Hidden card played through `playHiddenCard` goes through the same `playCard`, so its additional cost still applies ("additional costs still apply" is already the comment there) and it lists `costCards` variants too.
- **Hidden information**: a discarded card goes to the public Trash and `COST_CARDS_PAID` names it (as in R46); board kills / returns / exhausts are public; the hand stays private (sanitize test).
- **Parser** (`cardText.ts`): `parseAdditionalCost(text)` takes a line "As an additional cost to play this/me, <R46 card-choice phrase>[.] (reminder)" (with `[Mighty]` before the noun) and returns the cost plus the text without that line; `parseRepeatCost` also reads `[Repeat] - Discard 1` (any single R46 phrase), and `parseSpellText` strips that line. Enemy choices ("kill a unit") and Energy parts ("pay [2] and ...") are not cost cards and keep the card partial.
- **Converter** (`cardConvert.ts`): for Unit / Spell / Gear the additional-cost line is removed before keyword extraction, support level and the spell / unit parsers (card `text` keeps the printed line). `card.additionalCost` is stored only when the card ends up fully supported. A unit whose only text is the cost (Cruel Patron, Legion Quartermaster) is full. Schema: `additionalCost`, `repeatCost.card`, `costCardChoice.mighty`.
- **Client**: clicking a hand card whose play needs `additionalCost` opens the existing `AbilityCostPrompt` / `CostCardPicker` BEFORE targets and location ("Play X: pay the additional cost", confirm button "Play"); the chosen cards are swapped into the legal PLAY_CARD variants (`withCostCards`), so the usual click-to-target banner, location popover and engine validation follow. The Repeat card cost opens the picker when the Repeat variant is chosen from the popover or the context menu (a variant that still needs cards is sent with them). A card that cannot pay is not highlighted; forcing a click shows the engine's rule error. `CardDetail` shows "Additional cost to play: ...". The picker is the same list-of-buttons modal, so it is mobile friendly (min 44px rows, scrolling list).
- **Dev/e2e**: `?mock&extracost=1` gives the human a Cinder Grunt in hand with "kill a friendly unit", a ready Cinder Grunt in the base and two extra runes; `e2e/abilities.spec.ts` plays it through the picker.

## Golden hashes

`reducePurity.test.ts` hashes did not change: no fixture card has `additionalCost` / `repeatCost.card`, and `costCards` is only added to intents when present.

## Rules and UNCLEAR items

Tests cite 357.1.a (paying a cost), 358.5 (an illegal play is undone), 359.2 (permanents enter the Base), 323 (lethal damage kills at the Cleanup), 820 (Repeat). UNCLEAR (docs/ASSUMPTIONS.md "R47"): when the cost cards are chosen relative to targets, that the cost may be paid with the spell's own target, Mighty = 5+ Might, a discard cost never takes the played card, Legend cost modifiers.

## Not done

- Required additional costs with an Energy / Power part, "if you paid the additional cost" effect text, Repeat with several costs (Curtain Call) or granted Repeat (Syndra, Academy, Temporal Portal).
- Legend cost modifiers for other cards (Starry-Eyed Songstress) and any text that changes the cost of OTHER cards.
- Choosing the cost cards by clicking the board (the picker is a list, like R46).
- Leftover buckets from R46 (spend a buff, self-sacrifice, Deathknell "here") were not touched; the measurement for additional-cost text found nothing else cheap.

## Risks

1. **Cost before targets**: the client asks for the cost cards first; if the rules choose targets first nothing in the engine changes (it validates both together), only the order of the prompts.
2. **Target equals cost card**: the engine accepts killing / returning the spell's own target (it fizzles); the legal list hides such pairs but a hand-built intent works.
3. **Capped list**: `getLegalActions` lists at most 48 card choices; the client sends any legal choice with the cards swapped in, the engine validates it.
4. **Old guests**: a guest build without `costCards` on PLAY_CARD would reject the extra field in a legal hint; update host and guest together (as with R45 / R46).
5. **Mighty** uses current Might (including buffs and attached equipment) outside combat.
