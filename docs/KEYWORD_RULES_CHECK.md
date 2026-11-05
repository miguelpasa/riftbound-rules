# Keyword rules check (Core Rules rev 2026-10-09 vs engine)

Scope: verify the keyword glossary (rules 800-832) against `engine/src`, list deferred keywords with implementation briefs, and recommend an order. Read-only on source code; this file is the only change.

## Method and caveats

- Source: the official PDF linked from riftbound.gg/rules/core-rules
  (`cmsassets.rgpub.io/.../5c7946f7c3b8c6e0faff85ab6dadc6d2e721ea94.pdf`). WebFetch could not read it (binary); the saved copy was extracted locally with `pdftotext` (scratch copy, not in the repo).
- Extraction caveat: `pdftotext` separates rule numbers from body text in the glossary. Keyword _names_ and body text are reliable. Rule numbers were assigned by sequence and cross-checked against in-text references (e.g. "See rule 830. Deploy" and the 805-826 headings). Where the numbering was inconsistent (Disarm/Show Off, Stun, Empower/Empowered) the item is marked UNCLEAR on the number.
- Quotes are kept to one short phrase; everything else is paraphrased.
- Card counts come from `client/public/cards.json` (1,103 records) by the `keywords` array, unless marked "text".

## Glossary index (rules 805-832)

| Rule | Keyword             | Type                                | Engine status                                              |
| ---- | ------------------- | ----------------------------------- | ---------------------------------------------------------- |
| 805  | Accelerate          | Optional additional cost (Units)    | Implemented                                                |
| 806  | Action              | Permissive                          | Implemented (chain.ts)                                     |
| 807  | Assault [X]         | Passive (Units)                     | Implemented (combat.ts)                                    |
| 808  | Deathknell [Effect] | Triggered (Permanents)              | Deferred                                                   |
| 809  | Deflect [X]         | Passive / mandatory additional cost | Implemented (keywords.ts)                                  |
| 810  | Ganking             | Passive (Units)                     | Implemented (movement.ts)                                  |
| 811  | Hidden              | Prerequisite for Hide               | Implemented (keywords.ts)                                  |
| 812  | Legion [Text]       | Dependent                           | Deferred                                                   |
| 813  | Reaction            | Permissive                          | Implemented (chain.ts)                                     |
| 814  | Shield [X]          | Passive (Units)                     | Implemented (combat.ts)                                    |
| 815  | Tank                | Passive (Units)                     | Implemented (combat.ts)                                    |
| 816  | Temporary           | Triggered (Permanents)              | Implemented (keywords.ts), partial                         |
| 817  | Vision              | Triggered (Permanents)              | Deferred                                                   |
| 818  | Equip [Cost]        | Activated (Gear, tag Equipment)     | Implemented, cost wrong                                    |
| 819  | Quick-Draw          | Triggered + Permissive (Gear)       | Implemented, speed wrong                                   |
| 820  | Repeat [Cost]       | Optional additional cost            | Deferred                                                   |
| 821  | Weaponmaster        | Play effect (Units)                 | Deferred                                                   |
| 822  | Ambush              | Passive (Units)                     | Not typed in `KeywordName` (0 cards carry it as a keyword) |
| 823  | Hunt X              | Triggered, Conquer/Hold (Units)     | Deferred                                                   |
| 824  | Level [N] [Text]    | Dependent                           | Deferred                                                   |
| 825  | Unique              | Deck constraint                     | Deck validation only (deckValidation.ts)                   |
| 826  | Backline            | Passive (Units)                     | Implemented (combat.ts)                                    |
| 827  | Empower             | Activated (Permanents, Legends)     | Deferred                                                   |
| 828  | Empowered           | Dependent (state)                   | Deferred                                                   |
| 829  | Flow [Cost]         | Passive (Spells)                    | Deferred                                                   |
| 830  | Deploy              | Passive + Triggered (Gear)          | Deferred                                                   |
| 831  | Disarm X            | Triggered, attack (Units)           | Deferred (number UNCLEAR, see below)                       |
| 832  | Show Off [Object]   | Passive (Cards)                     | Deferred                                                   |

