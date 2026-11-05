# F-small-cleanups: R21, R22, R23, R27, R31, R32

|        |                                                    |
| ------ | -------------------------------------------------- |
| Status | Done (six small items; not committed by this task) |

## Summary

| Task                                        | Status | Files                                                                                                                                                                                              | Tests                                                              |
| ------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| R21 Solo difficulty in the saved header     | Done   | `client/src/host/persistence.ts`, `client/src/app/hostGame.ts`, `client/src/app/hostGame.test.ts`                                                                                                  | +2 in `hostGame.test.ts`                                           |
| R22 Replay viewer: full event list per step | Done   | `client/src/host/replayLog.ts`, `client/src/app/Replays.tsx`, `client/src/host/replayLog.test.ts`                                                                                                  | +1 in `replayLog.test.ts`                                          |
| R23 Public `CARD_HIDDEN` on HIDE_CARD       | Done   | `engine/src/keywords.ts`, `engine/src/keywords.test.ts`, `engine/src/scenarios/hidden.test.ts`, `client/src/game/describeEvent.ts`, `client/src/game/describeEvent.test.ts`, `docs/ASSUMPTIONS.md` | updated 2 existing tests, `describeEvent.test.ts` samples extended |
| R27 Per-turn cap on bot actions             | Done   | `client/src/host/hostSession.ts`, `client/src/host/hostSession.test.ts`, `client/src/app/hostGame.ts`                                                                                              | +1 in `hostSession.test.ts`                                        |
| R31 Bundle size                             | Done   | `client/src/App.tsx`, `client/vite.config.ts`                                                                                                                                                      | build check (no warning)                                           |
| R32 Engine build output                     | Done   | `client/tsconfig.json`, `package.json` (`typecheck` script)                                                                                                                                        | typecheck from clean state                                         |

## R21: solo difficulty in the saved header

- `GameHeader.difficulty?: 'easy' | 'normal'` is optional, so saves written before this change still load.
- `startPersistedHost` takes `difficulty` and writes it to the header. It is removed from the options passed
  to `HostSession.create`.
- `startSoloGame` passes the difficulty through. `resumeSavedGame` uses `header.difficulty`, then the
  `opts.difficulty` fallback, then `'normal'`.
- Tests: a solo game saved as `easy` resumes as `easy` without the option. A header written without the field
  resumes with the fallback option.

## R22: replay viewer shows every event of every step

- The old viewer computed the events of the current step only, and only when the step was reached one at a
  time. Jumping with the slider dropped all earlier steps, and a rejected intent showed nothing without an error.
- `ReplayPlayer` now runs one pass over the log and keeps each step's events (`eventsOf(step)`). The pass uses
  the same setup and `reduce` loop as `replayGame`. It also checks the engine version and the finished flag.
- The viewer shows a scrollable "Replay event list" above the controls: "Step N" and the readable text of every
  logged event of steps 1 to N, filtered per seat with `sanitizeEvents`. The GameScreen log still receives the
  current step's events.
- Test: the per-step events concatenated equal the events of a full replay after setup.

## R23: public CARD_HIDDEN

- `hideCard` emits the private `CARD_PLAYED` (visibleTo the controller, the only event with the cardId) and a
  public `CARD_HIDDEN { player, battlefieldId }` with no card id.
- `hidden.test.ts`: the opponent's events contain exactly one `CARD_HIDDEN` for `bf0`, no `CARD_PLAYED`, and no
  card id. The leak checker passes on that stream.
- `keywords.test.ts`: the opponent sees only `CARD_HIDDEN`; the controller sees `CARD_PLAYED` and `CARD_HIDDEN`.
- `describeEvent.ts` already had the text ("X hid a card at Y"). It also gained text for `EFFECT_STUNNED`,
  `EFFECT_COUNTERED` and `GEAR_KILLED`, which another agent added to the event union while this work was in
  progress (the client build did not compile without them).
- `docs/ASSUMPTIONS.md` now describes the implemented behaviour. The old note saying CARD_HIDDEN was never emitted
  is replaced.

## R27: per-turn cap on bot actions

