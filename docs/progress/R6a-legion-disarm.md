# R6a: Legion (812) and Disarm (831)

Status: Legion implemented as a keyword (tracking and check). Disarm NOT implemented: blocked on an attack trigger that takes a target. Card support is unchanged by Legion.

## What changed

| Item               | Change                                                                                                                                                                                                                                                                                                   | Files                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Played-card record | `PlayerState.playedThisTurn?: {turn, objectIds}`. playCard appends the played card's id when it moves to the Chain, so the source counts before its own Legion check. A record from an earlier turn counts as nothing, so there is no reset step. Hidden plays go through playCard and are recorded too. | engine/src/types/state.ts, engine/src/play.ts |
| Legion check       | `legionActive(state, playerId, sourceId)`: true if the player has played a card other than the source this turn.                                                                                                                                                                                         | engine/src/keywords.ts                        |
| Keyword lists      | Legion moved from DEFERRED to MVP (`MVP_KEYWORDS`, `MvpKeywordName`). Disarm stays deferred.                                                                                                                                                                                                             | engine/src/types/card.ts                      |
| Tests              | 4 scenario tests: keyword flags, own play excluded, opponent's plays not counted, reset on a new turn.                                                                                                                                                                                                   | engine/src/scenarios/legionDisarm.test.ts     |

Hidden information: `playedThisTurn` holds only ids of public plays (CARD_PLAYED is public). Hidden cards are recorded only when they are played, not when hidden. Sanitize copies PlayerState, so the field reaches the client; it leaks nothing new.

## Legion: rule and card text

- Rule 812 (dependent keyword). The check doc says: active if you have finalized another card this turn.
- Card text (`cards.json`): "Get the effect if you've played another card this turn." Hand of Noxus says "a card this turn". Those are the same condition for a unit already on the board.
- Implemented: the played-card counter and `legionActive`.
- Not implemented: the Legion effect itself. No card effect reads `legionActive` yet. A conditional effect needs a `condition` on `CardTrigger` / `CardEffect` and parser support in cardText.ts / effects.ts, which other agents own.
- Not implemented: Noxus Hopeful's "I cost [2] less" (a cost reduction; CostMod only models increases).

## Disarm: rule and card text

- Rule number: the check doc marks it UNCLEAR (831 or 832). I tried the official page (riftbound.gg/rules/core-rules/). The fetch truncates around rule 805 at every offset I tried, so the glossary entry could not be read. The PDF text the check doc used is not in the repo. Treat 831 as provisional.
- Text (all 9 cards): "[Disarm] (When I attack, give an enemy unit here -X [M] this turn.)"
- Why it is not implemented: the effect needs (1) an attack event, which does not exist (combat starts through `startCombat`, which emits no event for it), (2) a choice of the enemy unit, which the trigger path cannot take (`triggers.ts` only runs target-free effects), and (3) a negative Might buff that lasts until end of turn, which `BUFF_TARGET` can do once a target exists. (1) is in combat.ts / triggers.ts, which are owned by the showdown agent. A target-free auto-pick would break the rule, so it was not done.
- Consequence: marking Disarm MVP now would mark Trinket Peddler, Siren of the Shallows and the others as fully supported with no effect. Kept DEFERRED.

Requirements to finish Disarm: a `DECLARE_ATTACK`-style event at combat start; a pending choice step for "give an enemy unit here -X" with the chosen target stored on the chain item; `BUFF_TARGET` with a negative amount; then move Disarm to MVP. Summed triggers (the check doc's "triggers once with the summed value") need to be decided with the rule number.

## Card counts

`npm run cards` (build-cards.ts on data/raw; the fetch step was not run):

- Before (my baseline, this session, before my changes): 118 fully supported of 1103.
- After: 141 of 1103. The +23 is NOT from Legion: none of the 10 Legion cards became full (their remaining text still has prose), and Disarm is unchanged. The increase comes from parser work by another agent that landed on disk during this session (effects.ts / cardText.ts); it has not been attributed card by card.

Cards left partial because of Legion: all 10 Legion cards (Noxus Hopeful, Dangerous Duo, Scrapyard Champion, Sun Disc, Trifarian Gloryseeker, Vanguard Captain, Darius, Hand of Noxus, Noxian Guillotine, Undying Legion). Their Legion effects are not executed.

Cards left partial because of Disarm: all 9 Disarm cards (Ahri, Mysterious Chronomancer, Trinket Peddler, Clanging Sentry, Kai'Sa, Seraphine, Disposal Expert, Siren of the Shallows, Evelynn). Trinket Peddler and Siren of the Shallows would be full once Disarm works, because their text has nothing else.

## Tests

- `npx vitest run --root engine engine/src/scenarios/legionDisarm.test.ts`: 4 passed.
- Full engine suite: 521 of 522 passed on the first run; the one failure was a 5 s timeout in gameEnd.test.ts under load, which passes on its own.
- `npm run check:rules`: passed (522 blocks).
- `npm run test:scripts`: 13 passed.
- `npm run typecheck`: clean.
- `npm run lint`: 5 errors, all in other agents' scratch files (`scripts/_cand.ts`, `_diff.ts`, `_freq.ts`, `_show.ts`); none in files touched here.

## Open items

1. Disarm (see requirements above) and the rule number 831 vs 832.
2. Legion effects: a `condition` on triggers/effects, then wire `legionActive`.
3. Noxus Hopeful cost reduction.
