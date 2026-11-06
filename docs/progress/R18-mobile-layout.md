# R18: mobile layout (game screen)

Status: done (client only). Client 420 tests unchanged; typecheck and lint clean; Playwright mobile (new), abilities (incl. the 390px Gold run) and tutorial (incl. phone width) 13/13 on a temporary port-5199 config.

## What changed (below the `md` breakpoint only; desktop classes are unchanged)

- **Header** is now sticky at every width (it was `lg:` only), so End turn / Pass / Concede stay reachable while scrolling a long board. On phones it is compact: the two scores sit side by side (pips hidden below `sm`, the `x/8` text stays), the phase list is one horizontally scrolling row (scrollbar hidden, the current phase is scrolled into view), connection indicators sit in one row, and the priority text plus the action buttons share one row. Header height went from about 230px to about 165px at 375px wide.
- **Touch targets**: End turn / Pass and Concede are at least 44px tall on phones (`min-h-11`).
- No change to the board, hand, resource panel or dialogs: they already stacked and the hand already scrolled sideways. Page width never overflows (checked at 375 and 390px).

## Tests

`e2e/mobile.spec.ts`: at 390px the page has no horizontal overflow, End turn is in the viewport after scrolling to the bottom and is at least 44px tall.

## Not done

- Tablet-specific layout (the `lg` two-column split starts at 1024px; 768-1023px uses the stacked layout).
- Hand fan / larger hand cards on phones, swipe gestures, landscape tuning.
- Checked by screenshot in the in-app browser at 375x812 only, not on a real device.