Rule-level items named in the brief but not glossary keywords: Predict (437-438, Limited Action; the `[Predict]` used by Vision), Buff (427.1, a game object; `BUFF_TARGET` / `BUFF_ALL` exist in `types/card.ts`), Stun (Limited Action, about rule 426, number UNCLEAR; nothing in the engine).

---

## Implemented keywords

### Accelerate (805) - MATCH

- Rule: Optional additional cost on Units: pay 1 extra (energy and Power). The Power portion must match a domain of the unit, or use [A] when the unit has no domain. Costs cannot be paid on the board. The unit enters ready (805.5, 806.1.c.2).
- Engine: `play.ts` (`accelerate` gate, lines ~274-279) rejects the keyword on non-Units; `resources.ts` `computeTotalCost` adds +1 energy and one `genericPower` requirement (domain-restricted via `of`, or `ANY` if no domain); `play.ts` ~138 sets `ready` when `additionalCosts.accelerate` is true.
- Verdict: MATCH. Note: 1 card (a Battlefield) carries Accelerate in data; rule says Units only. UNCLEAR (data).

### Action (806) - MATCH

- Rule: permission to play or activate during Showdowns on any player's turn; permission only, no change to other restrictions.
- Engine: `chain.ts` `canPlayNow`, lines ~138-141: `action` applies only to cards (not abilities) and allows Showdown play. Units/Gear still restricted to base or own battlefields by their own rules.
- Verdict: MATCH.

### Assault (807) - MATCH

- Rule: "functionally short for" +X Might while the unit is an Attacker; X defaults to 1; multiple granted instances sum.
- Engine: `combat.ts` `keywordBonus` sums `value ?? 1` for role ATTACKER, role = `flow.combat` attacker (controller-based, 466.2.c).
- Verdict: MATCH.

### Deflect (809) - MISMATCH

- Rule: a spell or ability an opponent controls that targets this costs an extra Power, equal to the Deflect value, for each time they choose it. Payable with any domain. Values sum. Deflect is "normally present on Permanents" (Units, Gear, and others).
- Engine: `keywords.ts` `deflectExtraCost` returns `{anyPower}` (correct domain handling, sums per instance, defaults to 1).
  - Gap 1: `isUnitOnBoard` only accepts `type === 'UNIT'`. Data: 3 GEAR cards carry Deflect; the engine ignores them.
  - Gap 2: a `seen` set dedupes a repeated target, but the rule charges per choice. Minor.
  - Gap 3: abilities with targets are not charged (only `playCard` uses the hook). UNCLEAR whether the engine has any ability targeting path that would need it.
- Fix:
  - `engine/src/keywords.ts` `deflectExtraCost`: accept any permanent on the board (UNIT or GEAR), not only UNIT, and drop the `seen` dedupe (count each chosen target).
  - Add a test in `keywords.test.ts` for a Deflect Gear targeted by an opponent.

### Ganking (810) - MATCH

- Rule: Standard Move from a battlefield to another battlefield is allowed for units with Ganking. Passive, no cost.
- Engine: `movement.ts` `canStandardMove`: battlefield to battlefield requires `Ganking` on the unit definition (144.4.c.1).
- Verdict: MATCH.

### Hidden (811) - MISMATCH

