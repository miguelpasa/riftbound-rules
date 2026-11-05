# Architecture

How Riftbound Local Duelist is built. For setup and play, see the [README](../README.md). For rules
decisions, see [ASSUMPTIONS.md](ASSUMPTIONS.md).

## Layers

| Layer                     | Location                                                                  | Responsibility                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Engine**                | `engine/src`                                                              | Pure, isomorphic TypeScript. The only source of rules truth. No DOM, Node or network APIs.                                               |
| **Reduce pipeline**       | `engine/src/reducer.ts`                                                   | `reduce(state, cards, intent)` runs one intent, then the Cleanup loop.                                                                   |
| **Cleanup loop**          | `engine/src/cleanup.ts`                                                   | Repeats the ordered Cleanup steps (Rules 318-324) until stable. A hard cap of 25 passes (`MAX_CLEANUP_ITERATIONS`) is a circuit breaker. |
| **Sanitiser**             | `engine/src/sanitize.ts`                                                  | `sanitizeFor(state, seat)` and `sanitizeEvents` produce what a seat may see.                                                             |
| **Host / guest sessions** | `client/src/host/hostSession.ts`, `client/src/net/guestSession.ts`        | HostSession owns the real state. GuestSession keeps the latest view and sends intents.                                                   |
| **Transport**             | `client/src/net/transport.ts`, `peerTransport.ts`, `loopbackTransport.ts` | Message channel. PeerJS (WebRTC) in production, in-memory loopback in tests.                                                             |
| **Persistence**           | `client/src/host/persistence.ts`, `replayLog.ts`                          | Event-sourced IndexedDB store (`riftbound` database).                                                                                    |
| **AI**                    | `engine/src/ai/*`, `client/src/ai/*`                                      | Determinization and a 1-ply bot. Runs in a Web Worker with a 500 ms budget.                                                              |
| **Tutorial**              | `client/src/tutorial/*`, `engine/src/sandbox.ts`                          | A real engine game with state surgery, a scripted opponent and step gates.                                                               |
| **UI**                    | `client/src/app`, `client/src/game`, `client/src/components`              | React screens. Renders only sanitised views.                                                                                             |

## Data flow

Host and guest play through the same reducer. Only the host runs it.

```
  GUEST browser                         HOST browser (authoritative)
  ─────────────                         ────────────────────────────
  GuestSession                          HostSession
    │  intent (clientSeq)                 │
    ├───────────► PeerJS data channel ──► │ apply(seat, intent)
    │                                     │   validate: reduce(clone) and keep result
    │                                     ▼
    │                              GameState (full, never sent)
    │                                     │  reduce → Cleanup loop
    │                                     │  events
    │                                     ├──► persistence.append(intent)  (IndexedDB)
    │                                     ├──► checkpoint at turn start / game end
    │                                     │
    │                                     ├── sanitizeFor(state, 'p0') ──► host UI
    │                                     └── sanitizeFor(state, 'p1') ──┐
    │  view + sanitised events  ◄─────── PeerJS data channel ◄──────────┘
    ▼
  renders view (no hidden ids)

  Solo / Tutorial: same reducer in the same tab, no transport.
  AI: sanitised view ──► Web Worker ──► determinize ──► reduce per candidate ──► intent
```

Errors go back to the sender as `REJECTED` with the engine's `[Rule Error] ...` text. A handshake
refusal uses `clientSeq: 0`.

## Key invariants

1. **Purity.** `reduce` never mutates its input and never throws. It returns a new state with events,
   or a `RuleError`. The validator runs `reduce` on a clone and discards the result, so there is no second
   rules check to drift.
2. **Determinism by seed.** All randomness lives in `GameState.rng` (sfc32 plain data). The same seed,
   decks and intents always produce the same game. Replays and resumes depend on this.
3. **No hidden ids on the wire.** A hidden object is sent under an opaque token
   (`hidden:<owner>:<zone>:<index>`), regenerated per call, so it never links to a card's real id. The
   host's own hand keeps real ids because intents reference them. Tests check that no message leaks
   opponent data.
4. **Bounded Cleanup.** At most 25 Cleanup passes. A breach aborts the game with a logged error instead
   of freezing the tab.
