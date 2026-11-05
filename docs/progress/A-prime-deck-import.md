# A-prime: Deck import (R16, reduced scope)

|        |                                   |
| ------ | --------------------------------- |
| Status | Done (not committed by this task) |

## What was delivered

Import of full lists of decks from the external deck builder's JSON, with multi-deck storage and UI. No
deck builder was written.

- `client/src/decks/deckImport.ts`: pure `importDecks(input, cards)` returning `{ fatal, entries }`; each
  entry has `ok`, `deck`, `meta`, `errors`, `warnings`. Accepts a deck object, an array, `{ decks }` and our
  own `DeckList`. `makeCardResolver(cards)` maps codes to card ids. `deckSupportStats` counts full/partial.
- `client/src/decks/deckStorage.ts`: `listImportedDecks`, `saveImportedDeck`, `renameImportedDeck`,
  `deleteImportedDeck` (key `riftbound.importedDecks`). The old single `riftbound.customDeck` slot is
  migrated once into the list under the id `custom` so remembered selections keep working.
- `client/src/app/DeckPicker.tsx`: imported decks are radios in the `Decks` radiogroup (name, legend,
  event/placement, "N/M cards fully implemented" badge and warning icon for partial cards, Rename, Delete),
  a file input and paste box, and an import result summary listing each failed deck's errors.
- Tests: `deckImport.test.ts` (23), `app/DeckPicker.test.tsx` (13); fixtures in
  `decks/importFixtures.ts` re-key the engine fixture cards to `tst-NNN-100` ids (no real card data).

## Card code mapping (assumptions)

- Code `SET-NNN[x]` matches ids `set-NNN[x]-total` case-insensitively, ignoring the total. Alias keys
  (non-enumerable on the loaded database) resolve to their canonical id.
- A code with a letter prefers an exact-letter match; otherwise letterless (base) ids win; then lettered
  variants; then the lowest id. If several distinct ids remain, a matching `name` breaks the tie.
- A name that differs from the resolved card is a warning, not an error.
- The champion counts toward the 40-card minimum as in `validateDeck`; the share format lists it
  separately in `CHAMPION`, which maps directly.
- `legend` overrides the LEGEND card. Exactly one CHAMPION copy is required.

## Known gaps

- Token-style ids (`unl-t01`, `ven-t04`) cannot be addressed by a numeric code.
- Metadata (`description`, `sourceUrl`) is stored but not displayed.
- Duplicate imports create duplicate entries (no de-duplication by content).
- No export of decks, no in-app deck editing.
- Not tested against the real `cards.json` (generated and gitignored) or the deck builder's meta decks.
