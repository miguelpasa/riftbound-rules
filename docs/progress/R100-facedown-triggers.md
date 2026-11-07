# R100: Hide / play-from-face-down triggers (and a fix: hiding is not playing)

Status: done. Fully supported cards 518 -> 520 of 1103 (`npm run cards` full count). Regression diff: no card lost or changed, 2 gained. Engine 920 tests (+5). Round 100 also ran the card smoke test (seed r100, 40 games, 0 failures).

## What changed

- **Fix:** hiding a Hidden card emits a private `CARD_PLAYED` marker; "When you play a card" triggers (YOU_PLAY) used to fire on it. They now ignore it.
- `CARD_PLAYED.fromFacedown` (set by `playHiddenCard` through `CardInstance.faceDownPlay`), `PlayFilter.fromFacedown`, condition `FROM_FACEDOWN` ("When you play me from face down"), trigger `YOU_HIDE` ("When you hide a card").

