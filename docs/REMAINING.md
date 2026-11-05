# Remaining work

Everything in the original plan (see [progress/README.md](progress/README.md)) is done. This file lists what is left, with complexity and a suggested model, using the same convention: **Low** = Haiku, **Medium / High** = Sonnet. Items are grouped by theme and ordered roughly by value within each group.

## 0. Session log (latest)

- **R9 and R10 done (core).** Equip is an ABILITY Chain item (resolved in `playResolver`, abilityIndex 0), Main Phase Neutral Open only; the old tests now pass both players before checking the attachment. Universal Power: `RunePool.universal`, `addUniversalPower`, allocation via a hub node in the min-cost flow, an "Any N" chip in the resource panel. Also fixed `determinize` reusing a Chain item id for an invented object id. **Left:** Equip's Power cost (needs the cost text in card data); a card effect that Adds [A] (needs activated abilities); e2e not re-run.

- **R8 done except the keyword glossary.** Read the official rules (rev 2026-10-09): see "Verified against the official Core Rules" in ASSUMPTIONS.md. Fixed R12 (repeated Burn Out until the opponent wins, 432.3.a) and the heal part of R13 (468.1.a.1 heals all units). R14 resolved: Hold is not subject to the Final Point rule (473.1.a.1), assumption was right. New facts: Equip is a Gear activated ability, Main Phase Open State only, goes on the Chain (151.2) -> R9 confirmed; Universal [A] exists (135.2.e.5) -> R10 confirmed; Tank+Backline is the assigner's choice (467.2.c.8). **Left:** keyword text 806-832 was truncated by the fetch; check the official PDF (link on riftbound.gg/rules/core-rules).

- R3 (second cut): added `KILL_TARGET` (side, at-battlefield, max Might), `READY_TARGET`, `BUFF_ALL` (friendly/enemy units, this turn) and their parser patterns. Fully supported cards: 82 -> 87. Still unparsed, by frequency: 'They deal damage equal to their Mights to each other' (needs two targets), 'Draw N and channel N rune exhausted', look-at-top-cards, gold gear tokens, move an enemy unit, counter a spell, -N Might with minimum, stun, kill a gear (gear targets), conditionals ('if this kills it').
- R3 (first cut) landed: `engine/src/cardText.ts` `parseSpellText` (all-or-nothing: Draw N / Deal N to a [friendly|enemy] unit [at a battlefield] / Give a unit +N [M] this turn) is applied to spells in `scripts/lib/cardConvert.ts`. After `npm run cards`: 14 spells are executable, fully-supported cards went 68 -> 82. Spell texts are a long tail (almost every remaining sentence is unique), so more coverage needs new ops (kill, stun, move, counter, conditionals, tokens, channel, 'to all units'), each added with a parser pattern. Also added: `side` and `atBattlefield` target restrictions, `tempMight` that expires in the Ending step. Unit/gear/legend text is not parsed yet (needs triggers, R5).
- R2 (partial) landed: `getLegalActions` now offers one PLAY_CARD variant per unit on the board for spells with DAMAGE_TARGET/BUFF_TARGET; `playCard` refuses such a spell without a unit target (`ILLEGAL_TARGET`); the client play popover lists one entry per target ("Play - target X (opponent)"). This also fixes Quick-Draw gear variants collapsing to one target. **Gaps:** target choice is a popover list, not click-on-board; no Deflect cost on targeting; only unit targets (no player/battlefield/gear/multi-target); not manually checked in a browser.
- R1 slice 2 landed: `DAMAGE_TARGET` and `BUFF_TARGET` use the first object target given in `PLAY_CARD.targets`; a target no longer on the board fizzles (`EFFECT_FIZZLED`). New events `EFFECT_DAMAGE/BUFF/FIZZLED` are described in the client log. **Gaps:** nothing enumerates or validates targets per card (R2: `getLegalActions` gives none, no target UI), BUFF is permanent (no end-of-turn expiry), no kill/move/ready ops.
- R1 slice 1 landed: `CardDef.effects` (`CardEffect` union: `DRAW`, `GAIN_POINT`), `engine/src/effects.ts` interpreter, run from `playResolver` when a spell resolves; a partial spell with `effects` no longer gets the unimplemented flag. Two scenario tests. **Still to do for R1:** targeted ops (damage, buff, kill, move, ready/exhaust), triggered abilities on the Chain, `getLegalActions` targets (R2), parser (R3).
- R30 CI added (e2e excluded). R12 deferred until R8 confirms rule 432.3. R27: the host bot already caps steps per tick; a per-turn cap is still open.
- Verified at this point: typecheck, lint, check:rules (437 blocks), 437 engine and 298 client tests pass.

