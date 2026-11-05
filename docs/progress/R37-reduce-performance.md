# R37: cutting the engine's state-copy cost

Problem (from R29): 78% of CPU in `reduce` was `structuredClone`; every rules helper copied the whole state (7-25 copies per reduce).

## Design

- `engine/src/workingCopy.ts`: `runSession(fn)`, `fork(state)`, `cloneState(value)`.
  - `reduce` and `applyIntent` each run inside a session (a fresh `WeakSet` of private objects).
  - `fork(state)` replaces `structuredClone(state)` in the pipeline helpers (chain, cleanup, combat, effects, keywords, movement, mulligan, phases, play, reducer, resources, scoring, showdown, triggers). Inside a session a state that the session already copied is returned as is (no copy); any other state is copied and registered. Outside a session `fork` is a plain copy, so every exported helper keeps its documented "does not mutate the input" contract (no separate `...InPlace` variants were needed).
  - Nothing is copied up front: the input is never registered as owned, so it is never mutated, and a rejected intent copies nothing. The session ends in a `finally`; the returned state is owned by nobody, so feeding it back into `reduce` copies again.
  - `cloneState` is a hand-written deep copy for plain data (falls back to `structuredClone` for Map/Date/class instances): 0.046 ms vs 0.175 ms on a 17 KB state (3.8x). Used by `fork` and for the small item/targets/choices copies in play/chain.
- `runCleanup` serialises the state once per pass (the end-of-pass snapshot is the next pass's start snapshot). `checkWin`/`syncTurnState`/`pushPendingItem`/`finalizeItem`/`payCost` no longer copy inside a session.
- `getLegalActions` memoises `autoPlan` per (energy, power) cost within one call; `autoPlan` already returned null for unaffordable costs, which skip PLAY_CARD candidate building.
- Not done: `reduceTrusted`. Shape validation is negligible and the handler must validate anyway, so there is nothing worth skipping.
- Rule for helper authors (also in workingCopy.ts): inside the pipeline a helper may receive a state it can mutate, so never keep a reference to "the old" state and read it after calling another helper with the same object.

## Measurements (`npx tsx scripts/bench-reduce.ts`, 728 reduce calls on mid-game states of 8 seeded random games on the preset decks; loaded machine)

| metric                                      | before                        | after                         |
| ------------------------------------------- | ----------------------------- | ----------------------------- |
| reduce ms p50 / p90 / p99 / max             | 1.535 / 5.048 / 6.840 / 7.411 | 0.320 / 0.878 / 1.654 / 2.218 |
| structuredClone per reduce p50/p90          | 7 / 24                        | 0 / 0                         |
| getLegalActions ms p50 / p90 / p99          | 1.774 / 14.713 / 22.246       | 0.463 / 2.400 / 3.033         |
| structuredClone per getLegalActions p50/p90 | 7 / 82                        | 0 / 0                         |

(An earlier, quieter before run measured reduce p50 2.438, p99 15.786, getLegalActions p50 3.474.) The digest of all 823 state hashes is identical before and after (`192590ee070add`).

`npx tsx scripts/profile-ai.ts --games 12 --maxTurns 40 --seed x2` (production bot settings), search decisions:

| metric (ms)                                 | before (R29)                | after                             |
| ------------------------------------------- | --------------------------- | --------------------------------- |
| decision p50 / p90 / p99 / max              | 27.5 / 63.0 / 106.4 / 164.3 | 7.4 / 17.9 / 30.6 / 33.7          |
| getLegalActions in decision p50 / p99       | 8.7 / 27.0                  | 1.6 / 4.2                         |
| search p50 / p99                            | 19.1 / 85.7                 | 5.5 / 26.9                        |
| standalone getLegalActions p50 (T4-7 / T8+) | 5.5 / 9.1                   | 1.2 / 1.6                         |
| structuredClone / decision                  | 166 (p50), 647 (p99)        | 8 (all from sanitize/determinize) |

Remaining profile: ~29% `snapshot` (JSON.stringify change detection in cleanup), ~17% `cloneState`, ~13% `unitsAt`.

## Tests (`engine/src/reducePurity.test.ts`, 8 tests)

Input never mutated (JSON compare) over legal + junk + CONCEDE intents on 6 seeded games; deeply frozen input still reduces; rejected intents carry no state; results are private/distinct; `fork` semantics; `cloneState` equals `structuredClone` on game-state fuzz (value, key order, independence, undefined, Map/Date); golden hash chains for 3 seeded scripted games and one bot-vs-bot game, recorded with the pre-R37 engine.

## Residual risks

- A helper that holds the old state and compares after another helper call would now see the same object. All call sites were reviewed; golden hashes and purity tests agree.
- If an internal step errors midway (`phaseCleanup`, `toHook` fall back to their input), the working copy may be partly mutated. The result is then an error with no state, and these paths are unreachable on legal states.
- Shared references in a state would be split by `cloneState` (GameState is a tree; fuzz-checked).
