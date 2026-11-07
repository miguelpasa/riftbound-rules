# R75: Return from Trash to hand, buff up to N units, ready enemies, ready a legend

Status: done. Fully supported cards 420 -> 427 of 1103 (`npm run cards` full count). Engine 822 tests (+6), client 426, scripts 31; typecheck, lint, check:rules green.

## What changed

- Targeted effect `RETURN_FROM_TRASH {what: unit|gear|unitOrGear|spell, subtypes?}`: the target spec has a new `trash` kind (cards in the controller's own Trash, filtered by type and subtype), so triggers, abilities and spells can choose them. The client already lists non-board trigger targets by name and spell variants carry their target names in the play popover.
- Parser: "Return a unit / gear / spell / Bird, Cat, Dog, or Poro from your trash to your hand" (also "you may"), "Buff up to N (other) friendly units", "Ready all enemy units", "Ready a friendly legend".

## Not done

- Playing a card from the Trash ("ignoring its cost"), returning from both players' Trashes ("Shadows of the Past"), a choice of cards from several Trashes.

