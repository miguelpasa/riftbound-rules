# R48: rematch and match history (R25)

Status: done (client only, solo). Client 426 tests (+3); typecheck, lint green; Playwright rematch (new) + smoke pass on a temporary port-5199 server.

## Rematch

The game-over banner of a solo game has a **Rematch** button (focused by default; Back to menu stays). It starts a new game with the same decks and difficulty and a fresh seed, disposes the finished game, and offers a rematch again. `ActiveGame.rematch` (GameView) carries the closure, built in `SoloFlow` (`Flows.tsx`); `App.rematch` swaps the active game. Multiplayer has no rematch (it needs a new lobby / room; deferred with the other multiplayer work).

## Match history

Saved games already list finished games. They now show the result from your side ("you won" / "you lost" / "draw") and the AI difficulty, using two new optional `GameSummary` fields (`hostSeat`, `difficulty`, filled from the header, so old saves still list, with the old wording). Above the list, `Record vs AI: N won, M lost` counts finished solo games (`soloRecord`, `resultOf` in `Replays.tsx`). Watching a replay was already there.

## Not done

- Multiplayer rematch; per-deck statistics; filtering or paging the history list.
- Deck names in the history (summaries do not carry them).
