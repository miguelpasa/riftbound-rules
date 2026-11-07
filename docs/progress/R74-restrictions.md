# R74: Restrictions: no combat damage, can't be chosen by enemies, only-at-battlefield abilities, damage equal to my Might

Status: done. Fully supported cards 406 -> 420 of 1103 (`npm run cards` full count). Engine 816 tests (+9), client 426, scripts 31; typecheck, lint, check:rules green; golden hashes unchanged.

## What changed

- Static `restrict: 'NO_COMBAT_DAMAGE' | 'NO_ENEMY_CHOOSE'` with `unless` (a condition that lifts it) and `lessMight` (only weaker units), new scopes `ENEMY_UNITS_HERE` / `FRIENDLY_UNITS_HERE`. `staticBonus` reports `noCombatDamage` / `noEnemyChoose`; combat's damage total skips such units and enemy target legality (`legalForSpec`) rejects protected units.
- Condition `IN_COMBAT`; parser conditions "there's a friendly gear/unit here" and "I'm at a battlefield with exactly one other unit you control".
- `ActivatedAbility.atBattlefield` ("Use this ability only while I'm at a battlefield"), checked on activation.
- `DAMAGE_TARGET.amountFrom` ('MY_MIGHT' / 'MY_ASSAULT' / 'MY_SHIELD'): "Deal damage equal to my Might / [Assault] / [Shield] to ...".
- "I must be assigned combat damage last" = Backline as a static keyword.
- Level- or Empowered-gated restrictions use the gate as the static's `when`.

## Not done

- "Can't be dealt damage unless I'm in combat", "prevent all damage ...", damage-prevention shields, "You ignore [Tank] while assigning".

