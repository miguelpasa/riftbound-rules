# Progress by task

All 43 planned tasks are complete on branch `feat/foundation`. See [REMAINING.md](../REMAINING.md) for what is left.

Verification at the last commit: 435 engine tests, 298 client tests, 6 Playwright specs, typecheck, lint and the rule-citation check all pass.

| ID            | Task                                                | Complexity | Model                                | Status | Commit    |
| ------------- | --------------------------------------------------- | ---------- | ------------------------------------ | ------ | --------- |
| [F1](F1.md)   | Monorepo scaffold                                   | Low        | Haiku                                | Done   | `ad9d45a` |
| [F2](F2.md)   | Shared type contract and protocol                   | Medium     | Sonnet                               | Done   | `769c2e4` |
| [D1](D1.md)   | Card dataset fetch script                           | Low        | Haiku                                | Done   | `357a7dc` |
| [D2](D2.md)   | Card converter                                      | Medium     | Sonnet                               | Done   | `357a7dc` |
| [D3](D3.md)   | Fixture cards and decks                             | Low        | Haiku (merged into E1)               | Done   | `2a8cde2` |
| [E1](E1.md)   | RNG, setup, deck validation, mulligan               | Medium     | Sonnet                               | Done   | `2a8cde2` |
| [E2](E2.md)   | Runes, Rune Pool, costs, payment                    | High       | Sonnet                               | Done   | `e3750a2` |
| [E3](E3.md)   | Phase machine and Burn Out                          | High       | Sonnet                               | Done   | `c2201f0` |
| [E4](E4.md)   | Chain, priority, focus, timing                      | High       | Sonnet                               | Done   | `3ad67ae` |
| [E5](E5.md)   | Play-a-card pipeline                                | High       | Sonnet                               | Done   | `c2201f0` |
| [E6](E6.md)   | Movement, contested battlefields, showdowns         | High       | Sonnet                               | Done   | `e62137a` |
| [E7](E7.md)   | Combat                                              | High       | Sonnet                               | Done   | `3a0cae1` |
| [E8](E8.md)   | Scoring and win check                               | Medium     | Sonnet                               | Done   | `ceac351` |
| [E9](E9.md)   | Cleanup loop with circuit breaker                   | High       | Sonnet                               | Done   | `0d9fb25` |
| [E10](E10.md) | MVP keywords                                        | Medium     | Sonnet                               | Done   | `3a0cae1` |
| [E11](E11.md) | Reducer, validator, legal actions, invariants, fuzz | High       | Sonnet                               | Done   | `81d953e` |
| [E12](E12.md) | State sanitizer and leak checker                    | Medium     | Sonnet                               | Done   | `c398a72` |
| [E13](E13.md) | Rule scenarios and replay                           | Medium     | Sonnet                               | Done   | `370da14` |
| [N1](N1.md)   | Transport layer                                     | Medium     | Sonnet                               | Done   | `0269cb4` |
| [N2](N2.md)   | HostSession and GuestSession                        | Medium     | Sonnet                               | Done   | `a92a82b` |
| [N3](N3.md)   | Event-sourced persistence and legal hints           | Medium     | Sonnet                               | Done   | `813da52` |
| [N4](N4.md)   | Replay recorder and player                          | Low        | Haiku                                | Done   | `48d6e7e` |
| [N5](N5.md)   | Turn and reaction timers                            | Low        | Haiku                                | Done   | `48d6e7e` |
| [N6](N6.md)   | AI bot and Web Worker                               | Medium     | Sonnet                               | Done   | `370da14` |
| [C1](C1.md)   | Client scaffold                                     | Low        | Haiku                                | Done   | `8f68a02` |
| [C2](C2.md)   | Lobby, app flows, adapters, timer wiring            | Medium     | Sonnet                               | Done   | `60f342f` |
| [C3](C3.md)   | Card component                                      | Medium     | Sonnet                               | Done   | `370da14` |
| [C4](C4.md)   | Playmat and GameScreen                              | High       | Sonnet                               | Done   | `d045335` |
| [C5](C5.md)   | Resource panel                                      | Medium     | Sonnet                               | Done   | `304f924` |
| [C6](C6.md)   | Chain inspector                                     | Medium     | Sonnet                               | Done   | `304f924` |
| [C7](C7.md)   | Combat dialog                                       | High       | Sonnet                               | Done   | `304f924` |
| [C8](C8.md)   | Small UI components                                 | Low        | Haiku                                | Done   | `a0cdf9b` |
| [T1](T1.md)   | Tutorial framework                                  | High       | Sonnet                               | Done   | `60f342f` |
| [T2](T2.md)   | Lesson 1: turn structure                            | Low        | Haiku                                | Done   | `1e312a6` |
| [T3](T3.md)   | Lesson 2: resources                                 | Medium     | Sonnet                               | Done   | `1e312a6` |
| [T4](T4.md)   | Lesson 3: zones and movement                        | Medium     | Sonnet                               | Done   | `1e312a6` |
| [T5](T5.md)   | Lesson 4: the Chain                                 | Medium     | Sonnet                               | Done   | `1e312a6` |
| [T6](T6.md)   | Lesson 5: showdowns and combat                      | Medium     | Sonnet                               | Done   | `1e312a6` |
| [T7](T7.md)   | Lesson 6: victory and Final Point                   | Medium     | Sonnet                               | Done   | `1e312a6` |
| [D4](D4.md)   | Preset decks from real data                         | Medium     | Sonnet                               | Done   | `370da14` |
| [Z1](Z1.md)   | Playwright end-to-end suite                         | Medium     | Sonnet                               | Done   | `13bbf08` |
| [Z2](Z2.md)   | README and architecture docs                        | Low        | Haiku                                | Done   | `13bbf08` |
| [Z3](Z3.md)   | Rules audit and fixes                               | Medium     | Sonnet (read-only audit, then fixes) | Done   | `ee4eaff` |

