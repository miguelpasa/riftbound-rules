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
  GOLD_TOKEN_ID,
  TOKEN_CARDS,
  createGameWithSeating,
  getLegalActions,
  opponentOf,
  playerIndex,
  reduce,
  sanitizeEvents,
  sanitizeFor,
} from '@riftbound/engine';
import type {
  CardDatabase,
  CardDef,
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
import { runEffects } from '../../../engine/src/effects.js';
import { GameProvider, type GameApi } from '../app/gameApi';
import { getUiLegalActions } from '../host/uiLegal';
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
    legal: getUiLegalActions(state, cards, seat),
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
  /** Dev/e2e: give the human this many ready Gold tokens (`?mock&gold=2`) so abilities can be tried. */
  gold?: number;
  /**
   * Dev/e2e (`?mock&buffer=1`): a ready Cinder Grunt with "[E]: Give a unit +2 [M] this turn" starts
   * in the human's base, and Cinder Grunts have "When you play me, give a unit +2 [M] this turn" (R41).
   */
  buffer?: boolean;
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
  let cards: CardDatabase = opts.gold ? { ...FIXTURE_CARDS, ...TOKEN_CARDS } : FIXTURE_CARDS;
  if (opts.buffer) {
    const buff = { op: 'BUFF_TARGET', amount: 2, duration: 'TURN' } as const;
    const grunt = FIXTURE_CARDS['fx-grunt'] as CardDef;
    cards = {
      ...cards,
      'fx-grunt': {
        ...grunt,
        triggers: [{ on: 'PLAY', effects: [buff] }],
        abilities: [{ cost: { exhaust: true }, effects: [buff] }],
      },
    };
    const ps = state.players[playerIndex(seat)] as GameState['players'][number];
    const src = Object.values(state.objects).find(
      (o) => o.cardId === 'fx-grunt' && o.owner === seat && o.zone.kind === 'mainDeck',
    );
    if (src) {
      ps.mainDeck = ps.mainDeck.filter((x) => x !== src.id);
      src.zone = { kind: 'base', player: seat };
      src.ready = true;
      ps.base.push(src.id);
    }
  }
  if (opts.gold) {
    runEffects(
      state,
      seat,
      [{ op: 'PLAY_TOKEN', token: GOLD_TOKEN_ID, count: opts.gold, ready: true }],
      cards,
    );
  }
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
    cards,
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
  const params = new URLSearchParams(location.search);
  const seed = params.get('seed') ?? undefined;
  const gold = Math.min(8, Math.max(0, Number(params.get('gold')) || 0));
  const buffer = params.get('buffer') === '1';
  const api = useMockGameApi({
    ...(seed ? { seed } : {}),
    ...(gold ? { gold } : {}),
    ...(buffer ? { buffer } : {}),
  });
  return (
    <GameProvider value={api}>
      <GameScreen onBackToMenu={() => location.assign(location.pathname)} />
    </GameProvider>
  );
}
