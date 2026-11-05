# R39b: deck picker and card UI fixes (audit A-04, A-07, A-08, A-10, A-12, A-13)

|        |                                   |
| ------ | --------------------------------- |
| Status | Done (not committed by this task) |

Tests: client 370 pass (was 354 before this and parallel work), typecheck, lint, `build -w client` clean;
e2e smoke, solo, images-blocked pass. Screenshots: `docs/audit-screenshots/fix-A-*.png`.

## A-04 low-coverage warning

- Fix: `isLowSupport` (below `LOW_SUPPORT_THRESHOLD` = 60% of all deck cards fully implemented). The picker shows a "Low coverage"
  tag on the row and, for the selected deck, a `role=status` notice "Many cards in this deck have no effect yet (N of M ...)
  You can still play it" directly above Difficulty and Start game. It does not block starting.
- Files: `client/src/app/DeckPicker.tsx`, `client/src/decks/deckImport.ts`.
- Verified: unit tests (DeckPicker.test, deckImport.test); browser at 390 px with a 13/56 deck
  (`fix-A-04-low-warning-390.png`), game starts normally.

## A-07 duplicate import

- Fix: `deckContentKey` (FNV-1a hash of legend, champion, sorted main/rune/battlefield lists). `runImport` skips decks whose
  key matches a stored deck or an earlier deck in the same file, lists them in an "Already imported" notice in the import
  result, and selects the existing deck. Replace was not added (skip + notice only). Count text becomes e.g. "Imported 0 of 1 deck."
- Files: `DeckPicker.tsx`, `deckImport.ts`. Verified: unit tests; browser (`fix-A-07-duplicate-390.png`).

## A-08 coverage vs badge

- Cause: `deckSupportStats` and preset stats counted only champion + main deck (so a partial Legend/Battlefield never showed in the
  picker, which said 40/40), while the in-game badge flags every card. Compact cards said "Not implemented", others "Effect not implemented".
- Fix: stats now count legend, champion, main, battlefields and runes (presets show e.g. 52/56, new `stats.totalCount`).
  One wording everywhere: "Effect not implemented" (`PARTIAL_LABEL`), tooltip `PARTIAL_TOOLTIP`, picker tooltip `PARTIAL_WARNING`.
  Preset ordering now uses the honest count.
- Files: `deckImport.ts`, `presets.ts`, `fixtureDecks.ts`, `Card.tsx`, `DeckPicker.tsx`, tests. Verified: tests, browser picker and in-game badges.

## A-10 favicon

- `client/public/favicon.svg` (simple diamond, no Riot art) and `<link rel="icon">` in `client/index.html`. Verified: served 200, no console errors on load.

## A-12 Rename / Delete targets

- Now bordered buttons, `min-h-11 min-w-11` (44 px) below the `sm` breakpoint, compact from `sm` up. Rename input and "Save name" got the same
  treatment. Role, names (`Rename <deck>`, `Delete <deck>`) unchanged. Verified: measured 44 px high in the browser at 390 px.

## A-13 clipped compact card text

- The silent `line-clamp-3` is gone; the text area fills the card. When the rules text overflows (measured with scrollHeight), a "... More"
  button appears; it opens an in-card scrollable overlay with the full text and a Close button (Escape also closes; click does not
  select the card). Works by tap, unlike the hover-only card detail (which is `lg` and up only, in GameScreen). Button/overlay labels
  contain no card name, so name-based locators are unaffected.
- Files: `client/src/components/Card.tsx`, `Card.test.tsx`. Verified: unit tests (mocked scroll heights), browser at 390 px (`fix-A-13-*.png`).

## Not verified / notes

- The "More" detection depends on real layout, so it is untested in jsdom except with mocked sizes; checked in Chromium only.
- A mobile card-detail view on tap (GameScreen) is still missing; the in-card overlay is the workaround.
- A first e2e run hit a shared `test-results` trace collision with another agent; rerun with a separate `--output` passed.