## Work after the original plan

| ID                                | Task                                                         | Model  | Status |
| --------------------------------- | ------------------------------------------------------------ | ------ | ------ |
| [A-prime](A-prime-deck-import.md) | Import decks from the deckbuilder JSON (`riftbound-deck` v1) | Sonnet | Done   |
| [B](B-more-effects.md)            | More card effects and parser (118 fully supported cards)     | Sonnet | Done   |
| [E](E-keyword-check.md)           | Keyword rules check against the official PDF                 | Haiku  | Done   |
| [F](F-small-cleanups.md)          | R21, R22, R23, R27, R31, R32                                 | Haiku  | Done   |

Earlier in this phase (done by the lead, no separate file): effect DSL slices 1 and 2, target selection, spell parser, kill/ready/mass buff, Burn Out and heal fixes (R12/R13 part), Equip on the Chain (R9), Universal Power (R10), triggered abilities (R5 first slice), Pass-button banner fix. See the session log in [../REMAINING.md](../REMAINING.md).

| ID                                   | Task                                                                                                 | Model  | Status      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------ | ----------- |
| [R36](R36-keyword-fixes.md)          | Keyword mismatch fixes (Equip cost, Quick-Draw, Hidden gear, Temporary/Deflect on gear, Hide timing) | Sonnet | Done        |
| [R2](R2-click-to-target.md)          | Click-to-target on the board                                                                         | Sonnet | Done        |
| [R11-R13](R11-R13-showdown-order.md) | Turn player chooses staged showdown order; Tank+Backline choice                                      | Sonnet | Done        |
| [R29](R29-ai-profiling.md)           | AI profiling and tuning on real decks                                                                | Sonnet | Done        |
| [R6a](R6a-legion-disarm.md)          | Legion tracking (Disarm blocked)                                                                     | Haiku  | Partial     |
| [B2](B2-more-effects.md)             | Parser round 2: tokens, choose-a-unit, return/move to base, look at top                              | Sonnet | Done        |
| R17 audit                            | Browser audit (docs/BROWSER_AUDIT.md)                                                                | Haiku  | In progress |
| [R37](R37-reduce-performance.md)     | Engine reduce performance (working copy, reduce p50 1.5 -> 0.32 ms) | Medium | Sonnet | Done | `e909ed3` |
| [R39a](R39a-tutorial-ui.md)          | Tutorial UI audit fixes (A-01,02,03,05,06,09,11)            | Medium | Sonnet | Done | `e909ed3` |
| [R39b](R39b-deck-card-ui.md)         | Deck picker and card UI audit fixes (A-04,07,08,10,12,13)   | Medium | Sonnet | Done | `e909ed3` |
| [R40](R40-ability-ui.md)             | Activate abilities from the UI (Gold, Seals), Gold in gear row, Legion cost display | Medium | Sonnet | Done | uncommitted |
