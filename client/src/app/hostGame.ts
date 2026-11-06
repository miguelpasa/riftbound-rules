/**
 * Host-side game assembly: everything that turns "a deck and an opponent" into a running, persisted,
 * timed game with a `GameAdapter`.
 *
 *   startSoloGame     deck + bot deck            -> HostGame            (vs the AI)
 *   openHostLobby     host deck + room code      -> HostLobby           (game starts when a guest joins)
 *   resumeSavedGame   saved game id              -> HostGame            (re-attaches bot / room code)
 *
 * Guest deck (multiplayer): the guest sends its DeckList inside its first HELLO. The host validates it
 * (`validateDeck`, rejecting with `REJECTED DECK_ILLEGAL`, clientSeq 0) and ONLY THEN creates the
 * HostSession/persisted game, so a seat is never claimed with an illegal or missing deck. The buffered
 * HELLO is then replayed into `HostSession.acceptGuest` through {@link replayFirstMessage}.
 * Rejoins (HELLO with a seat token) go straight to the existing session.
 */
import { validateDeck } from '@riftbound/engine';
import type {
  C2S,
  CardDatabase,
  DeckList,
  PlayerId,
  RuleErrorCode,
  S2C,
  Transport,
} from '@riftbound/engine';
import type { BotLike } from '../ai/aiClient';
import { HostSession } from '../host/hostSession';
import {
  restoreHostSession,
  startPersistedHost,
  type GamePersister,
  type GameStorage,
} from '../host/persistence';
import { checkHello } from '../net/protocol';
import {
  createHostPeer,
  type HostPeer,
  type HostStatusDetail,
  type HostTransport,
  type PeerFactory,
} from '../net/peerTransport';
import { generateRoomCode } from '../net/roomCode';
import type { TransportStatus } from '../net/transport';
import { createHostBridge, hostGameApi, type GameAdapter, type HostBridge } from './adapters';
import { HostTimers, type TimerPublish } from './hostTimers';
import { createStore, type Store } from './store';

// ---------------------------------------------------------------- shared types

export interface BotHandle extends BotLike {
  dispose?(): void;
}

export interface BotFactoryOptions {
  cards: CardDatabase;
  deck: DeckList;
  seat: PlayerId;
  seed: string;
  difficulty: 'easy' | 'normal' | 'hard';
}

export interface HostEnv {
  cards: CardDatabase;
  storage: GameStorage;
  peerFactory?: PeerFactory;
  createBot(o: BotFactoryOptions): BotHandle;
  /** Delay between bot actions (default 500 ms; 0 in tests). */
  botDelayMs?: number;
  /** Surface a non-fatal problem to the user (toast). */
  onError(text: string): void;
  /** Show timer progress (deadline etc.); null clears it. */
  onTimer?(p: TimerPublish): void;
  /** Timer clock / durations override (tests). */
  timerOptions?: Partial<
    Pick<
      ConstructorParameters<typeof HostTimers>[0],
      'clock' | 'reactionWindowMs' | 'mulliganMs' | 'assignmentMs' | 'turnMs'
    >
  >;
}

export interface PeerInfo {
  status: TransportStatus;
  detail: HostStatusDetail | null;
  message: string;
}

export interface HostGame {
  readonly gameId: string;
  readonly mode: 'SOLO' | 'MULTIPLAYER';
  readonly session: HostSession;
  readonly adapter: GameAdapter;
  readonly roomCode: string | undefined;
  /** Broker/peer status for multiplayer games (null in solo). */
  readonly peer: Store<PeerInfo> | null;
  dispose(): Promise<void>;
}