## 1. Playable card effects (the main next phase)

The MVP is keyword-only. Of about 1,100 unique cards only 68 are fully playable; the rest resolve their prose effects as no-ops with an "effect not implemented" badge.

| ID | Task | Complexity | Model | Depends on | Notes |
|---|---|---|---|---|---|
| R1 | **IN PROGRESS (slice 1 done)** Effect model: a small executable-effect DSL (targets, damage, draw, buff, kill, move, ready/exhaust, gain points) plus resolver hooks in `playResolver` and triggered-ability support on the Chain | High | Sonnet | none | Foundation for everything below. Must keep the reducer pure and deterministic, keep hidden info out of events, and work with `getLegalActions` (targets). |
| R2 | Targeting UI and legal-action enumeration for targeted spells and abilities (target chooser in the playmat, capped enumeration for the AI) | High | Sonnet | R1 | `getLegalActions` currently generates no targets. |
| R3 | Card text parser / script table: map card text to DSL scripts, starting with the most common effect patterns across the dataset, with a coverage report | High | Sonnet | R1 | Generate `supportLevel: 'full'` automatically only when every sentence parses. Needs frequency analysis of `abilityEffective` first. |
| R4 | Script the first batch of cards (pick two or three decks that are most playable) and write a scenario test per card | Medium | Sonnet | R1, R3 | One agent per deck keeps files separate. |
| R5 | Triggered and delayed abilities (Deathknell, "when you play", "when you conquer/hold"), with Cleanup and Chain interaction (rule 383-394) | High | Sonnet | R1 | Needs a decision on trigger ordering (303.2.a). |
| R6 | Deferred keywords: Legion, Level/XP, Hunt, Flow, Repeat, Predict, Show Off, Weaponmaster, Empower, Deploy, Vision, Disarm | Medium each (Deploy and Vision High) | Sonnet | R1, R5 | Weaponmaster depends on Equip being a real activated ability (R9). |
| R7 | Legend and battlefield abilities (all legends and battlefields are currently "partial") | High | Sonnet | R1, R5 | Passive, triggered and activated variants. |

## 2. Rules fidelity

