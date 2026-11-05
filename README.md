# Riftbound Local Duelist

A browser-only 1v1 Duel for Riftbound, the trading card game. A strict rules engine enforces the
official Core Rules, hidden information is kept from the opponent, and a host's browser runs the game.
No game server is needed.

- **Strict rules engine.** Pure TypeScript. Every illegal action is refused with a `[Rule Error] ...`
  message that cites the Core Rule it breaks.
- **Hidden information.** Each player only receives a sanitised view: no opponent hand, no deck order,
  no real card ids for hidden objects.
- **Chain and priority.** Spells and abilities go on the Chain, with Open and Closed states, passing
  priority and Reactions.
- **Peer-to-peer play.** The host's browser is authoritative. The guest connects over a WebRTC data
  channel through PeerJS. The public PeerJS broker is used only for the handshake.
- **Solo vs AI.** A local bot runs in a Web Worker with a 500 ms time budget per decision.
- **Interactive tutorial.** A demo lesson and six lessons play on a real engine game.
- **Replays and saves.** Games are event-sourced into IndexedDB. You can resume a game or watch a
  finished one as a replay, and export replays as JSON.

Docs: [Architecture](docs/ARCHITECTURE.md) | [Rules assumptions](docs/ASSUMPTIONS.md) |
[Writing tutorial lessons](client/src/tutorial/AUTHORING.md) | [Task progress](docs/progress/README.md) |
[Remaining work](docs/REMAINING.md)

## Requirements

- Node.js 20 or newer. The repo does not set an `engines` field, so use a current LTS.
- npm (the repo is an npm workspace with `engine` and `client`).
- Internet access for the one-time card download (`npm run cards`).
- A modern browser with WebRTC, IndexedDB and Web Workers (current Chrome, Edge or Firefox).

## Setup

```bash
npm install
npm run cards   # one-time: downloads the card dataset and builds client/public/cards.json
npm run dev     # starts Vite on http://localhost:5173
```

Open <http://localhost:5173>.

`npm run cards` runs two steps. `scripts/fetch-cards.ts` downloads the Hugging Face dataset
`Wysme/riftbound-cards` to `data/raw/cards.json`, and skips the download if the file exists (pass
`--force` to re-download). `scripts/build-cards.ts` converts it into `client/public/cards.json` and
`client/public/card-aliases.json`. Both outputs are gitignored. If `cards.json` is missing, the app
shows a message telling you to run `npm run cards`.

## How to play

From the main menu:

| Menu item                 | What it does                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Host Game**             | Pick a deck and get a room code. Share the code with your opponent. The game starts when they join.      |
| **Join Game**             | Enter a 6-character room code and pick a deck. The code uses letters and digits with no I, L, O, 0 or 1. |
| **Play vs AI**            | Play a local game against the bot. Everything runs offline.                                              |
| **Tutorial**              | Learn the rules step by step (see below).                                                                |
| **Saved games / Replays** | Resume a saved game, watch a finished game as a replay, export or import replays, or delete saves.       |
| **Settings**              | App settings.                                                                                            |

The tutorial has a demo lesson, **Meet the board**, and six lessons:

1. The Turn Structure
2. Resources: Energy and Power
3. Zones and Movement
4. The Chain: Open and Closed States
5. Showdowns and Combat Might
6. Victory and the Final Point Rule

Tutorial lessons run on a real engine game against a scripted opponent, not the AI. Lesson progress is
stored in localStorage.

## Importing decks

On any deck picker, open **Import deck JSON** and choose a file or paste text. Several decks can be
imported at once and are kept in the browser (localStorage); each can be renamed or deleted. Accepted input:

- a deck object from the external deck builder (`format: "riftbound-deck"`, `version: 1`), an array of
  such objects, or `{ "decks": [ ... ] }`;
- our own single deck list `{ legendId, championId, mainDeck, runeDeck, battlefields }`.

```json
{
  "format": "riftbound-deck", "version": 1, "name": "Akali aggro",
  "eventName": "Regional", "placement": "1st place", "legend": "VEN-139",
  "cards": [
    { "code": "VEN-139", "qty": 1, "zone": "LEGEND", "name": "Akali, Rogue Assassin" },
    { "code": "VEN-021", "qty": 1, "zone": "CHAMPION" },
    { "code": "OGN-057", "qty": 3, "zone": "MAIN" }
  ]
}
```

`zone` is one of `LEGEND`, `CHAMPION`, `MAIN`, `RUNE`, `BATTLEFIELD` (cards are repeated `qty` times) or
`SIDEBOARD` (ignored). Codes are set plus collector number (`OGN-042`); the printed total and letter
variants are matched to our card ids through `cards.json` and `card-aliases.json`. The optional `name` is
used only to pick between printings and to warn about mismatches. Every deck is validated with the
engine rules; decks that fail are listed with their errors and the others still import.

## Networking and trust

**Connection.** Play is WebRTC with PeerJS. The room code only resolves to a peer id during the
handshake. After that, all game traffic flows directly between the two browsers.

- Most home networks and LANs connect without help. The app configures no TURN server, so connections
  behind strict NATs or firewalls can fail.
