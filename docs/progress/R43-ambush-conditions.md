# R43: Ambush, condition language, "When I move", temporary keyword grants

Status: done. Fully supported cards 206 -> 226 of 1103 (`npm run cards` reports 232 because it counts 6 token defs; was 212). Engine 631 tests (+17), client 393 (+1), scripts 23 (+3); typecheck, lint, check:rules green; `reducePurity` golden hashes unchanged; `profile-ai` bot-vs-bot completes; Playwright smoke + solo + abilities 5/5 on a temporary port-5199 config (deleted, no port 5173).

## Measurement (before coding)

Scratch scripts outside the repo (`measure.ts`, `cond.ts`, `heads.ts` in the session scratchpad) ran `convertRow` over the deduped `data/raw/cards.json` at HEAD `b48b09a` (206 full, 897 partial). For every partial card each sentence was removed (or only its "if"/"while" clause stripped) and the card re-converted.

- **Conditions are a long tail, no dominant shape.** Stripping only the condition clause turns 14 cards full, in 14 different shapes: "exactly one other unit you control here" (2 cards, Shen), "you control no other units / another Dragon / two or more other units in your base" (enters ready: 3), "N or more other gear", "an enemy unit alone here", "a friendly unit or gear died this turn", "total Might", "I died alone", "I was Mighty", "excess damage assigned". Everything else was a one-off. The ones with a clean engine meaning were implemented; "died this turn", "excess damage", "died alone" and "Mighty" need new bookkeeping and were left.
- **Trigger moments by blocker count (partial cards, single blocker in brackets):** "When you play me" 98 (38, mostly other effects), "When I attack" 22 (12), "When you play <a card/unit/spell>" 20 (11), **"When you hold here / conquer here" 32 (27, battlefield cards)**, "At the start/end of ..." 16 (9), "When I move" 16 (10) + "move to/from" 13, "While I'm at a battlefield" 7, "When I become exhausted/ready" 6.
- **Temporary keyword grants ("Give a unit [Tank] this turn", Assault, Shield, Ganking)** block about 25 single-blocker cards, more than all condition shapes together.
- Ambush: 4 single-blocker cards (+ 13 with other text; two of those, Lord Broadmane and Chakram Dancer, became full through the keyword grants).

## What was added

| Area               | Change                                                                                                                                                                                                                                                                                                                                                                                                          | Files                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ambush (822)       | `Ambush` is an implemented keyword. `playCard`: a Unit with Ambush played to a battlefield where its controller has another unit gets Reaction speed (`canPlayNow` option `ambush`) and may use a battlefield it does not control. `getLegalActions` adds those battlefields as locations.                                                                                                                      | `types/card.ts`, `chain.ts`, `play.ts` (`hasUnitAt`), `legalActions.ts`, `cardText.ts` (keyword token), `scripts/lib/cardConvert.ts`, card schema |
| Condition language | `Condition` union (`COUNT` of units/gear/runes/hand cards by zone, `CONTROL_SUBTYPE`, `AT_BATTLEFIELD`), `evalCondition` (pure, public data + hand sizes). `CardTrigger.when` (checked when the ability triggers and again as it resolves) and `CardDef.entersReadyWhen` (checked as the unit enters). Parser: `parseCondition` plus "if C, effect" / "effect if C" in trigger bodies and "I enter ready if C". | `conditions.ts`, `types/card.ts`, `cardText.ts`, `triggers.ts`, `play.ts`, converter + schema                                                     |
| "When I move"      | `TriggerKind` `MOVE`, fired from `UNIT_MOVED` events whose destination is a battlefield.                                                                                                                                                                                                                                                                                                                        | `triggers.ts`, `cardText.ts`                                                                                                                      |
| Temporary keywords | `CardInstance.tempKeywords` (public), effects `GRANT_KEYWORD_TARGET` (targeted: spells, triggers, abilities, "Give it [K] this turn") and `GRANT_KEYWORDS` (`SELF`, `OTHERS_HERE`), expiry in the Ending step and on return to hand, reads through `defWithTemp` in `effectiveMight` (Assault/Shield), the damage-assignment tier (Tank) and the Ganking move check. The client combat dialog mirrors it.       | `tempKeywords.ts`, `effects.ts`, `combat.ts`, `movement.ts`, `cardText.ts` (`protectGrants`), `client/src/components/combat/damage.ts`            |
| Events / UI text   | `EFFECT_KEYWORD_GRANTED` in `describeEvent` (exhaustive switch) with a test.                                                                                                                                                                                                                                                                                                                                    | `types/event.ts`, `client/src/game/describeEvent.ts`                                                                                              |

