# R29: AI performance profiling on real card data

Tool: `npx tsx scripts/profile-ai.ts [--games N] [--mode bvb|bvf] [--budget 500] [--max 60] [--decks presets|meta|both] [--maxTurns 40] [--seed s] [--clones off] [--json out.json]`.
It plays production-setting games (budgetMs 500, maxCandidates 60) on `client/public/cards.json` with 6 generated presets plus the 6 meta decks in `deckbuilder/data/meta-decks` (via `importDecks`), and prints per-phase percentile tables, component split, sizes, budget stats, a standalone `getLegalActions` timing on T4+ states, and `structuredClone` counts with the hottest call sites. `AIController` gained an optional `onProfile` callback (`DecisionProfile`) that is purely observational.

## Findings (24 games bot-vs-bot, 1169 decisions, 864 search decisions, 0 rejected intents)

Games finish in turns 14-19 with 40-58 decisions; legal actions per search decision: p50 10, p99 27, max 33. The 500 ms budget never expired and the greedy fallback never fired.

### Before (unloaded machine), decision wall time in ms

| bucket       | n   | p50  | p90  | p99   | max   |
| ------------ | --- | ---- | ---- | ----- | ----- |
| early (T1-3) | 128 | 21.3 | 41.2 | 67.8  | 73.3  |
| mid (T4-7)   | 271 | 30.1 | 62.9 | 103.5 | 118.8 |
| late (T8+)   | 465 | 41.8 | 80.4 | 133.0 | 249.8 |
| all search   | 864 | 35.6 | 71.0 | 115.3 | 249.8 |

Components (p50 / p99): hash 0.1 / 0.3, determinize 0.4 / 0.9, `getLegalActions` 10.8 / 27.1, search 23.9 / 92.9 ms. Standalone `getLegalActions`: T4-7 p50 6.3 (max 25), T8+ p50 11.6 (max 29.5).

### After

The "after" run happened while other agents were running test suites, so every number was about 1.8x slower, including the untouched `getLegalActions` (p50 10.8 -> 19.7 ms). Wall times are therefore not comparable; the deterministic work counters are:

| metric (p50 / p90 / p99)           | before          | after           |
| ---------------------------------- | --------------- | --------------- |
| candidates scored                  | 10 / 17 / 27    | 9 / 16 / 26     |
| reduce calls per decision          | 14 / 34 / 58    | 12 / 31 / 57    |
| structuredClone calls per decision | 224 / 401 / 590 | 173 / 326 / 531 |

Load-normalised (search time divided by `getLegalActions` time) the search part improved by roughly 10-20%. The budget was also run at 30 ms on real decks: search stops at the deadline, but the fixed pre-search cost (hash + determinize + `getLegalActions`, 12-70 ms) is not interruptible, so budgets below ~100 ms cannot be honoured on real decks. At the production 500 ms the worst decision (250-390 ms depending on load) is inside the budget.

## Changes (only engine/src/ai, client/src/ai, scripts, docs)

- `bot.ts`: duplicate PLAY_CARD intents for copies of the same card (same payment/location/targets) are pruned before scoring; decisions with only PASS/END_TURN legal skip scoring (identical pick); `settle` stops at the budget deadline; the candidate loop also stops when the costliest candidate seen so far would not fit in the remaining time (always scores at least one candidate); the clock covers hash, determinize, legal actions and search; `onProfile` hook.
- `determinize.ts`: visible objects are flat-copied instead of `structuredClone` (about 60 fewer clones per decision).
- `aiClient.ts`: a worker that errors or times out is terminated and discarded; the next `decide` spawns and re-initialises a fresh one (before, a dead worker made every later decision wait the full 5 s timeout). A null answer still makes the host play its own PASS/END_TURN/keep-hand fallback (`hostSession.applyBotFallback`, `mockGame.fallbackIntent`).
- Tests: `bot.test.ts` "performance guards" (virtual-clock budget incl. settle, profile hook is observational, same seed + view gives the same decision); `ai.test.ts` worker restart after `onerror` and after timeout.

## Remaining hot spots (outside my files)

CPU profile of 6 games: 78% of all time is `structuredClone`, i.e. `reduce` copies the whole state many times per call. Share of clone time by call site: `checkWin` (scoring.ts) via `runCleanup` 15%, `syncTurnState` (chain.ts) 14%, `runCleanup` itself 8%+6%, `pushPendingItem` (chain.ts) 7%, `payCost` (resources.ts) 7%, `finalizeItem` 6%, `phaseCleanup` (reducer.ts) 6%, `standardMove` 5%.

Recommended optimisations (each is safe and keeps results identical):

1. `reduce` should clone the state once at entry and let the inner helpers mutate that private copy; `checkWin`, `syncTurnState`, `runCleanup`, `payCost`, `pushPendingItem`, `finalizeItem` each call `structuredClone(state)` again. This alone should cut `reduce` cost several-fold and the bot search roughly proportionally (search is 2/3 of a decision).
2. `runCleanup` loops until stable and clones per iteration; only clone when a cleanup step actually changes something (return the same reference otherwise).
3. `getLegalActions` (about 11 ms p50, 30 ms max, 1/3 of a decision) enumerates payments per card; memoise the rune-payment plans per (rune pool, cost) within one call and skip PLAY_CARD enumeration for cards that cannot be afforded before building payments.
4. Optional later: a `reduce(..., { trusted: true })` mode skipping validation for bot simulations, since candidates come from `getLegalActions`.
