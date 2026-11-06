# R49: "When you play a <card>" triggers

Status: done (engine, parser, converter). Fully supported cards 265 -> 275 of 1103 (`npm run cards` shows 6 more for token definitions). Engine 717 tests (+5), scripts 30, client unchanged; typecheck, lint, check:rules green; `reducePurity` golden hashes unchanged.

## Measurement

`m49c.ts` (session scratchpad): for every partial card, which sentences fail to parse on their own, grouped by theme. The largest tractable family was "When you play a spell / unit / gear / card, ..." (about 20 cards, most with effects the parser already knew). Predict (14 cards) was skipped: its choices (recycle any, reorder the rest) need an interactive choice and the cards also carry other unparsed sentences.

## What changed

- `TriggerKind` 'YOU_PLAY' and `CardTrigger.playFilter` (`PlayFilter`: type, other, minEnergy, onOpponentTurn, inShowdown).
- Parser (`cardText.ts` `parsePlayHead`): "When you play [another] a spell|unit|gear|card [that costs / with Energy cost [N] or more] [on an opponent's turn | during a showdown], <effects>", with the usual "if" conditions and effect sentences. New effect "Ready me" (`READY_SELF`).
- Engine (`triggers.ts`): on CARD_PLAYED, every other permanent of the player who played it (board or Legend zone) with a matching YOU_PLAY trigger goes on the Chain.
- Converter: Legends whose whole text is YOU_PLAY triggers become full (the Legend object lives in its zone and is scanned).
- Tests: `scenarios/youPlayTriggers.test.ts` (fires, wrong type, Energy threshold, self-play does not fire) and the parser heads.

## Not done

Power-cost / "from face down" / "[Mighty]" / "if you spent" qualifiers, "buff me", "ready up to N runes", optional "you may exhaust me to ..." costs on Legends, Predict, Vision, start / end of turn triggers.