- Rule: while the Hidden card is in hand (or Champion Zone) on your turn during an Open State, you may pay 1 Power (A) to hide it facedown at a battlefield you control that has no facedown card. From the next turn it gains Reaction and may be played ignoring its base cost. Hidden permanents must be played to the battlefield where they were hidden, and this explicitly includes Gear (it overrides the normal "Gear only to base" rule). Facedown cards are not "cards with Hidden".
- Engine: `keywords.ts` `hideCard` (Neutral Open only, own battlefield, one facedown per battlefield, 1 Power any domain, emits only a `CARD_PLAYED` visible to the controller). `playHiddenCard` (later turn only, Reaction, base cost 0, `location` overridden to the hidden battlefield for UNIT only).
  - Gap 1 (clear): for GEAR, `playHiddenCard` passes `intent.location` through, and `play.ts` (~lines 138 and ~290) forces GEAR to base. A facedown Hidden gear therefore lands in base. Data: 2 GEAR cards have Hidden.
  - Gap 2 (text): the rule says "during an Open State"; the engine requires Neutral Open. The ASSUMPTIONS.md citation (411.1.a, 422) does not say Neutral-only in the text read here (411.1.a is generic Game Actions; 422 says "meet the prerequisites"). The engine is stricter than 811 as written.
- Fix:
  - `engine/src/keywords.ts` `playHiddenCard`: use `bfId` as the location for `def.type === 'UNIT' || def.type === 'GEAR'`.
  - `engine/src/play.ts` (chain item location and `onEnter` for GEAR): honour `item.location` when it is a battlefield for a facedown-played gear, instead of forcing base.
  - `engine/src/keywords.ts` `hideCard`: decide on Showdown Open (allow on your turn when `ts.open`, or record a ruling). Update ASSUMPTIONS.md with the decision.

### Reaction (813) - MATCH (see Quick-Draw)

- Rule: permission to play or activate in Closed States on any turn; includes Action permissions.
- Engine: `chain.ts` `canPlayNow`: `reaction` allows play when `!ts.open` (Closed) or in any open state.
- Verdict: MATCH for the keyword; the Quick-Draw inheritance below is the gap.

### Shield (814) - MATCH

- Rule: while a defender, +X Might; default 1; sums.
- Engine: `combat.ts` `keywordBonus` with role DEFENDER and name Shield.
- Verdict: MATCH.

### Tank (815) - MATCH (with a tie note)

- Rule: must be assigned lethal damage before any other unit with the same controller that does not have Tank, during combat damage. Multiple Tank redundant.
- Engine: `combat.ts` `tierOf` / `checkAssignment`: TANK tier first; at most one unit short of lethal; excess only on the last tier.
- Verdict: MATCH. A unit with both Tank and Backline: the rules text does not settle which tier applies. Engine picks Tank (see REMAINING.md, 467.2.c.8). UNCLEAR.

### Temporary (816) - MISMATCH (gear), UNCLEAR (spells)

- Rule: "At the start of this permanent's controller's Beginning Phase, before scoring, kill this." Present on Permanents.
- Engine: `keywords.ts` `temporaryOnBeginning` runs at Beginning for the active player, before Scoring, for `UNIT` and `TOKEN` only (tokens removed per 186.1).
  - Gap 1: 4 GEAR cards have Temporary (including Sprite Fountain and Petricite Monument); the engine ignores them.
  - Gap 2 (data): 8 SPELL cards carry Temporary in data; a spell is not a permanent. Probably a parsing artefact. UNCLEAR.
