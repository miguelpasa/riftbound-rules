# R2: click-to-target

Targeted spells are now played from the board instead of a popover list.

## Flow

1. Click a playable targeted spell in hand. `targetedVariants(legal, id, view)` (client/src/game/interaction.ts) returns the card's legal PLAY_CARD intents when EVERY variant has at least one target and all targets are public objects in the base or on a battlefield. Otherwise the old flow (single variant auto-plays, several open the popover) is kept.
2. `useBoardUi` enters `targeting`. The banner (`TargetBanner.tsx`) reads "Choose target k of N: <card>" with Cancel; Esc also cancels. Highlighted units render in `ObjectCard` as focusable buttons named "Target: <name>" (Enter/Space or click picks).
3. `targetStep(variants, chosen)` keeps only units that follow the chosen prefix in some legal variant, so slot 2 narrows by slot 1. Nothing is invented: all candidates and the submitted intent come from `legal`.
4. When the chosen targets match exactly one distinct variant and nothing more can be picked, that intent is submitted (auto-confirm). If several variants (location / Accelerate) remain, or a shorter variant could still be extended (count spells), confirm buttons appear in the banner. A rejected send keeps the state and toasts the rule error.
5. Cleared automatically if `legal` no longer offers the card. Space/Enter pass shortcut is disabled while targeting.

## Deflect

`deflectPower` sums the Deflect keywords of an opposing highlighted unit (the engine's `deflectExtraCost` needs a full GameState, which the client does not have). The card gets a tooltip and aria-label suffix "Deflect: extra cost applies (+N Power)".

## Unchanged

Right-click menu still lists every variant (popover fallback). Hidden, off-board, player and battlefield targets always fall back to the popover. Card.tsx gained optional `ariaLabel`/`title` props. e2e/helpers.ts `tryPlayHandCard` also clicks the first "Target: ..." button when the Targeting region appears.

## Tests

client/src/game/targeting.test.tsx (6): single target, two-target narrowing, confirm with several variants, Cancel + Esc, no variants, hidden targets fall back to popover. Not verified in a real browser except `e2e/solo.spec.ts` (passes); targeting with real cards is untested in e2e.
