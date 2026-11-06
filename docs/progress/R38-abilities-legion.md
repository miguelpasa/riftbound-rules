# R38: activated abilities, Gold tokens, Legion effects

Status: partly done. Fully supported cards 141 -> 165 of 1103 (`npm run cards` reports 171 because it counts 6 token defs: the 5 old ones plus the new Gold). Engine 580 tests (557 + 23), client 371 (+1), scripts 17 (+3); typecheck, lint, check:rules green; golden hashes in `reducePurity.test.ts` unchanged.

## Method

Measured with a throwaway script over `data/raw/cards.json`: for every partial card, which single sentence, if removed, makes the card parse ("single blocker"). The top groups were: `[Repeat]` 7, Seal / Energy Conduit `[Reaction] - [Add]` 8, `I enter ready` 6, `[Weaponmaster]` 5, "When you play me, give a unit +N" 5 (needs targets on triggers), Gold token plays 7. Gold, Seals, Legion and "I enter ready" were done; targeted triggers, Repeat and Weaponmaster were not.

## What was added

| Area                | Change                                                                                                                                                                                                                                                                                                        | Files                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Activated abilities | `CardDef.abilities: ActivatedAbility[]` (cost: exhaust / Energy / Kill this; Reaction speed; target-free effects). `ACTIVATE_ABILITY` (`sourceId`, `abilityIndex`, `payment`) now works. [Add] abilities resolve at once; others go on the Chain as `ABILITY` items with `activatedIndex` and `sourceCardId`. | `engine/src/abilities.ts`, `reducer.ts`, `play.ts` (resolver), `types/*`             |
| [Add] effects       | `ADD_ENERGY`, `ADD_POWER {domain: SOURCE or ANY}` write to the Rune Pool. Public events `ABILITY_ACTIVATED`, `RESOURCES_ADDED`.                                                                                                                                                                               | `effects.ts`, `types/event.ts`, `client/src/game/describeEvent.ts`                   |
| Gold gear token     | `tok-gold` in `TOKEN_CARDS` (TOKEN without Might = gear-like, `isGearDef`). "Play a/two/three/four [ready] Gold gear token(s) [exhausted]" is a `PLAY_TOKEN`. `TARGET_CONTROLLER_PLAY_TOKEN` for "Its controller plays a Gold gear token exhausted". `killGear` removes tokens (186.1).                       | `tokens.ts`, `effects.ts`, `cardText.ts`                                             |
| Legion effects      | `CardTrigger.condition: 'LEGION'` checked in `triggers.ts` with `legionActive`; `CardDef.legionCostReduction` applied as a discount in `play.ts` and in the `getLegalActions` payment plans.                                                                                                                  | `triggers.ts`, `play.ts`, `legalActions.ts`                                          |
| "I enter ready"     | `CardDef.entersReady`, honoured by the placing resolver.                                                                                                                                                                                                                                                      | `play.ts`                                                                            |
| Parser              | `parseCardAbilities(text, {gearLike})` returns triggers, abilities, entersReady, legionCostReduction (all-or-nothing). `parseTriggerText` is a wrapper. `parseClause` also accepts `[Add]`.                                                                                                                   | `engine/src/cardText.ts`, `scripts/lib/cardConvert.ts`, `resources/card-schema.json` |
| Legal actions       | Chain abilities enumerated with an `autoPlan` payment; `getAbilityActivations` lists [Add] abilities for the UI.                                                                                                                                                                                              | `legalActions.ts`                                                                    |

Newly full (24): Seals of Rage, Focus, Insight, Strength, Discord, Unity; Energy Conduit; Dragonsoul Sage; Gold; Vanguard Armory; Sneaky Zeebles; Plundering Poro; Eminent Benefactor; Trove Golem; Honest Broker; Wages of Pain; An Offer You Can't Refuse; Noxus Hopeful; Vanguard Captain; Antagonistic Apparatus; Wrath of the Freljord; Eager Drakehound; Master Yi; Vanguard Attendant.

## Rules and UNCLEAR items

Cited: 145.1 / 151.1 (activated abilities), 135.2.e.2 (exhaust cost), 166.1 and 168 (Add), 186.1 (tokens), 309.1.a, 359.2.c, 812. See docs/ASSUMPTIONS.md "R38": whether [Add] abilities use the Chain (rule 430 unreadable) and when Legion is checked are assumptions.

## Safety checks

- Sanitize: the new events and `ChainItem.sourceCardId` concern public permanents; no hidden card id is exposed. Sanitize / leak tests pass.
- AI: [Add] abilities are not in `getLegalActions`, so the bot never uses Gold or Seals (it does use Chain abilities such as Vanguard Armory). A 4-game bot-vs-bot run on real decks (`scripts/profile-ai.ts`) completes.
- `ACTIVATE_ABILITY` on an object without the ability still returns `ABILITY_NOT_AVAILABLE` (existing reducer test and purity fuzz unchanged).

## Not done (and why)

- **Targeted triggers and abilities** ("When you play me, give a unit +2 [M] this turn": War Scout, Field Musicians, Whiteflame Protector, Dangerous Duo, Riptide Mage; Arena Kingpin, Iron Ballista): the controller must choose targets after the trigger is put on the Chain. That needs a new pending choice plus client UI; client/ was out of scope.
- **Disarm**: still blocked on an attack event plus a targeted attack trigger (same prerequisite).
- **Moves with a destination, keyword grants until end of turn, "would die" replacement hooks**: each needs a choice (destination, target) or a Cleanup hook; not attempted because the missing choice step is the common blocker.
- Legion cards left: Darius (static +1 aura), Dangerous Duo (targeted), Scrapyard Champion (discard choice), Trifarian Gloryseeker (Buff), Sun Disc, Noxian Guillotine, Undying Legion, Hand of Noxus (legend).
- Other [Add] cards: Lux, Malzahar, legends (use-only restrictions), Platewyrm Egg / Honeyfruit (Empower, Level), Jhin, Akali.

## Risks and follow-ups

1. **`scripts/lib/` is git-ignored** (`.gitignore` line 17 `lib/`), so `scripts/lib/cardConvert.ts` and its test are untracked and this task's converter change will not be committed unless the rule is narrowed (e.g. `/lib/`) or the files are added with `git add -f`.
2. **Client UI**: nothing in client/ activates abilities yet. A human cannot click Gold, a Seal or Vanguard Armory. A button on a permanent with `def.abilities` is needed (`getAbilityActivations` for [Add], the legal action for the rest). `BaseRow` also lists Might-less tokens (Gold) with the units.
3. The client's own cost display does not know `legionCostReduction`; the engine accepts the discounted payment and extra payment stays in the pool.
4. `cards.json` now contains `tok-gold`; `loadCards` merges `TOKEN_CARDS` for older files.
