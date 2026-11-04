/**
 * A REAL local engine game exposed as a GameApi (no network): the foundation for `?mock` and the
 * tutorial sandbox.
 *
 *   const local = createLocalGameApi({ cards, seat: 'p0', opponent: bot });
 *   local.api            // current GameApi snapshot (stable until the state changes)
 *   local.subscribe(fn)  // notified after every committed intent
 *   local.getState()     // authoritative GameState (tests / tutorial scripting)
 *   local.sendAs(p, i)   // drive the other seat by hand (hotseat / scripted tutorial steps)
 *
 * view = sanitizeFor(state, seat); legal = getLegalActions; recentEvents = sanitizeEvents(...).
 * The opponent seat (if a bot is given) acts whenever `actorToAct` says it must, with a small delay
 * so the human can follow along; if the bot returns nothing the first pass/end/legal action is used.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  actorToAct,
  createGameWithSeating,
  getLegalActions,
  opponentOf,
  reduce,
  sanitizeEvents,
  sanitizeFor,
} from '@riftbound/engine';
import type {
  CardDatabase,
  DeckList,
  GameEvent,
  GameState,
  Intent,
  PlayerId,
  RuleError,
} from '@riftbound/engine';
import {
  FIXTURE_CARDS,
  FIXTURE_DECK_A,
  FIXTURE_DECK_B,
} from '../../../engine/src/testing/fixtures.js';
import { createAiBot, type BotLike } from '../ai/aiClient';
import { GameProvider, type GameApi } from '../app/gameApi';
import { GameScreen } from '../game/GameScreen';

export interface CommitInfo {
  by: PlayerId;
  intent: Intent;
  state: GameState;
  events: GameEvent[];
}

export interface LocalGameOptions {
  cards: CardDatabase;
  /** Start from this state; otherwise a fresh game is created from `decks`/`seed`. */
  state?: GameState;
  decks?: [DeckList, DeckList];
  seed?: string;
  seat: PlayerId;
  /** Bot driving the other seat. `null`/omitted = nobody (use `sendAs`). */
  opponent?: BotLike | null;
  /** Pause before each bot action (default 450 ms; 0 in tests). */
  botDelayMs?: number;
  onCommit?: (info: CommitInfo) => void;
}

export interface LocalGame {
  /** Current snapshot; referentially stable until the next commit. */
  readonly api: GameApi;
  subscribe(listener: () => void): () => void;
  getState(): GameState;
  /** Apply an intent on behalf of any seat (bypasses the UI). */
  sendAs(player: PlayerId, intent: Intent): Promise<{ ok: true } | RuleError>;
  /** (Re)start bot driving; call from an effect. */
  start(): void;
  /** Stop bot driving. */
  stop(): void;
  /** Resolves once the bot has nothing left to do (tests). */
  idle(): Promise<void>;
}

const MAX_EVENTS = 120;
const RECENT = 40;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function fallbackIntent(state: GameState, cards: CardDatabase, seat: PlayerId): Intent | null {
  const legal = getLegalActions(state, cards, seat).filter((i) => i.type !== 'CONCEDE');
  return legal.find((i) => i.type === 'PASS_PRIORITY' || i.type === 'END_TURN') ?? legal[0] ?? null;
}