| ID | Task | Complexity | Model | Depends on | Notes |
|---|---|---|---|---|---|
| R8 | Re-verify the engine against the verbatim Core Rules (the Z3 audit only saw summaries): fetch the rules in pieces or have the user supply the text, produce a discrepancy list, then fix | Medium | Sonnet | none | Rule numbers in some error messages and docs are still best guesses. |
| R9 | Make Equip a real activated ability that goes on the Chain (opponent can respond, targets Deflect), with a proper cost model (Energy and Power) | Medium | Sonnet | R1 | Currently pays Energy only and attaches immediately. |
| R10 | Universal Power `[A]` in the Rune Pool (needs an `any` bucket in `RunePool`) | Medium | Sonnet | none | Requires a type change that touches resources, sanitizer and UI. |
| R11 | Turn player chooses which staged Showdown/Combat starts first (323.11-12, 463.1) instead of lowest index | Medium | Sonnet | none | Needs a new intent and UI prompt. |
| R12 | Burn Out repeated attempts when the Main Deck and Trash are both empty (432.3): one burn out per missing card | Low | Haiku | none | Today stops after one. Small change in `burnout.ts` plus tests. |
| R13 | Heal all units (not only the combat battlefield's) in combat cleanup, and Tank+Backline conflict choice (467.2.c.8) | Low | Haiku | none | No visible effect until non-combat damage exists. |
| R14 | Decide and implement the Hold-at-7 ambiguity once verbatim rules are confirmed (see ASSUMPTIONS.md) | Low | Haiku | R8 | |
| R15 | Other game modes: 1v1 Match (best of 3), FFA3/FFA4, 2v2 | High | Sonnet | none | The engine and UI are two-player (`p0`/`p1`) throughout, so this is a large refactor. Out of scope for now. |

## 3. Product and UX

| ID | Task | Complexity | Model | Depends on | Notes |
|---|---|---|---|---|---|
| R16 | Deck builder UI: browse and filter cards, build and validate a custom deck, save/load, import/export | High | Sonnet | none | Today decks are auto-generated presets or JSON import. |
| R17 | Manual verification pass in a real browser: playmat move/drag, combat dialog over the tutorial sidebar (possible z-index overlap hiding the "Next" button in Lesson 5), all six lessons by hand | Low | Haiku | none | Only jsdom and one e2e path cover these. Fix whatever it finds. |
| R18 | Mobile and tablet layout (the game screen is desktop-first and scrolls vertically) | Medium | Sonnet | none | |
| R19 | Guest reload auto-rejoin (remember the room code and seat token so a guest refresh reconnects without re-entering the code) | Medium | Sonnet | none | Token is already stored; needs a resume entry point and peer reconnect. |
| R20 | Show the reaction countdown to the guest (add the deadline to the wire protocol) | Low | Haiku | none | |
| R21 | Save the solo difficulty in the saved-game header so Resume keeps it | Low | Haiku | none | |
| R22 | Replay viewer: full event log per step instead of only the last step's events | Low | Haiku | none | |
| R23 | Emit a public `CARD_HIDDEN` event for Hidden cards (opponent log shows that a card was hidden, with no card id) | Low | Haiku | none | The event type exists but is never emitted. |
| R24 | Sound, animations and accessibility polish (reduced motion already respected) | Medium | Sonnet | none | |
| R25 | Optional rematch flow and basic match history | Medium | Sonnet | none | |

## 4. Networking and robustness

| ID | Task | Complexity | Model | Depends on | Notes |
|---|---|---|---|---|---|
| R26 | Optional manual copy-paste signalling fallback and/or TURN configuration for strict NATs, behind the existing `Transport` interface | Medium | Sonnet | none | Removes the dependence on the public PeerJS broker. |
| R27 | Bot-side per-turn action cap in the host driver (defence in depth against any future no-progress loop) | Low | Haiku | none | The Equip re-shuffle loop is already fixed. |
| R28 | AI strength: multi-ply search or a better evaluation (it plays conservatively and mostly holds battlefields); difficulty levels | High | Sonnet | R1 | Improves a lot once card effects exist. |
| R29 | Performance profiling of the AI worker and `getLegalActions` on real card pools (fixtures are small) | Medium | Sonnet | none | |

## 5. Project hygiene

| ID | Task | Complexity | Model | Depends on | Notes |
|---|---|---|---|---|---|
| R30 | **Done (partial)** CI workflow: typecheck, lint, check:rules, unit tests. Playwright e2e is not in CI yet. | Low | Haiku | none | `.github/workflows/ci.yml` |
| R31 | Split the large client bundle (Vite warns about chunk size); lazy-load the tutorial and replay screens | Low | Haiku | none | |
| R32 | Fix the `engine/dist` / `tsc -b` emit so stale compiled files can never confuse tooling (build to an ignored `outDir` only) | Low | Haiku | none | Vitest already excludes it. |
| R33 | Seed-fragile tests: stabilise tests whose seeds were adjusted after the id-shuffle change (bot vs bot, solo first-legal-action, persistence batching) | Medium | Sonnet | none | See the Z3 notes. |
| R34 | Open a pull request from `feat/foundation` into `develop` and merge when reviewed | Low | (you) | none | Not done: nothing is merged. |

## Suggested order

1. R17 (manual browser pass) and R8 (verbatim rules check), because they can change everything downstream.
2. R1, then R2 and R3 together, then R4/R5/R6 per deck or keyword group.
3. R16 (deck builder) in parallel with the effect work, since it only needs the card data.
4. Everything else as needed.

## Known limits that are not tasks

- The host's browser holds the full game state, so a host using developer tools can see hidden cards (friendly-play trust model).
- Card data and art are Riot Games material under personal, non-commercial terms; do not deploy publicly.
