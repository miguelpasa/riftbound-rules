# R24: sound, animation and accessibility polish

Status: done (client only). Client 423 tests (+3); typecheck, lint green; Playwright smoke, solo, abilities, tutorial, mobile 15/15 on a temporary port-5199 server.

## Sound (`client/src/app/sound.ts`)

Synthesized with WebAudio, so no asset files and nothing to license. Cues: opponent plays a card, a unit dies, you or the opponent score a point (rising vs falling pair), a Showdown starts, your turn begins, game won or lost. One cue per batch of fresh events (the most significant wins), none for the first batch (history on load/resume). Your own card plays are silent. New setting "Sound effects" (default on, stored in localStorage as `riftbound.sound`). The module is a no-op without an AudioContext (jsdom, old browsers) or if audio is blocked.

## Animation

A 0.22 s "pop" on cards when they appear and on score pips when filled (`.animate-pop` in `index.css`). A global `prefers-reduced-motion: reduce` rule makes every animation and transition effectively instant and disables smooth scrolling.

## Accessibility

- A visible amber focus ring on every `:focus-visible` element, whatever a component sets.
- "Skip to the board" link (visible on focus) and a focusable `#board` landmark on the game screen.
- Existing: aria-live announcer, labelled regions, Escape/focus return on the Concede dialog.

## Not done

- Sound for refused actions (the error toasts stay silent), a volume slider, and per-cue toggles.
- Card move/attack animations (units teleport between zones), damage numbers.
- A full screen-reader pass (only the existing aria-live announcer was checked) and a contrast audit.
- Not verified by ear: tests cover the cue mapping, not the sound itself.