New full cards (20): Ambush Soulspinner, Inferna, Grim Apothecary, Vi, Lord Broadmane, Chakram Dancer; conditions / moves Shen (x2), Patched Porobot, Disposal Expert, Direwing, Xin Zhao, Eclipse Dragon, Stellacorn Herder, Treasure Hunter; keyword grants Block, Cleave, Gem Jammer, Vault Breaker, Blood Rush.

## Design notes

- **Pending choices:** none added. Ambush is an ordinary `PLAY_CARD`; conditions need no choice; keyword grants use the existing target machinery (`TRIGGER_TARGET`, spell targets), so the bot, the host fallback (`legal[0]`) and `hostTimers` need no change. Tests: the bot answers in a Showdown with an Ambush unit in hand and after a group grant.
- **Sanitize:** conditions read board zones and `hand.length` only; `tempKeywords` is public like `tempMight`. The leak tests pass unchanged and a test evaluates a hand-size condition on the opponent's sanitized view.
- **Golden hashes** did not change: no fixture card uses the new fields.
- **Client:** no new UI. The hand uses `playVariants` from the legal intents, so an Ambush unit shows "Play to <battlefield>" in a Showdown (test added). The combat damage helpers read `tempKeywords`.

## Rules and UNCLEAR items

Tests cite 822 (Ambush; number from docs/KEYWORD_RULES_CHECK.md, official text not readable in this session: riftbound.gg/rules/core-rules loaded only a shell page), 308.1.a, 312.1, 355.10, 359.2.c, 144.4.c.1, 315.2.b, 447, 467. UNCLEAR items are in docs/ASSUMPTIONS.md "R43": condition check moments, "When I move" scope, whether an Ambush unit joins an ongoing combat, grant stacking.

## Not done (and why)

- **Battlefield-card triggers** ("When you hold here", "When you conquer here", "While you control this battlefield"): 32 cards, 27 of them single blockers, the biggest remaining unlock. Battlefield cards are `BattlefieldState` entries, not objects, so chain items and `runEffects` (which look up `state.objects[sourceObjectId]`) need a battlefield source.
- **Start / end of turn triggers and become exhausted / ready:** the turn sequence runs inside one reducer step; hooking needs a mid-sequence trigger pass (or conditions would see the next turn). Not cheap, skipped.
- Conditions needing bookkeeping: "died this turn", "excess damage assigned", "I died alone", Mighty, "total Might", "fewer runes than an opponent", turn-state ("if it's your turn", "if you've played ... this turn").
- Ambush extras: Rengar (enemy units there), Stalking Wolf (additional cost + no other units needed), and the other texts of Diana, Evelynn, Nidalee, Vilemaw, Morgana, Kha'Zix, Poppy.
- "unit or gear" choices, `[Deflect]` / `[Backline]` grants, "equal to its Might/Shield" grants, `[Assault]` granted by payment (Baccai Reaper), non-targeted "you may" with costs.

## Risks

1. Ambush rule text unverified (see above); if the real rule also requires the battlefield to be one you control or contested, only `play.ts` and `legalActions.ts` change.
2. The intervening-if resolution check could be wrong for cards meant to check only on trigger.
3. `MOVE` ignores moves to the Base; "when I move" cards that mean any destination under-trigger.
4. A unit that gains Tank this turn changes the assignment order live; a grant made mid-damage-step is not specially handled.
