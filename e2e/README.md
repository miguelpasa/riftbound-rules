# End-to-end tests (Playwright)

Real-browser (Chromium, 1280x800) tests of the whole app: menu, solo vs AI, two-player multiplayer
over WebRTC, host reconnect, tutorial and blocked card images.

```
npm run test:e2e                 # whole suite
npx playwright test solo         # one spec
npx playwright test --headed     # watch it
npx playwright show-report       # HTML report (playwright-report/)
```

First time: `npx playwright install chromium`.

## What starts automatically (playwright.config.ts)

- the Vite dev server on :5173 (an already running one is reused)
- a local PeerJS signalling server (`peer` package, `npx peerjs --port 9000 --path /`) on :9000
  (reused if running), so the tests never touch the public broker
- `client/public/cards.json` is built with `npm run cards` if missing (global-setup.ts)

Multiplayer specs open the app with `?peerHost=localhost&peerPort=9000&peerPath=/`; the app's
default peer factory (client/src/app/context.tsx, `peerFactoryFromEnv`) reads those params (or
`VITE_PEER_HOST/PORT/PATH/SECURE`). Without them the public PeerJS broker is used.

Failures leave screenshots and traces in `test-results/` and the report in `playwright-report/`
(both gitignored). Open a trace with `npx playwright show-trace <trace.zip>`.

## Layout

- `helpers.ts`: fixtures (console-error log), app/menu/solo helpers, `playRound`
- `multi.ts`: host+guest setup (`startDuo`), `takeTurn`, `expectInSync`
- `*.spec.ts`: smoke, solo, multiplayer (incl. hidden-hand DOM leak check), reconnect, tutorial, images-blocked