- `BotOptions.maxActionsPerTurn` (default 400) and `BotOptions.onStalled(message)`.
- The count is per turn number. A new turn resets it and lifts a previous stop. Going over the cap stops the bot
  for the rest of that turn, calls `console.warn` once, and calls `onStalled` once.
- `hostGame.ts` passes `onStalled` to `env.onError`, so the user sees a toast.
- Test: `apply` is stubbed to report success without changing state, which is the no-progress loop. The bot must
  stop, warn once, report once, and make at most cap + 1 decisions.
- Limit: when the bot stops, the solo game stays stuck for that turn. The player can concede or leave. The cap
  is a guard against a bug, not a recovery path.

## R31: bundle size

Measured with `npx vite build` in `client/`. "Before" is the build before any lazy loading or chunking. The
engine changed a little between the two builds (another agent's work), so the AI worker size is not a clean
comparison.

| Chunk                                                 | Before                  | After                     |
| ----------------------------------------------------- | ----------------------- | ------------------------- |
| main `index-*.js`                                     | 627.32 kB (gzip 187.96) | 245.99 kB (gzip 74.61)    |
| `vendor-react-*.js` (react, react-dom, scheduler)     | in main                 | 218.74 kB (gzip 68.27)    |
| `vendor-peer-*.js` (peerjs)                           | in main                 | 86.66 kB (gzip 23.13)     |
| `TutorialApp-*.js` (lazy)                             | in main                 | 65.16 kB (gzip 20.35)     |
| `Replays-*.js` (lazy)                                 | in main                 | 11.65 kB (gzip 4.41)      |
| `CardGallery-*.js` / `mockGame-*.js` (lazy, dev only) | in main                 | 3.92 kB / 2.37 kB         |
| `aiWorker-*.js`                                       | 66.35 kB                | 70.75 kB (engine changes) |
| Chunk-size warning                                    | yes (>500 kB)           | no                        |

- `App.tsx`: the tutorial, saved-games/replay screen, and the `?gallery` and `?mock` screens are `React.lazy`,
  each under a `Suspense` with a plain "Loading..." line. The selectors and behaviour of the screens are unchanged.
- `vite.config.ts`: `build.rolldownOptions.output.codeSplitting` groups react/react-dom/scheduler and peerjs into
  vendor chunks. Lazy loading alone left the main chunk at 533 kB, so the vendor split was needed.

## R32: engine build output

- Root cause: `tsc -b` emitted into both `engine/dist` and `client/dist`. `client/dist` is also the Vite output,
  so `client/dist/App.js` appeared next to the built app. `engine/dist` kept a stale `_proto.test.js` from a
  deleted source file.
- `client/tsconfig.json` is now `noEmit` (type-check only). The engine keeps its ignored `dist` output, which is
  only used for the project references and never for runtime (the engine is imported from `src`).
- The root `typecheck` script is `tsc -b --clean && tsc -b`, so stale engine output is removed before each run.
- Already true and checked: `dist/` is in `.gitignore`; `vitest` configs exclude `dist/**`; `eslint.config`
  ignores `**/dist/**`.
- Verified from a clean state (`engine/dist`, `client/dist`, and both `tsbuildinfo` files deleted): `npm run
typecheck` exits 0, and `npm test` runs. `npm run build -w client` passes with no chunk warning.

## Verification

- `npm run typecheck`: exit 0 from a clean state.
- `npm run lint`: exit 0.
- `npm run check:rules`: passes (453 blocks cite a rule at the last run; the count changes as other agents add
  tests).
- `npm test`: engine 458 tests in 40 files, client 339 tests in 34 files, all passing in the final run. One
  earlier run failed in `engine/src/cardText.test.ts` because of another agent's in-progress `cardText.ts`; it passed
  when re-run alone and in the next run.

## Not done

- Nothing skipped in the six tasks.
- The replay UI has no component test (the viewer is covered through `ReplayPlayer`).
- Not run: the Playwright e2e suite (`npm run test:e2e`). The lazy-loaded screens are the only UI change that
  could affect it.
