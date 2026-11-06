# R60: Spend XP ability costs

Status: done (engine, parser, client text). Fully supported cards 344 -> 347 of 1103 (`convertRow` count). Engine 754 tests (+3), client 426, scripts 30; typecheck, lint, check:rules green.

## What changed

- `AbilityCost.xp`, event `XP_SPENT`; `activateAbility` refuses without enough XP, pays it, and `abilityCandidates` does not offer an unaffordable ability.
- Parser: "Spend N XP" as a cost part ("Spend 2 XP: [Buff] me.", "Spend 3 XP, [E]: ..."); client ability text shows "N XP".
- Cards now full: Crowd Favorite, Enthralling Protector, Blood Rose.

## Not done

Optional spend-XP triggers, spend-XP additional costs, Legend abilities, spend-a-buff.
