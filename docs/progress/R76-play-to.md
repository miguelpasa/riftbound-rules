# R76: "You may play me to an open / occupied enemy battlefield"

Status: done. Fully supported cards 427 -> 431 of 1103 (`npm run cards` full count). Engine 826 tests (+4), client 426, scripts 31; typecheck, lint, check:rules green. One bot-timing test (conditions.test 'the bot copes') failed once under load and passed on re-run.

## What changed

- `CardDef.playTo: ('OPEN' | 'ENEMY')[]`, parsed from the lines "You may play me to an open battlefield." / "... an occupied enemy battlefield." (`parsePlayTo`, kept only when the card is otherwise fully supported; schema updated).
- `playToAllowed` (play.ts) widens the location check; `getLegalActions` lists those battlefields as PLAY_CARD locations.
- A Unit played to a battlefield that its player does not control and that the opponent has no units on now contests it (like a move there), so the Cleanup stages the Showdown and the player takes control and conquers. Playing next to enemy units stages a Combat through the existing both-players-present rule.

## Not done

- "I can be played to a battlefield you're attacking" (Rengar) and units that need more text (Ocean Drake's return, Miss Fortune).

