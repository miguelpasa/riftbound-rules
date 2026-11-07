# R96: Look at the top cards with type and cost limits, rest to the Trash

Status: done. Fully supported cards 504 -> 508 of 1103 (`npm run cards` full count). Regression diff: no card lost or changed, 4 gained. Engine 904 tests (+4).

## What changed

- `LOOK_TOP.take` now accepts `filter` unit / gear / spell / unit-or-gear plus `maxEnergy`, `minEnergy`, `maxPower`; `rest: 'TRASH'`. Parser: "You may reveal [from among them] a unit or gear / spell with Energy cost ... and draw it", "Draw one and recycle the other", "You may choose a card from among them and draw it. Put the rest into your trash."

