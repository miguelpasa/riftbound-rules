# R92: Tentacle tokens, "when I score", "when an opponent scores"

Status: done. Fully supported cards 492 -> 495 of 1103 (`npm run cards` full count). Regression diff: no card lost or changed, 3 gained. Engine 888 tests (+3).

## What changed

- Tentacle token (1 Might); "a [1] [M] ... token from Bilgewater" token phrasing.
- Trigger `OPP_SCORES` (from `POINT_GAINED` of the other player) and the head "When you play me or when I score" (read as play, Hold or Conquer).

