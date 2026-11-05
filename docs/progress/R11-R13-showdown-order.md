# R11 + R13 (part): staged Showdown order and Tank+Backline

|        |                                                         |
| ------ | ------------------------------------------------------- |
| Status | Done in code and tests; host timeout hook still to wire |

## R11: turn player chooses which staged Showdown/Combat starts first (323.11, 323.12, 463.1)

Design of the pending-choice state:

- `FlowState.pendingChoice?: { kind: 'STAGED_ORDER'; player; stage: 'SHOWDOWN' | 'COMBAT'; options: string[] }` (types/chain.ts). `player` is the turn player, `options` are the staged battlefield ids (at least two) in battlefield index order.
- `runCleanup` (cleanup.ts, steps 9/10) recomputes it every pass: it is deleted first, then set again when more than one Showdown (323.11, Combat-staged battlefields excluded) or, failing that, more than one Combat is staged in Neutral Open. In that case nothing starts. The next pass changes nothing, so the Cleanup stabilises normally (idempotent, no circuit breaker, no events). With one candidate it starts as before and nothing is asked.
- New intent `CHOOSE_STAGED { playerId, battlefieldId }` -> `showdown.chooseStaged`: validates (pending set, `NOT_YOUR_TURN` for the wrong player, `ILLEGAL_TARGET` for a battlefield not in `options`), clears the choice, emits `STAGED_ORDER_CHOSEN { player, battlefieldId, stage }`, then starts that Showdown (applier = contestedBy ?? turn player) or Combat (`deps.startCombat`). The trailing Cleanup continues and asks again if several remain.
- While `pendingChoice` is set `applyIntent` rejects every intent except `CHOOSE_STAGED` and `CONCEDE` with `WRONG_PHASE` (so also rune activations, PASS_PRIORITY, END_TURN).
- `actorToAct` returns `pendingChoice.player`. `getLegalActions` returns only that player's `CHOOSE_STAGED` options (other player: `[]`). `validateIntent` works unchanged (it runs `reduce`). `sanitizeFor` already clones `flow`, so both players see the pending choice (public information).
- Replay/persistence: `CHOOSE_STAGED` is a normal intent in the log (added to `client/src/net/protocol.ts` and `client/src/host/replayLog.ts` intent lists); the reducer is deterministic so logs replay. There is a replay-determinism test.
- UI: `client/src/components/ChoicePrompt.tsx`, mounted in `GameScreen` next to `CombatDialog`. The deciding player gets a modal "Choose which battlefield resolves first" with one button per option (`aria-label="Resolve <name> first"`); the other player sees a non-interactive waiting notice (`role="status"`). `describeEvent` covers `STAGED_ORDER_CHOSEN`.
- Bot: `getLegalActions` returns the CHOOSE_STAGED intents, so the generic bot already decides (test in `showdownOrder.test.ts`; it goes through the search path and picks one). No bot change needed. An explicit heuristic (for example prefer the battlefield where it has more Might) would be an optional improvement.
- Host timeout: not wired (hostTimers.ts / timers.ts were read-only for this task). Without a turn clock nothing is armed for this situation, so a human who never answers stalls the game, the same as an idle Main phase. Suggested patch in `hostTimers.ts` `timedOut`: when `state.flow.pendingChoice` is set and the fallback finds nothing, `forceIntent(player, { type: 'CHOOSE_STAGED', playerId, battlefieldId: pendingChoice.options[0] })` (lowest index), and arm a REACTION-length timer for it in `timerSituation` (for example by reporting `showdown: true` while `pendingChoice` is set).

## R13 (part): Tank + Backline (467.2.c.8)

- `computeAssignmentConstraints(state, cards, assigner, tierOverrides?)` marks a unit that has both keywords `dual: true` (listed as TANK by default; `autoAssign` unchanged and still valid).
- `checkAssignment` accepts an assignment if it is legal for ANY Tank/Backline choice per dual unit (2^k combinations, k capped at 6, otherwise default-Tank only). The error returned for an illegal assignment is the default-Tank one. All other assignment rules are unchanged.
- Client mirror `client/src/components/combat/damage.ts`: `OrderedUnit.dual`, `isDualTier`, `validateAssignment` tries the same combinations; CombatDialog shows "Tank or Backline" and explains it.

## Tests

- `engine/src/showdownOrder.test.ts` (20): pause, idempotence, single candidate, choose non-lowest, three battlefields (asks again), Combat stage, rejection of other intents, chooser/option validation, legal actions, views, replay, bot, stale choice, Tank+Backline cases.
- `engine/src/cleanup.test.ts`: the old "lowest index" test now expects the pending choice.
- `client/src/components/ChoicePrompt.test.tsx` (4, jsdom), `damage.test.ts` +1 (view vs engine for a dual unit), `describeEvent.test.ts` sample.
