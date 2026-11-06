# R41: targeted triggered abilities and targeted activated abilities

Status: done (engine, parser, bot, client, e2e). Fully supported cards 165 -> 183 of 1103 (`npm run cards` reports 189 because it counts 6 token defs). Engine 594 tests (+14), client 388 (+7), scripts 17; typecheck, lint, check:rules green; Playwright (smoke, solo, tutorial, abilities) 8/8 on a temporary port-5199 config (deleted).

## Measurement (before coding)

A throwaway script over `data/raw/cards.json` listed partial Unit/Gear cards by the single sentence that blocks them. The targeted trigger / ability patterns were:

| Pattern                                                                     | Cards                                                                                                                                |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| "When you play me, give a unit +N [M] this turn" (also -N, enemy)           | War Scout, Field Musicians, Whiteflame Protector, Dangerous Duo (Legion), Riptide Mage, Blastcone Fae (to a minimum of 1)            |
| "When you play me / conquer, <damage, kill, stun, move> a (enemy) unit"     | Riptide Rex, Sandshifter, Harnessed Dragon, Solari Shieldbearer, Maddened Marauder, Inviolus Vox, Bilgewater Tracker (up to 2 units) |
| "[Deathknell][>] Deal 4 to an enemy unit"                                   | Ruined Rex                                                                                                                           |
| "[E]: Give a unit +3 [M] this turn" / "-1 [M] ... to a minimum of 1 [M]"   | Arena Kingpin (with "I enter ready"), Heart of Dark Ice, Orb of Regret                                                               |

All 18 became `full` with the existing chooser sentences (the parser now shares one sentence interpreter between spells, triggers and abilities); the six requested cards are among them. **Iron Ballista stays partial**: its blocker is "This enters exhausted.", not the target.

Remaining top blockers (single-sentence analysis, after this task): `[Weaponmaster]` 4, new trigger moments ("When I attack", "When I become exhausted", "When you play a card ..."), optional "you may" effects with `here` scopes (Mournful Spirit), costs with [C] or discard (Sky Cruiser, Ekko), Bomb tokens, `[Disarm]`, `[Predict]`, Buff. Everything else is a one-off.

## Design

- **Where targets are chosen**: when the trigger is put on the Chain (`fireTriggers`, after the Cleanup), by the controller, using the spell helpers (`enumerateSpellTargets`, plus the new `abilityTargetsLegal` = `spellTargetsLegal` + "no extra targets, objects only").
  - No legal choice: the ability is not put on the Chain; public event `TRIGGER_NO_TARGET`.
  - Exactly one legal choice: taken automatically (item `FINALIZED` with `targets`; public event `TRIGGER_TARGETED`). Deterministic.
  - Several: the item sits on the Chain as `PENDING` and `flow.pendingChoice = {kind: 'TRIGGER_TARGET', player, chainItemId}` blocks every intent except `CHOOSE_TRIGGER_TARGET` and `CONCEDE`. `actorToAct` returns the chooser. With several waiting triggers they are asked in Chain order (the turn player's first). Priority is set as before, so once the last choice is made the other player may respond.
  - `PendingChoice` is now a union (`STAGED_ORDER | TRIGGER_TARGET`); the Cleanup only clears its own `STAGED_ORDER`. The two cannot coexist (a staged order needs an empty Chain).
- **Resolution**: `playResolver` passes `item.targets` to `runEffects` for triggers and activated abilities; `runEffects` already re-checks legality and fizzles (`EFFECT_FIZZLED`).
- **Intent** `CHOOSE_TRIGGER_TARGET {chainItemId, targets}`: validated by `chooseTriggerTarget` (right player, right item, legal targets); rejected with `ILLEGAL_TARGET` and the state unchanged. It is in `getLegalActions` (one per combination, capped by `MAX_TARGET_COMBOS`), the wire protocol table, the replay-log allow-list and the host timeout fallback.
- **Activated abilities**: `ACTIVATE_ABILITY.targets` is validated (`ILLEGAL_TARGET`) before the cost is paid and stored on the `ABILITY` item. `abilityCandidates` emits one candidate per target combination (cap `MAX_TARGET_COMBOS`); none means not offered. Target-free abilities are unchanged (they now reject extra targets).
- **Parser**: `parseCardAbilities` bodies go through `parseEffectSentences` (extracted from `parseSpellText`): "Choose..." / "Give a unit +N" / "Deal N to an enemy unit" / "Kill ..." / "Stun ..." / "Move ... to base" and so on. `[Stun]` is normalised. All-or-nothing is kept (a chosen unit must be used by an effect).
- **Bot**: no special code. The pending choice is in `getLegalActions`, so `AIController` scores the options like any action (tested); the host bot fallback (`legal[0]`) and the tutorial autopilot also work. The `hostTimers` timeout fallback picks `CHOOSE_TRIGGER_TARGET` before `PASS_PRIORITY` (first enumerated combination, lowest object id: can be a poor target, documented).
- **Client**: `TargetBanner` / `useBoardUi` drive three sources (`TargetSource`: play, ability, trigger) through the same `targetStep`. Trigger choices are derived from `flow.pendingChoice` (mandatory: no Cancel, Escape ignored); the opponent sees a waiting notice; a choice the board cannot drive falls back to one button per legal answer. `AbilityButtons` groups variants per ability and a targeted ability starts click-to-target (also from the right-click menu, "(choose target)"). `describeEvent` handles both new events (exhaustive switch and test).
- **Host/guest**: nothing special; the intent and the `pendingChoice` travel through the existing protocol. A loopback test covers it.
- **Dev/e2e**: `?mock&buffer=1` gives the human a ready Cinder Grunt with "[E]: Give a unit +2 [M] this turn" and a play trigger; `e2e/abilities.spec.ts` clicks Activate and then the target.

## Golden hashes

`reducePurity.test.ts` golden hashes did not change: the games they hash use fixture decks without targeted triggers, and `flow.pendingChoice` / chain items are only touched when a target-bearing trigger fires. `pendingChoice` was already part of the state shape.

## Rules and UNCLEAR items

Cited: 355.10 (targets chosen when put on the Chain, checked again at resolution; the spell rule), 145.1 (activated abilities), 649 (concede). See docs/ASSUMPTIONS.md "R41": the no-legal-target skip, the auto-pick, the order of several triggers and Deflect are not verified against the Core Rules text and are marked UNCLEAR.

## Risks and gaps

1. **Deflect is not charged for targeting triggers and abilities** (spells still are). The cost display does not know it either.
2. "You may" optional effects, "here" / "at my battlefield" scoping and "another unit" are not parsed (those cards stay partial). Iron Ballista needs "This enters exhausted."
3. The timeout / fallback target for a human is the first enumerated combination (lowest object id), which may be an enemy buff target.
4. Beyond 48 target combinations (for example "up to two units" with many units) the enumeration is truncated, so some pairs cannot be chosen from the UI.
5. Working tree line endings: `prettier --write engine/src` normalised some files to LF (git sees no content change; `git status` may list them as modified until the index refreshes).
