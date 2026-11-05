# R39a: tutorial and game UI fixes (audit A-01, A-02, A-03, A-05, A-06, A-09, A-11)

Verified in a real Chromium (Playwright, dev server) plus jsdom tests. Screenshots: `docs/audit-screenshots/fix-A-NN-*.png`.

## A-01 (High) combat dialog covered the guide
- Fix: in `LessonRunner` the game sits in a column with `transform-gpu` (a transform makes it the containing block for `position: fixed` descendants). The combat dialog backdrop, concede dialog, game-over modal and toasts now cover the board column only; the guide (z-40, outside that column) stays clickable. The scroller is an inner `overflow-auto` div so the overlays do not scroll away. The dialog itself still blocks clicks to the board.
- Files: `client/src/tutorial/LessonRunner.tsx`.
- Verified: Playwright script and new e2e test click "Next step" with a real mouse while the damage dialog is open (`fix-A-01-dialog-guide-clickable.png`).

## A-02 (High) game-over modal covered Finish/Next in lesson 6
- Fix: same containment as A-01. The "Game over: You win!" modal covers the board only; "Next step" then "Continue" complete the lesson.
- Verified: script skipped to the last conquer step, moved the Grunt, passed, clicked Next step and Continue by mouse and reached "Lesson complete" (`fix-A-02-gameover-guide-clickable.png`).

## A-03 (High) guide pushed the board off-screen at 390 px
- Fix: the guide is `order-2` bottom sheet (`max-h-[45vh]`) below `md` (768 px) with a "Hide guide / Show guide" toggle (`aria-expanded`, `aria-controls`) showing the step title; side column at `md+`. It reopens automatically on a new or completed step so "Next step" is never hidden.
- Files: `client/src/tutorial/LessonRunner.tsx`.
- Verified: `fix-A-03-tutorial-390.png`, `fix-A-03-tutorial-390-collapsed.png`, no horizontal overflow; new e2e test at 390 px; jsdom test for the toggle.

## A-05 header clipped at the top
- Cause: Spotlight scrolled the board wrapper (about 292 px) to reveal a target in the Base; the header scrolled away.
- Fix: the game header is `lg:sticky lg:top-0 lg:z-20` (opaque background), so scoreboard, phase tracker, priority text and Concede stay visible while the board scrolls. Spotlight now only calls `scrollIntoView` when the first target is entirely off-screen.
- Files: `client/src/game/GameScreen.tsx`, `client/src/tutorial/Spotlight.tsx`.
- Verified: `fix-A-05-tutorial-header-1280.png` (header fully visible although the board is scrolled).
- Note: the spotlight dimming layer still darkens the header (it is not a highlight target), by design.

## A-06 lesson 5 hint did not work
- Fix: new optional `GameScreen` prop `additiveSelection` (passed by the tutorial runner) forwarded to `useBoardUi(api, { additiveSelection })`; plain unit clicks toggle membership of the selection. Normal games are unchanged (Ctrl/Shift/Cmd still additive, plain click replaces). Hint text updated in `lesson5.ts`.
- Files: `client/src/game/GameScreen.tsx`, `client/src/game/useBoardUi.ts`, `client/src/tutorial/LessonRunner.tsx`, `client/src/tutorial/lessons/lesson5.ts`.
- Verified: jsdom test (additive vs default), e2e test that clicks Raider, Grunt, then the battlefield, and `fix-A-06-both-selected.png`.

## A-09 raw markdown in notes
- Fix: `renderInline` supports `*italic*` (new `<em>`) besides `**bold**` and code; coach notes (`say`) now render through `Md`. No `dangerouslySetInnerHTML`. A lone `*` such as `2 * 3 * 4` is left alone.
- Files: `client/src/tutorial/Markdown.tsx`, `client/src/tutorial/LessonRunner.tsx`.
- Verified: unit test; lesson 5 note shows bold total and lesson 6 shows italic "every" (screenshots).

## A-11 Concede focus
- Fix: closing the Concede dialog (Escape or "Keep playing") returns focus to the Concede button (ref and effect in `GameScreen`); the dialog traps Tab / Shift+Tab inside its two buttons.
- Files: `client/src/game/GameScreen.tsx`.
- Verified: jsdom test and a browser check (focus after Escape is the Concede button; Tab cycles inside the dialog).

## Tests
- `client` vitest: 370 pass (new: concede focus and trap, additive selection, markdown, guide toggle). typecheck and lint clean.
- e2e: `tutorial.spec.ts` (3 tests, 2 new) and `solo.spec.ts` pass. Occasional spurious failures were caused by parallel agents (trace file ENOENT in the shared `test-results` dir, engine edits in flight), not by these changes; re-runs were green.

## Not verified
- Screen readers (focus trap only checked via DOM focus). Tablet widths 768 to 1023 px (no sticky header there, guide is side-by-side). Multiplayer GameScreen use (the new props default off).
