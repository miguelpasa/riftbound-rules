# R87: Excess combat damage conditions and "deal that much"

Status: done. Fully supported cards 477 -> 481 of 1103 (`npm run cards` full count). Engine 873 tests (+4), client 426, scripts 31. Regression diff: no card lost or changed, 4 gained. Golden hashes unchanged (excess is tracked only when a card needs it).

## What changed

- `CombatState.excess` and `PlayerState.excessRecord`: when the attacker assigns combat damage the excess over what each enemy unit still needed is summed; at resolution it is stored for the turn. Tracked only when some card reads it (`tracksExcess`).
- Condition `EXCESS_DAMAGE {n}` and `DAMAGE_TARGET.amountFrom: 'EXCESS'`; parser: "if you assigned N or more excess damage [to enemy units]", "deal that much to ...", "When I conquer after an attack" (read as a Conquer).

## Not done

- Excess assigned by the defender, per-unit excess, abilities that reference it outside Conquer.