- Fix: `engine/src/keywords.ts` `temporaryOnBeginning`: add `def?.type === 'GEAR'` to the filter (gear goes to the owner's trash and detaches as units do). Ask the data owner to check the SPELL rows.

### Equip (818) - MISMATCH (cost)

- Rule: Equip is an activated ability on Gear with the Equipment tag: "[Cost]: Attach this gear to a unit you control." The cost may include both resource and non-resource costs; the target is chosen; Equip is a Chain ability (the opponent may respond); attach on resolution.
- Engine: `keywords.ts` `equip` (Main Phase, Neutral Open, Equipment tag, unit you control, Chain, attach on resolution in `play.ts` playResolver) is correct in structure.
  - Gap 1 (critical): `keywordValue(eqDef, 'Equip')` reads a numeric value from the keyword. In `cards.json` no Equip keyword has a value (0 of 41). Every Equip is therefore FREE.
  - Gap 2: the cost is Energy only. The printed Equip costs in data are `[1]`, `[C]`, `[1][C]`, `[A]`, `[3][A]`, and cases with non-resource parts ("Kill a friendly unit", "Recycle 2 cards", "Spend 1 XP", "exhaust a friendly unit"). Power (`[C]`, `[A]`) and non-resource costs are not paid.
  - Gap 3: the `[3][A]` text reduces by the target's Might (cost modifier). Not modelled.
- Fix:
  - `scripts/` (the cards.json generator) or the engine: parse each Equip cost into `{energy, power}` (numbers = energy; `[C]` = Power of the unit's domain; `[A]` = any-domain Power) and store it on the keyword. Replace `keywordValue` for Equip with that structured cost.
  - `engine/src/keywords.ts` `equip`: build `TotalCost` from the parsed cost, not `energy: keywordValue`.
  - Non-resource Equip costs: keep as UNCLEAR and mark those cards `partial` until implemented.
  - Update the Equip note in ASSUMPTIONS.md (the "dataset gives a single number" claim is not true for `cards.json`).

### Quick-Draw (819) - MISMATCH

- Rule: "Cards with Quick-Draw have Reaction inherently." Quick-Draw is functionally "[Reaction]" and "When you play this, attach it to a Unit you control." Multiple instances are the same.
- Engine: `keywords.ts` `quickDrawAttach` / `makePlayHooks.onEnter` attach at play time (correct). The Reaction timing: `chain.ts` line ~138 `reaction = hasKeyword(card, 'Reaction')` does not count QuickDraw. Data: all 6 Quick-Draw cards lack a Reaction keyword (their text says "This has [Reaction]").
  - Result: Quick-Draw gear cannot be played in a Closed State or as a Reaction.
- Fix: `engine/src/chain.ts` line ~138: `reaction = hasKeyword(card, 'Reaction') || hasKeyword(card, 'QuickDraw')`. Add a test in `keywords.test.ts`: Quick-Draw gear played in a Closed State. Also check `legalActions.ts` line ~114 uses the same rule.

### Backline (826) - MATCH (with the same tie note as Tank)

- Rule: must be assigned lethal damage after any other unit with the same controller that does not have Backline. Multiple instances redundant.
- Engine: `combat.ts` `tierOf` BACKLINE tier (ordered last); enforced in `checkAssignment`.
- Verdict: MATCH. Tank+Backline: UNCLEAR (see Tank).

### Unique (825) - out of combat scope

- Deck construction only (deckValidation.ts). Not reviewed in depth here. Rule: "Unique" is a Deck Constraint Permission, no gameplay effect.

---

## Deferred keywords: implementation briefs

Counts are `cards.json` rows whose `keywords` array carries the name (all are `supportLevel: partial`), unless marked. Complexity: Low / Medium / High.

**Deathknell (808)** - 29 cards (UNIT 26, GEAR 3). Rules: 808.1 (triggers "When I die, [Effect]"; the effect may be written in the past tense), 808.1.d (order chosen by controller), 808.2 (replacement by recall removes the trigger). Needs: source snapshot before the trash move, a pending chain item before the card leaves the board, and a `DEATH` trigger in `triggers.ts`. The `TriggerKind` already has `DEATH`. Complexity: Medium (the leave-board snapshot is the hard part).

**Legion (812)** - 10 cards (UNIT, GEAR, LEGEND, SPELL). Rules: 812.1 (dependent: active if you have finalized another card this turn; all Legion instances satisfied by one card). Needs: a per-player "finalized this turn" counter reset at turn start, and dependent-ability gating. Complexity: Low.

**Vision (817)** - 9 cards (UNIT, GEAR). Rules: 817 (functionally "When this is played, [Predict]"; each instance triggers separately; the player chooses to recycle per instance). Needs: Predict (below) plus a play trigger. Complexity: Medium (depends on Predict).

**Predict (437-438, used by Vision and spells)** - 14 cards (SPELL, UNIT, BATTLEFIELD, GEAR). Rules: 437.4 (look at the top card of the Main Deck and choose), 438.1 (look at N, may recycle), 438.1.b.1 (Limited Action, only when instructed), 438.2 ("Predict X"). Needs: an ordered main deck view and a recycle choice that goes to the bottom. Burn Out when short of cards (438.x) is a shared dependency. Complexity: Medium.

**Hunt (823)** - 12 cards (UNIT). Rules: 823 ("When I Conquer or Hold, my controller gains X XP"; default 1; sums). Rule 728 (XP) is referenced. Needs: an XP counter per player (not in `GameState`), Conquer and Hold hooks in `scoring.ts`. Complexity: Medium (XP model needed; also used by Level and by the "Spend 1 XP" cost).

**Level (824)** - 15 cards (UNIT, SPELL, GEAR, LEGEND, TOKEN). Rules: 824.1 (dependent: active while the controller has N or more XP; re-evaluated on control change; inactive below N). Needs: the XP model from Hunt and a dependent-ability gate. Complexity: Medium.

**Flow (829)** - 17 cards (SPELL, UNIT in data; spells per rule). Rules: 829 (Passive; you may play the spell from your trash for its Flow cost, then banish it; the banish is a delayed replacement; multiple Flow costs = choice). Needs: a trash-zone play permission, an alternate cost path in `computeTotalCost`, and a banish replacement on leaving the chain. Data says UNIT for some rows: UNCLEAR, check against the rule (Flow is on Spells). Complexity: Medium-High.

**Repeat (820)** - 24 cards (SPELL, GEAR, BATTLEFIELD, UNIT). Rules: 820.1 (optional additional cost, each Repeat cost paid at most once per instance), 820.2 (resolution runs the instructions one more time; choices made again), 820.3. Needs: additional cost on the chain item; run `runEffects` a second time; separate choices for each execution. Complexity: Medium.

**Empower (827) and Empowered (828)** - 40 cards (LEGEND, UNIT, GEAR, BATTLEFIELD). Rules: 827 (activated; "[Cost]: Empower this. Play only if not Empowered."; cost may include non-resource parts; multiple instances are separate activations), 828 (Empowered is a dependent state). Needs: an activated-ability path (shared with Equip), an Empowered flag on objects that is cleared at the right time, and dependent-ability gating. Complexity: Medium. Rule numbers 827 and 828: UNCLEAR on the exact numbering (extraction).

**Weaponmaster (821)** - 12 cards (UNIT, LEGEND). Rules: 821.1 (play trigger: choose an Equipment you control; pay its Equip cost reduced by [A]; attach to this unit; no activation of the Equip ability itself). Needs: a working Equip cost (see Equip fix) and a trigger on play. Complexity: Medium, and blocked until Equip cost is correct.

**Deploy (830)** - 18 cards (GEAR, SPELL, UNIT, LEGEND). Rules: 830 (Gear may be played or created to any battlefield, including enemy-held or open ones; non-unit Gear is not recalled in Cleanup step 5; "When an opponent holds here, kill this" is part of the short form). Needs: a battlefield destination for Gear, a Cleanup exemption, and a Hold trigger. Complexity: Medium (the Hold trigger is the hard part). Rule number: 830 by in-text reference.

**Disarm X (831)** - 9 cards (UNIT). Rules: short form "When I attack, give an enemy unit here -X [M] this turn." Triggers once with the summed value (831-number UNCLEAR; body text is "Disarm is an Attack Trigger"). Needs: an attack trigger and a negative Might buff until end of turn (the `BUFF_TARGET` path already supports `amount`, use a negative value). Complexity: Low.

**Show Off (832)** - 6 cards (UNIT, SPELL). Rules: 832.1 (form "[Show Off] [Object]"), 832.2 (decided by the controller when finalizing; the chain item is not prevented from finalizing if the shown objects leave), 832.3 (linked abilities check the shown set at finalization). Needs: reveal or pick from hand and board during Make Relevant Choices, a linked-effect flag, and a set-check. Complexity: High (6 cards; choices and linkage).

**Stun** (Limited Action, about rule 426; number UNCLEAR) - 24 cards carry "[Stun]" or "Stun a unit" in text; 0 keyword rows. Not a glossary keyword. Rules text: stunned units do not contribute Might in the combat damage step, lose Stunned during the end-of-turn cleanup. Needs: a Stunned flag and combat changes in `combat.ts`. Complexity: Medium.

**Buff** (427.1) - 20 cards (text). Not a keyword. Partially implemented: `BUFF_TARGET` / `BUFF_ALL` in `types/card.ts`. Complexity: Low for the existing buff types.

**Ambush (822)** - not typed in `KeywordName`; 0 keyword rows. It is a Passive (Units) that adds Battlefield-play permissions. Complexity: Low to add the type; Medium to play correctly (Reaction while played to a battlefield you control has units).

---

## Recommended implementation order (deferred)

1. Legion (812): Low, 10 cards, no new infrastructure beyond a per-turn counter.
2. Disarm (831): Low, 9 cards, reuses `BUFF_TARGET` with a negative value.
3. Deathknell (808): Medium, 29 cards, uses the existing `DEATH` trigger kind; needs the pre-trash snapshot.
4. Predict (437) and then Vision (817): Medium, 14 + 9 cards, Vision is a Predict on play.
5. Empower (827/828): Medium, 40 cards, share the activated-ability path with Equip after the Equip cost fix.
6. Repeat (820): Medium, 24 cards, additional cost plus second execution.
7. XP model, then Hunt (823) and Level (824): Medium, 12 + 15 cards; the XP state is the prerequisite.
8. Equip cost fix, then Weaponmaster (821): Medium, 12 cards; blocked on the Equip fix below.
9. Deploy (830): Medium, 18 cards.
10. Flow (829): Medium-High, 17 cards (trash play and banish replacement).
11. Show Off (832): High, 6 cards.

Stun, Buff, Ambush: schedule with the combat work (Stun) and the Battlefield play work (Ambush).

---

## Summary of mismatches

Priority order:

1. **Equip costs are free (critical).** `cards.json` Equip keywords have no value (0 of 41). `keywordValue` returns 0. Power and non-resource costs are not paid. Fix in the cards generator and `keywords.ts` `equip`.
2. **Quick-Draw gear cannot use Reaction timing.** `chain.ts` line ~138 ignores QuickDraw. Fix one line in `chain.ts`; check `legalActions.ts`.
3. **Hidden gear is placed in base.** `playHiddenCard` and `play.ts` ignore the hidden battlefield for GEAR (rule 811 requires it). Fix `keywords.ts` and `play.ts`.
4. **Temporary on Gear is ignored.** 4 GEAR cards. Fix `temporaryOnBeginning` filter (add GEAR).
5. **Deflect on Gear is ignored.** 3 GEAR cards. Fix `deflectExtraCost` (allow GEAR); also remove per-target dedupe (rule charges per choice).
6. **Hide requires Neutral Open only.** Rule 811 says "an Open State". Decide and document (ASSUMPTIONS.md cites 411.1.a and 422, which do not show this in the text read).

Verified MATCH: Accelerate, Action, Assault, Ganking, Reaction, Shield, Backline. Tank: MATCH except the Tank+Backline tie (UNCLEAR, already in REMAINING.md).

Data issues to report to the cards owner (UNCLEAR): 8 SPELL rows with Temporary; 1 BATTLEFIELD row with Accelerate; some Flow rows typed UNIT.

Not resolved by this check: exact rule numbers for Disarm (831 vs 832), Empower/Empowered (827/828), Stun (about 426), and the Predict text (437-438 read from the PDF body; numbers UNCLEAR at the glossary level).

No source files were changed. Nothing was committed or pushed.
