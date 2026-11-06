# R28: AI strength and difficulty levels

Status: done (engine bot, client difficulty picker, match harness). Engine 712 tests (+1), client 420; typecheck, lint, check:rules green; Playwright smoke + solo pass on a temporary port-5199 server.

## Measuring (new tool)

`scripts/ai-match.ts` plays bot A against bot B (or `--b random`) on real preset decks (needs `npm run cards`), every deck pairing twice with seats swapped, and reports A's score with a 95% interval. A game still running at turn 12 goes to whoever has more points. Example: `npx tsx scripts/ai-match.ts --games 60 --budget 400 --a '{"difficulty":"hard"}' --b '{"difficulty":"normal"}'`.

## Findings

- The old `easy` (score noise of +-40 on a 1000-point scale) was the same bot as `normal`: 52.5% for normal vs easy over 60 games (interval +-12.6).
- Evaluation-weight tuning does not help. Eight variants (battlefield, Might, hand, rune, ready-unit, damage weights) all scored 48-53% against the defaults, inside the noise, except weighting hand and runes higher, which is clearly worse (28%: the bot hoards instead of playing). The default weights stay.
- Most games end level at the turn cap because units sit on the battlefield they hold and cannot attack the other one directly; the 1-ply search never sees a two-step plan.

## Difficulty levels (`BotDifficulty`, `engine/src/ai/bot.ts`)

| Level  | Behaviour                                                                                                                         | Result (60-120 games, budget 400 ms)              |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| easy   | score noise +-400, at most 12 candidates scored, 15% of decisions it just ends the turn / passes                                  | 61% vs random; normal beats it 77.5% (+-10.6)     |
| normal | unchanged 1-ply search with settle                                                                                                | 84% vs random (40 games)                          |
| hard   | normal plus a rollout: at the end-of-turn decision the best 4 actions are each followed by a greedy replay of the rest of my turn | 63% vs normal over 120 games (69 W / 38 L / 13 D) |

Hard stays inside the same wall-clock budget (the rollout checks the deadline each step). It only runs when END_TURN is legal, so reaction decisions cost the same as normal. `lookahead` can be overridden per bot.

## Client

Solo setup has a third radio, Hard. `'easy' | 'normal'` became `'easy' | 'normal' | 'hard'` in the Worker protocol, host game, and saved-game header (saves made before this still load).

## Not done

- A real multi-ply search against the opponent's replies (the rollout assumes the opponent passes).
- Using card effects in evaluation (spells are scored only by their board result).
- Planning a battlefield switch (move to base, then to the other battlefield) across turns.
- The interval at 120 games is about +-9 points; a larger run would tighten the hard-vs-normal figure.