export function newSeed(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stable small hash for seeded choices. */
export function hashToUnit(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

export function describeHostPeer(status: TransportStatus, detail: HostStatusDetail | null): string {
  switch (detail) {
    case 'registering':
      return 'Contacting the matchmaking broker...';
    case 'id-taken-retry':
      return 'This room code is still registered at the broker (an earlier session?). Retrying...';
    case 'listening':
      return 'Waiting for opponent...';
    case 'broker-disconnected':
      return 'Lost the connection to the broker. Reconnecting (connected players are not affected)...';
    case 'id-unavailable':
      return 'Could not register this room code with the broker. Go back and try again.';
    case 'destroyed':
      return 'Room closed.';
    default:
      return status === 'open' ? 'Waiting for opponent...' : 'Connecting...';
  }
}

function reportPersistence(env: HostEnv): (err: unknown, op: string) => void {
  const seen = new Set<string>();
  return (err, op) => {
    console.error(`[persist] ${op}`, err);
    const key = op.split(' ')[0] ?? op;
    if (seen.has(key)) return;
    seen.add(key);
    env.onError(
      `Could not save the game to this browser (${key}). Play continues, but it may not be resumable.`,
    );
  };
}

/** Transport wrapper that re-delivers one buffered message to the first `onMessage` subscriber. */
export function replayFirstMessage(inner: HostTransport, first: C2S): Transport<S2C, unknown> {
  let replayed = false;
  return {
    send: (m) => inner.send(m),
    onMessage(cb) {
      const off = inner.onMessage(cb as (m: C2S) => void);
      if (!replayed) {
        replayed = true;
        queueMicrotask(() => cb(first));
      }
      return off;
    },
    onClose: (cb) => inner.onClose(cb),
    close: () => inner.close(),
  };
}

// ---------------------------------------------------------------- assembling a running game

interface AssembleOptions {
  env: HostEnv;
  session: HostSession;
  persister: GamePersister | null;
  bridge: HostBridge;
  gameId: string;
  mode: 'SOLO' | 'MULTIPLAYER';
  roomCode?: string | undefined;
  bot?: BotHandle | undefined;
  timersEnabled: boolean;
  peer?: { handle: HostPeer; info: Store<PeerInfo> } | undefined;
}

function assemble(o: AssembleOptions): HostGame {
  const { env, session, bridge } = o;
  const adapter = hostGameApi(session, bridge, {
    cards: env.cards,
    opponentAlwaysConnected: o.mode === 'SOLO',
  });
  let timers: HostTimers | null = null;
  if (o.timersEnabled) {
    timers = new HostTimers({
      session,
      cards: env.cards,
      bridge,
      humanSeats: o.mode === 'SOLO' ? [session.hostSeat] : [session.hostSeat, session.guestSeat],
      onPublish: (p) => env.onTimer?.(p),
      ...env.timerOptions,
    });
  }
  if (o.bot) {
    session.attachBot(o.bot, {
      delayMs: env.botDelayMs ?? 500,
      onStalled: (message) => env.onError(message),
    });
  }
  let disposed = false;
  return {
    gameId: o.gameId,
    mode: o.mode,
    session,
    adapter,
    roomCode: o.roomCode,
    peer: o.peer?.info ?? null,
    async dispose() {
      if (disposed) return;
      disposed = true;
      timers?.dispose();
      adapter.dispose();
      session.dispose();
      o.bot?.dispose?.();
      o.peer?.handle.destroy();
      env.onTimer?.({ deadline: null, kind: null, player: null });
      try {
        await o.persister?.dispose();
      } catch (e) {
        console.error('[persist] dispose failed', e);
      }
    },
  };
}

// ---------------------------------------------------------------- solo

export interface SoloOptions {
  deck: DeckList;
  botDeck: DeckList;
  difficulty: 'easy' | 'normal' | 'hard';
  seed?: string;
  timersEnabled: boolean;
}

export function startSoloGame(env: HostEnv, o: SoloOptions): HostGame {
  const seed = o.seed ?? newSeed();
  const bridge = createHostBridge();
  const { session, persister, header } = startPersistedHost({
    cards: env.cards,
    hostDeck: o.deck,
    guestDeck: o.botDeck,
    seed,
    mode: 'SOLO',
    difficulty: o.difficulty,
    storage: env.storage,
    onError: reportPersistence(env),
    ...bridge.callbacks,
  });
  const bot = env.createBot({
    cards: env.cards,
    deck: o.botDeck,
    seat: session.guestSeat,
    seed: `${seed}-bot`,
    difficulty: o.difficulty,
  });
  return assemble({
    env,
    session,
    persister,
    bridge,
    gameId: header.gameId,
    mode: 'SOLO',
    bot,
    timersEnabled: o.timersEnabled,
  });
}

// ---------------------------------------------------------------- multiplayer lobby

export interface HostLobbyState {
  roomCode: string;
  peer: PeerInfo;
  /** Set once a guest with a legal deck has joined; the game is then running. */
  game: HostGame | null;
  /** The last guest that was turned away (illegal deck, version mismatch), for display. */
  rejected: string | null;
}

export interface HostLobby {
  readonly roomCode: string;
  readonly state: Store<HostLobbyState>;
  /** Closes the room. After the game started this is a no-op: the game owns the peer. */
  dispose(): void;
}

export interface LobbyOptions {
  deck: DeckList;
  timersEnabled: boolean;
  roomCode?: string;
  seed?: string;
}

function refuseGuest(t: HostTransport, code: RuleErrorCode, message: string): void {
  try {
    t.send({ type: 'REJECTED', clientSeq: 0, code, message });
  } catch {
    /* link already gone */
  }
  // Give the frame a moment to flush before closing.
  setTimeout(() => {
    try {
      t.close();
    } catch {
      /* ignore */
    }
  }, 50);
}

export function openHostLobby(env: HostEnv, o: LobbyOptions): HostLobby {
  const roomCode = o.roomCode ?? generateRoomCode();
  const seed = o.seed ?? newSeed();
  const bridge = createHostBridge();
  const info = createStore<PeerInfo>({
    status: 'connecting',
    detail: 'registering',
    message: describeHostPeer('connecting', 'registering'),
  });
  const state = createStore<HostLobbyState>({
    roomCode,
    peer: info.get(),
    game: null,
    rejected: null,
  });
  info.subscribe(() => state.update({ peer: info.get() }));
  const handle = createHostPeer(roomCode, env.peerFactory ? { peerFactory: env.peerFactory } : {});
  handle.onStatus((status, detail) =>
    info.set({ status, detail, message: describeHostPeer(status, detail) }),
  );
  let game: HostGame | null = null;
  let closed = false;

  handle.onConnection((t) => {
    if (closed) return;
    if (game) {
      game.session.acceptGuest(t); // rejoin (the session checks the seat token)
      return;
    }
    const off = t.onMessage((msg) => {
      if (game || msg.type !== 'HELLO') return; // lobby only cares about the first HELLO
      off();
      const hello = checkHello(msg);
      if (!hello.ok) {
        const m = `Protocol mismatch (host ${hello.expected}, you ${hello.got}).`;
        state.update({ rejected: m });
        refuseGuest(t, 'ENGINE_VERSION_MISMATCH', m);
        return;
      }
      if (!msg.deck) {
        const m = 'No deck was sent with the join request.';
        state.update({ rejected: m });
        refuseGuest(t, 'DECK_ILLEGAL', m);
        return;
      }
      const verdict = validateDeck(env.cards, msg.deck);
      if (!verdict.ok) {
        const m = `Your deck is not legal: ${verdict.errors.join(' ')}`;
        state.update({ rejected: `A player's deck was rejected: ${verdict.errors[0] ?? ''}` });
        refuseGuest(t, 'DECK_ILLEGAL', m.slice(0, 1500));
        return;
      }
      try {
        const { session, persister, header } = startPersistedHost({
          cards: env.cards,
          hostDeck: o.deck,
          guestDeck: msg.deck,
          seed,
          mode: 'MULTIPLAYER',
          roomCode,
          storage: env.storage,
          onError: reportPersistence(env),
          ...bridge.callbacks,
        });
        game = assemble({
          env,
          session,
          persister,
          bridge,
          gameId: header.gameId,
          mode: 'MULTIPLAYER',
          roomCode,
          timersEnabled: o.timersEnabled,
          peer: { handle, info },
        });
        session.acceptGuest(replayFirstMessage(t, msg));
        state.update({ game, rejected: null });
      } catch (e) {
        console.error('[host] could not start the game', e);
        env.onError('Could not start the game. Check the console for details.');
        refuseGuest(t, 'DECK_ILLEGAL', 'The host could not start the game.');
      }
    });
  });

  return {
    roomCode,
    state,
    dispose() {
      if (closed || game) return;
      closed = true;
      handle.destroy();
    },
  };
}

// ---------------------------------------------------------------- resume

export type ResumeResult = { ok: true; game: HostGame } | { ok: false; message: string };

export async function resumeSavedGame(
  env: HostEnv,
  gameId: string,
  opts: { timersEnabled: boolean; difficulty?: 'easy' | 'normal' | 'hard' },
): Promise<ResumeResult> {
  // The saved header wins; `opts.difficulty` is only a fallback for saves made before the header had it.
  const bridge = createHostBridge();
  const res = await restoreHostSession(env.storage, gameId, env.cards, bridge.callbacks, {
    onError: reportPersistence(env),
  });
  if (!res.ok) return { ok: false, message: res.message };
  const { session, header, persister } = res;
  if (header.mode === 'SOLO') {
    const bot = env.createBot({
      cards: env.cards,
      deck: header.decks[1],
      seat: session.guestSeat,
      seed: `${header.seed}-bot-resume-${res.intentCount}`,
      difficulty: header.difficulty ?? opts.difficulty ?? 'normal',
    });
    return {
      ok: true,
      game: assemble({
        env,
        session,
        persister,
        bridge,
        gameId,
        mode: 'SOLO',
        bot,
        timersEnabled: opts.timersEnabled,
      }),
    };
  }
  const code = header.roomCode;
  if (!code) {
    session.dispose();
    await persister?.dispose();
    return {
      ok: false,
      message: 'This multiplayer game has no room code, so it cannot be resumed.',
    };
  }
  const info = createStore<PeerInfo>({
    status: 'connecting',
    detail: 'registering',
    message: describeHostPeer('connecting', 'registering'),
  });
  const handle = createHostPeer(code, env.peerFactory ? { peerFactory: env.peerFactory } : {});
  handle.onStatus((status, detail) =>
    info.set({ status, detail, message: describeHostPeer(status, detail) }),
  );
  handle.onConnection((t) => session.acceptGuest(t));
  return {
    ok: true,
    game: assemble({
      env,
      session,
      persister,
      bridge,
      gameId,
      mode: 'MULTIPLAYER',
      roomCode: code,
      timersEnabled: opts.timersEnabled,
      peer: { handle, info },
    }),
  };
}
