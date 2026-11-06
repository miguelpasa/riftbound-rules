# R50: self cost reductions ("I cost [N] less ...")

Status: done (engine, parser, converter, client cost display). Fully supported cards 275 -> 282 of 1103 (`npm run cards` shows 6 more for token definitions). Engine 721 tests (+4), client 426, scripts 30; typecheck, lint, check:rules green; `reducePurity` golden hashes unchanged.

## Measurement

Same per-sentence analysis as R49 (`m49c.ts`): "I cost [N] less ..." was the next biggest family (about 15 unit and spell cards). Shapes that need only data the engine already has were built; the rest need new tracking (see Not done).

## What changed

- `CardDef.costReduction: { energy, per?, when?, min? }` (`types/card.ts`, `CostCount`: gear, exhausted unit, Trash, same-name Trash, [Mighty] unit, cards played this turn).
- `engine/src/costReduction.ts` `selfEnergyDiscount` is the one place that answers "how much Energy is knocked off right now" (Legion plus the card's own reduction). `play.ts` pays it, `legalActions.ts` uses it for affordability, the client (`game/abilities.ts` `legionDiscount`) shows it on the card; the badge text no longer says only "Legion".
- Parser `parseSelfCostReduction` (`cardText.ts`) takes the line off the card text like R47's additional cost; the converter stores it only when the rest of the card is fully supported.
- Tests: `scenarios/costReduction.test.ts` (per-count discount makes an unaffordable card playable and is what is paid, minimum floor, condition) and the parser shapes.

## Not done

"To play from anywhere other than your hand" (Void Drone, Drag Under), Power reductions, "for each battlefield you conquered this turn", "if an enemy unit died this turn", "if you've played a unit or gear to a battlefield this turn", cost modifiers of other cards (Legends, battlefields, "the next card you play"), and the "enters ready" half of Monch.