export function createLocalGameApi(opts: LocalGameOptions): LocalGame {
  const { cards, seat } = opts;
  const oppSeat = opponentOf(seat);
  const delay = opts.botDelayMs ?? 450;
  let state: GameState =
    opts.state ??
    createGameWithSeating(
      cards,
      opts.decks ?? [FIXTURE_DECK_A, FIXTURE_DECK_B],
      opts.seed ?? 'mock',
    ).state;
  let events: GameEvent[] = [];
  let snapshot: GameApi | null = null;
  let running = true;
  let driving: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  const commit = (intent: Intent) => {
    const r = reduce(state, cards, intent);
    if (!r.ok) return r;
    state = r.state;
    events = [...events, ...r.events].slice(-MAX_EVENTS);
    snapshot = null;
    opts.onCommit?.({ by: intent.playerId, intent, state, events: r.events });
    for (const l of [...listeners]) l();
    return r;
  };

  const sendAs = async (player: PlayerId, intent: Intent): Promise<{ ok: true } | RuleError> => {
    const r = commit({ ...intent, playerId: player } as Intent);
    if (!r.ok) return r;
    if (player === seat) kick();
    return { ok: true };
  };

  const botTurn = async (): Promise<void> => {
    const bot = opts.opponent;
    if (!bot) return;
    for (let n = 0; n < 1000 && running; n++) {
      if (state.gameStatus !== 'IN_PROGRESS' || actorToAct(state) !== oppSeat) return;
      if (delay > 0) await sleep(delay);
      if (!running || state.gameStatus !== 'IN_PROGRESS' || actorToAct(state) !== oppSeat) return;
      let intent: Intent | null = null;
      try {
        intent = await bot.decide(sanitizeFor(state, oppSeat));
      } catch {
        intent = null;
      }
      if (!running || actorToAct(state) !== oppSeat) continue;
      let r = intent ? commit({ ...intent, playerId: oppSeat } as Intent) : null;
      if (!r || !r.ok) {
        const fb = fallbackIntent(state, cards, oppSeat);
        if (!fb) return;
        r = commit(fb);
        if (!r.ok) return;
      }
    }
  };

  function kick(): void {
    if (driving || !opts.opponent) return;
    driving = botTurn().finally(() => {
      driving = null;
      // The state may have moved on while the loop was finishing.
      if (running && state.gameStatus === 'IN_PROGRESS' && actorToAct(state) === oppSeat) kick();
    });
  }

  const build = (): GameApi => ({
    cards,
    seat,
    view: sanitizeFor(state, seat),
    legal: getLegalActions(state, cards, seat),
    recentEvents: sanitizeEvents(events.slice(-RECENT), seat),
    connection: 'connected',
    opponentConnected: true,
    gameOver: state.gameStatus === 'IN_PROGRESS' ? null : { winner: state.winner ?? null },
    send: (intent) => sendAs(seat, intent),
  });

  const game: LocalGame = {
    get api() {
      snapshot ??= build();
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => state,
    sendAs,
    start() {
      running = true;
      kick();
    },
    stop() {
      running = false;
    },
    async idle() {
      while (driving) await driving;
    },
  };
  return game;
}

/** Subscribes a component to a LocalGame and returns its current GameApi. */
export function useLocalGameApi(local: LocalGame): GameApi {
  useEffect(() => {
    local.start();
    return () => local.stop();
  }, [local]);
  return useSyncExternalStore(
    local.subscribe,
    () => local.api,
    () => local.api,
  );
}

export interface MockGameOptions {
  seed?: string;
  /** Pass `null` for no opponent bot. */
  opponent?: BotLike | null;
  botDelayMs?: number;
}

/** A local game on the synthetic fixture decks; the human plays deck A, the AI plays deck B. */
export function createMockGame(opts: MockGameOptions = {}): LocalGame {
  const seed = opts.seed ?? 'mock';
  const { state, seatOfDeck } = createGameWithSeating(
    FIXTURE_CARDS,
    [FIXTURE_DECK_A, FIXTURE_DECK_B],
    seed,
  );
  const seat = seatOfDeck[0];
  const opponent =
    opts.opponent !== undefined
      ? opts.opponent
      : createAiBot({
          cards: FIXTURE_CARDS,
          deck: FIXTURE_DECK_B,
          seat: opponentOf(seat),
          seed: `${seed}-bot`,
          budgetMs: 300,
        });
  return createLocalGameApi({
    cards: FIXTURE_CARDS,
    state,
    seat,
    opponent,
    ...(opts.botDelayMs !== undefined ? { botDelayMs: opts.botDelayMs } : {}),
  });
}

/** Hook form: creates the mock game once per mount. */
export function useMockGameApi(opts?: MockGameOptions): GameApi {
  const [local] = useState(() => createMockGame(opts));
  return useLocalGameApi(local);
}

/** The full screen on a mock game. Mount at `?mock` (see App.tsx notes in the task report). */
export function MockGameScreen() {
  const seed = new URLSearchParams(location.search).get('seed') ?? undefined;
  const api = useMockGameApi(seed ? { seed } : undefined);
  return (
    <GameProvider value={api}>
      <GameScreen onBackToMenu={() => location.assign(location.pathname)} />
    </GameProvider>
  );
}
