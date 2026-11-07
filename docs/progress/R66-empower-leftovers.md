# R66: Empower leftovers

Status: done (parser). Fully supported cards 365 -> 368 of 1103 (`convertRow` count): Escaped Grayback, Baccai Witherclaw, Noxian Emissary. Engine 768 tests (+1); all checks green.

## What changed

Parser only: kill-cost Empower abilities and the Empowered Deathknell icon form (see ASSUMPTIONS R66).

## Measurement

`m65.ts unit` (scratchpad) lists unit cards with a single unparsed piece; Empower leftovers were the largest shared family there.
