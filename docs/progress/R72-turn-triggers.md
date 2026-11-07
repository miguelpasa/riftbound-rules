# R72: Turn triggers: start of Beginning Phase and end of turn, rune effects, rune and facedown conditions

Status: done. Fully supported cards 394 -> 400 of 1103 (`npm run cards` full count). Engine 799 tests (+11), client 426, scripts 31; typecheck, lint, check:rules green; golden hashes unchanged.

## What changed

- Trigger kinds `TURN_START` and `TURN_END`, resolved INLINE by `engine/src/turnTriggers.ts` from the Beginning (before the Temporary kills) and Ending (before healing) hooks: the active player's permanents with such a trigger and a true condition run their effects at once, in object order. A Cleanup runs after end-of-turn effects so lethal damage kills before the heal.
- Effects `READY_RUNES`, `RECYCLE_RUNES`, `RECYCLE_TRASH`; conditions `RUNES_VS_OPPONENT` and `FACEDOWN`.
- Parser: "At the start of your Beginning Phase", "At the end of your turn", "When you play me or at the start of your Beginning Phase", "If <cond> at the start of your Beginning Phase", "Ready up to N runes", "Recycle all your runes", "Recycle N from your trash". Bodies with a target or an optional payment are refused (they cannot wait for a choice).

## Not done

- Battlefield-card and Legend turn triggers, "each player's" turn triggers, optional or targeted turn triggers.

