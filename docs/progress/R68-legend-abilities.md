# R68: Legend activated abilities

Status: done (engine, converter). Fully supported cards 374 -> 378 of 1103 (`convertRow` count): Blind Monk, Herald of the Arcane, Bounty Hunter and one more Legend. Engine 773 tests (+2); all checks green; Playwright smoke, solo, abilities pass on a temporary port.

## What changed

`activateAbility` and `abilityCandidates` accept a source in the Legend zone; the converter lets Legends carry parsed abilities (plus YOU_PLAY triggers).

## Not done

See ASSUMPTIONS R68.