5. **Isomorphic engine.** No DOM or Node APIs in `engine/src`, so the host, guest, worker and tutorial
   share one implementation.
6. **Every rule-bearing test cites a rule.** `npm run check:rules` fails if an engine test block lacks a
   `// Tests Rule <n>` comment.
7. **Replays are version-locked.** `ENGINE_VERSION` is stored with each save and replay. A mismatched
   engine version is refused.

## Persistence

- **Event sourcing.** The durable record of a game is its header (seed, decks, engine version) and an
  append-only log of accepted intents. Writes are batched and kept off the UI path.
- **Checkpoints.** A full serialised state is written at the start of each turn and at game end. A
  restore loads the latest checkpoint and replays only the later intents. Without a checkpoint it
  replays from the seed.
- **Replays.** The same log is a replay. Export adds a cyrb53 checksum. The checksum detects accidental
  corruption, not tampering.
- **Hidden information stays local.** Saved games contain both hands and deck orders. They never leave
  the host's browser. Replays are shown only after the game ends.

## Networking

- Handshake: the guest resolves the room code to a peer id through the PeerJS broker. Game traffic then
  runs over the WebRTC data channel, not through the broker.
- Protocol: JSON string frames, length-capped before parsing. Heartbeats (`__hb`) stay inside the
  transport. HELLO and WELCOME carry the seat token, so a reconnecting guest keeps its seat and its
  `clientSeq`.
- One guest at a time. A newer connection that sends a valid HELLO replaces the older one.
- The host is authoritative, so a guest cannot submit an illegal intent.

## AI

- A decision starts by determinizing the sanitised view. Unknown cards are filled from a mirror prior
  (the bot's own deck, minus visible cards). The bot uses its own PRNG, so simulated draws never reveal
  the real next card.
- The bot applies each pruned candidate with the real reducer, settles the result (auto-passes and
  auto-assigns), and scores it with `evaluate`. It takes the best candidate found before the time budget
  runs out, otherwise a greedy fallback.
- The host times out a bot decision after 5 s and falls back to a default action, so a stuck worker
  cannot wedge the game.

## Tutorial

- A lesson is plain data (`LessonDef`). `setup` builds the board with `Sandbox` surgery on top of the
  real engine. Steps decide what the learner may do (`gate`), when a step is done (`done`) and what the
  scripted opponent does (`ctx.opponentPlay`, `opponentAuto`).
- Gates filter the intents the UI offers, and the engine still decides legality. Rule errors are shown
  as the real engine text.
- `validateLesson` and the lesson tests check every registered lesson.

## How to add a keyword

1. Add the name to `MvpKeywordName` and `MVP_KEYWORDS` in `engine/src/types/card.ts`. Move it out of
   `DEFERRED_KEYWORDS` if it was there.
2. Implement the rule in the relevant module (for example `keywords.ts` for timing and legality,
   `combat.ts` for damage order) and call it from the reducer path that needs it.
3. Add tests that each cite a rule with `// Tests Rule <n>`.
4. Add the keyword to `KEYWORD_LOOKUP` in `scripts/lib/cardConvert.ts` if its text token is not already
   recognised. `computeSupportLevel` then marks matching cards `full`.
5. Run `npm run cards`, `npm test`, `npm run check:rules` and `npm run typecheck`.

## How to add a card effect

Effects are not executed yet. A spell whose text is not keyword-only is flagged as unimplemented and
resolves as a no-op with `EFFECT_UNIMPLEMENTED`. The hook for real effects is the chain resolver:

1. `ChainResolver` in `engine/src/chain.ts` resolves a chain item. `defaultResolver` is the current
   behaviour: spells go to the Trash and unimplemented effects emit an event.
2. Add an effect module that takes the state, the item and the card, and returns the new state and its
   events. Route the card to it, for example by card id or by a parsed effect.
3. Clear `unimplementedEffect` for that card. The card's `supportLevel` is computed from its text by
   `computeSupportLevel`, so update that function or its tests if the rule changes.
4. Test it against the real reducer with a rule citation, and check that the card no longer shows the
   "Effect not implemented" badge.
