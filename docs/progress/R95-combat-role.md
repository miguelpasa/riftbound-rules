# R95: Combat-role statics and "Stun an attacking unit"

Status: done. Fully supported cards 501 -> 504 of 1103 (`npm run cards` full count). Regression diff: no card lost or changed, 3 gained. Engine 900 tests (+4).

## What changed

- Condition `COMBAT_ROLE {role, alone?, withOther?}`: "While I'm attacking or defending alone", "while I'm attacking with another unit" (read live from the combat in progress).
- `STUN_TARGET.attacking`: "Stun an attacking unit" targets only attackers of the current combat.