- The PeerJS public broker is a third-party service. It is used only for the handshake. If it is slow
  or down, new games cannot start, but the rules are unaffected.
- A duel allows one guest at a time.

**Trust model: friendly play.** The host's browser holds the full game state, including the guest's
hand and both deck orders. The host validates every intent, so a guest cannot cheat. A host who opens
devtools can see hidden information. Cryptographic hidden-information protocols are out of scope.

**Host closes the tab.** The game pauses. Reopen the app and resume it from **Saved games / Replays**.
The saved game restores the room under the same peer id, and the guest reconnects automatically.

## Card data and licence

- Card data and card art are copyright Riot Games. They are used under Riot's community terms for
  personal, non-commercial use. The dataset's README restricts use to non-commercial purposes and
  discourages gameplay-simulation clones.
- This repository does **not** contain the dataset or any card art. `data/` and
  `client/public/cards.json` are gitignored. Each person downloads the data with `npm run cards`.
- Do not deploy this app publicly or redistribute the data.
- This project is unaffiliated with Riot Games.

## MVP scope

The engine implements the Riftbound Core Rules (rev 2026-10-09) for a 1v1 Duel: 8 points to win,
2 battlefields, a 4-card opening hand and up to 2 mulligan cards. It covers phases, runes and the Rune
Pool, the Chain and priority, movement and Showdowns, combat, scoring, Burn Out and the cleanup loop.

**Implemented keywords:** Action, Reaction, Tank, Backline, Assault, Shield, Ganking, Accelerate,
Temporary, Hidden, Deflect, Unique, Equip and Quick-Draw.

**Deferred keywords** (typed, not yet implemented): Deathknell, Legion, Level, Hunt, Flow, Repeat,
Predict, Show Off, Weaponmaster, Empower, Deploy, Vision, Disarm.

**Card effects are not executed yet.** Only card keywords work. Prose effects are not run. A card whose
text needs effects shows an **Effect not implemented** badge. Its spell can still be cast and goes on
the Chain, then resolves as a no-op. Of about 1,100 unique cards in the dataset, only 68 are fully
supported by keywords alone. The preset decks prefer those cards.

**Roadmap:** map each card's rules text to executable effects, so that the badge can be removed card
by card. The chain resolver in `engine/src/chain.ts` is the hook for this.

## Testing

| Command                | What it checks                                                                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`             | Vitest suites for the engine and the client.                                                                                                                                                                               |
| `npm run test:scripts` | Vitest suites for the build scripts in `scripts/`.                                                                                                                                                                         |
| `npm run typecheck`    | `tsc -b` across the workspaces.                                                                                                                                                                                            |
| `npm run lint`         | ESLint over the repo.                                                                                                                                                                                                      |
| `npm run check:rules`  | Checks that every engine test block carries a `// Tests Rule <n>` citation.                                                                                                                                                |
| `npm run test:e2e`     | Playwright end-to-end suite (Chromium): smoke, solo vs AI, two-browser host/join, host reload + resume, tutorial, images blocked. Starts the Vite dev server and a local PeerJS server automatically. See `e2e/README.md`. |

Every engine test cites the Core Rule it validates.

## Project structure

```
riftbound-rules/
  engine/            pure, isomorphic rules engine (no DOM or Node APIs)
    src/             reducer, phases, chain, play, combat, scoring, cleanup, sanitize, replay
    src/ai/          determinization and the 1-ply bot (runs in a Web Worker)
    src/types/       GameState, Intent, GameEvent, CardDef, keyword lists
  client/            React + Vite + Tailwind
    src/app/         menu, host/join/solo flows, game view, saved games and replays
    src/host/        HostSession, IndexedDB persistence, replay log, timers
    src/net/         Transport, PeerJS transport, guest session, wire protocol
    src/ai/          bot client and Web Worker
    src/game/        playmat, battlefields, hand, chain and resource panels
    src/tutorial/    lesson runner, gates, validation, lessons/
    public/          cards.json and card-aliases.json (generated, gitignored)
  scripts/           fetch-cards.ts, build-cards.ts, check-rule-citations.mjs, preview-decks.ts
  resources/         card-schema.json and synthetic test fixtures
  data/              downloaded dataset (gitignored)
  docs/              ARCHITECTURE.md, ASSUMPTIONS.md
```

## Where this project departs from the PRD

The official Core Rules win over the original PRD. The full list and the reasoning are in
[docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md). The main corrections:

| PRD said                                               | The engine does                                                                                            |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Phases A-B-C-D only                                    | Awaken, Beginning (with a Scoring step), Channel, Draw, Main (all play, moves and Showdowns), Ending.      |
| Deck-out and the 8th point cite "Rule 607.1"           | No such rule exists. Burn Out is Rule 432. The Final Point rule is 473.1.b.                                |
| Final Point is rejected when it cannot be won          | The player draws a card instead (473.1.b).                                                                 |
| Runes channel face-down and exhausted                  | Runes channel ready (431.2.a).                                                                             |
| Second player's extra rune on turn 1 is stated loosely | A normal Channel is 2 runes. The second player channels 1 extra rune in their first Channel Phase (487.7). |

Hold at 7 points is unrestricted by the Final Point rule. The rules do not say so explicitly. See
ASSUMPTIONS.md.
