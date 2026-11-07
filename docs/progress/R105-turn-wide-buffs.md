# R105: Turn-wide enter-ready and one-shot spell discount

Status: done. Fully supported cards 532 -> 535 of 1103 (`npm run cards` full count). Regression diff: no card lost or changed, 3 gained. Engine 932 tests (+3).

## What changed

- `ENTER_READY_THIS_TURN` (`PlayerState.enterReadyTurn`, read by play.ts and token creation); `NEXT_PLAY_DISCOUNT` (`PlayerState.nextPlayDiscount`, folded into `selfEnergyDiscount`, consumed by the next matching play).

