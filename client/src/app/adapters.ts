/**
 * GameApi adapters: turn a HostSession / GuestSession into a `GameApi` snapshot source for React.
 *
 * - `hostGameApi(session, bridge, ...)`: the host's own seat. The HostSession is created with the
 *   bridge's callbacks (it cannot be handed callbacks afterwards), then bound here.
 * - `guestGameApi(guest, cards)`: the joined player's seat; `send` resolves from the host's answer.
 * - `useGameApi(adapter)`: `useSyncExternalStore` over any adapter. Snapshots are referentially stable
 *   until something changes.
 */
import { useSyncExternalStore } from 'react';
import { ruleError } from '@riftbound/engine';
import type {
  CardDatabase,
  ClientGameState,
  GameEvent,
  Intent,
  PlayerId,
  RuleError,
} from '@riftbound/engine';
import type { HostSession } from '../host/hostSession';
import type { GuestSession } from '../net/guestSession';
import type { ConnectionStatus, GameApi } from './gameApi';

export const MAX_RECENT_EVENTS = 50;
export const GUEST_SEND_TIMEOUT_MS = 5000;

export interface GameAdapter {
  /** The current API, or null until a guest has received its first view. */
  getSnapshot(): GameApi | null;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export function useGameApi(adapter: GameAdapter): GameApi | null {
  return useSyncExternalStore(adapter.subscribe, adapter.getSnapshot, adapter.getSnapshot);
}

class Emitter {
  private readonly listeners = new Set<() => void>();
  readonly subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  protected emit(): void {
    for (const l of [...this.listeners]) l();
  }
}

// ---------------------------------------------------------------- host

type UpdateCb = (view: ClientGameState, events: GameEvent[], legal: Intent[]) => void;

/**
 * Callback hub handed to `HostSession` at construction. Anything (the adapter, the timer controller)
 * can subscribe to it, and it lets the session be built before its consumers exist.
 */
export interface HostBridge {
  readonly callbacks: {
    onLocalUpdate: UpdateCb;
    onOpponentStatus: (connected: boolean) => void;
    onGameOver: (winner: PlayerId | null) => void;
  };
  onUpdate(cb: UpdateCb): () => void;
  onOpponent(cb: (connected: boolean) => void): () => void;
  onGameOver(cb: (winner: PlayerId | null) => void): () => void;
}

export function createHostBridge(): HostBridge {
  const upd = new Set<UpdateCb>();
  const opp = new Set<(c: boolean) => void>();
  const over = new Set<(w: PlayerId | null) => void>();
  const fan = <A extends unknown[]>(set: Set<(...a: A) => void>, ...args: A): void => {
    for (const cb of [...set]) {
      try {
        cb(...args);
      } catch (e) {
        console.error('[bridge] listener threw', e);
      }
    }
  };
  const add = <T>(set: Set<T>, cb: T): (() => void) => {
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  };
  return {
    callbacks: {
      onLocalUpdate: (v, e, l) => fan(upd, v, e, l),
      onOpponentStatus: (c) => fan(opp, c),
      onGameOver: (w) => fan(over, w),
    },
    onUpdate: (cb) => add(upd, cb),
    onOpponent: (cb) => add(opp, cb),
    onGameOver: (cb) => add(over, cb),
  };
}

export interface HostGameApiOptions {
  cards: CardDatabase;
  /** SOLO: the AI opponent counts as always connected. */
  opponentAlwaysConnected?: boolean;
}

class HostAdapter extends Emitter implements GameAdapter {
  private view: ClientGameState;
  private legal: Intent[];
  private events: GameEvent[] = [];
  private opponent: boolean;
  private snapshot: GameApi | null = null;
  private readonly offs: Array<() => void> = [];

  constructor(
    private readonly session: HostSession,
    bridge: HostBridge,
    private readonly opts: HostGameApiOptions,
  ) {
    super();
    const seat = session.hostSeat;
    this.view = session.getView(seat);
    this.legal = session.getLegal(seat);
    this.opponent = opts.opponentAlwaysConnected ?? session.isGuestConnected();
    this.offs.push(
      bridge.onUpdate((view, events, legal) => {
        this.view = view;
        this.legal = legal;
        if (events.length > 0) this.events = [...this.events, ...events].slice(-MAX_RECENT_EVENTS);
        this.changed();
      }),
      bridge.onOpponent((connected) => {
        if (this.opts.opponentAlwaysConnected) return;
        this.opponent = connected;
        this.changed();
      }),
    );
  }

  private changed(): void {
    this.snapshot = null;
    this.emit();
  }

  readonly getSnapshot = (): GameApi => {
    this.snapshot ??= {
      cards: this.opts.cards,
      seat: this.session.hostSeat,
      view: this.view,
      legal: this.legal,
      recentEvents: this.events,
      connection: 'connected',
      opponentConnected: this.opponent,
      gameOver:
        this.view.gameStatus === 'IN_PROGRESS' ? null : { winner: this.view.winner ?? null },
      send: (intent) => Promise.resolve(this.session.localIntent(intent)),
    };
    return this.snapshot;
  };

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
  }
}

export function hostGameApi(
  session: HostSession,
  bridge: HostBridge,
  opts: HostGameApiOptions,
): GameAdapter {
  return new HostAdapter(session, bridge, opts);
}

// ---------------------------------------------------------------- guest

export interface GuestGameAdapter extends GameAdapter {
  readonly session: GuestSession;
}

export interface GuestGameApiOptions {
  /** How long `send` waits for the host's answer (default 5000 ms). */
  sendTimeoutMs?: number;
}

interface Pending {
  seq: number;
  resolve: (r: { ok: true } | RuleError) => void;
  timer: ReturnType<typeof setTimeout>;
}

class GuestAdapter extends Emitter implements GuestGameAdapter {
  private events: GameEvent[] = [];
  private opponent = true;
  private gameOverState: { winner: PlayerId | null } | null = null;
  private snapshot: GameApi | null = null;
  private readonly pending: Pending[] = [];
  private readonly offs: Array<() => void> = [];
  private readonly timeoutMs: number;

  constructor(
    readonly session: GuestSession,
    private readonly cards: CardDatabase,
    opts: GuestGameApiOptions,
  ) {
    super();
    this.timeoutMs = opts.sendTimeoutMs ?? GUEST_SEND_TIMEOUT_MS;
    this.opponent = session.opponentConnected;
    const go = session.gameOver;
    this.gameOverState = go ? { winner: go.winner } : null;
    this.offs.push(
      session.onState((_view, events) => {
        if (events.length > 0) this.events = [...this.events, ...events].slice(-MAX_RECENT_EVENTS);
        // The host answered with a new state: every in-flight intent was accepted or superseded.
        this.settle(() => true, { ok: true });
        this.changed();
      }),
      session.onRejected((info) => {
        if (info.clientSeq === 0) {
          this.changed(); // handshake refusal: status changes are reported separately
          return;
        }
        const err: RuleError = { ok: false, code: info.code, message: info.message };
        this.settle((p) => p.seq === info.clientSeq, err);
      }),
      session.onGameOver((winner) => {
        this.gameOverState = { winner };
        this.changed();
      }),
      session.onOpponentStatus((connected) => {
        this.opponent = connected;
        this.changed();
      }),
      session.onStatus(() => this.changed()),
    );
  }

  private changed(): void {
    this.snapshot = null;
    this.emit();
  }

  private settle(match: (p: Pending) => boolean, result: { ok: true } | RuleError): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i] as Pending;
      if (!match(p)) continue;
      this.pending.splice(i, 1);
      clearTimeout(p.timer);
      p.resolve(result);
    }
  }

  private send = (intent: Intent): Promise<{ ok: true } | RuleError> => {
    const seq = this.session.sendIntent(intent);
    if (seq < 0) {
      return Promise.resolve(ruleError('NOT_FOUND', 'Not connected to the host'));
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.pending.findIndex((p) => p.seq === seq);
        if (i >= 0) this.pending.splice(i, 1);
        resolve(ruleError('UNKNOWN_INTENT', 'The host did not answer in time'));
      }, this.timeoutMs);
      this.pending.push({ seq, resolve, timer });
    });
  };

  readonly getSnapshot = (): GameApi | null => {
    if (this.snapshot) return this.snapshot;
    const view = this.session.view;
    const seat = this.session.seat;
    if (!view || !seat) return null;
    const status = this.session.status;
    const go = this.gameOverState;
    this.snapshot = {
      cards: this.cards,
      seat,
      view,
      legal: this.session.legal,
      recentEvents: this.events,
      connection: status satisfies ConnectionStatus,
      opponentConnected: this.opponent,
      gameOver: go ?? (view.gameStatus === 'IN_PROGRESS' ? null : { winner: view.winner ?? null }),
      send: this.send,
    };
    return this.snapshot;
  };

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    this.settle(() => true, ruleError('GAME_OVER', 'Left the game'));
  }
}

export function guestGameApi(
  session: GuestSession,
  cards: CardDatabase,
  opts: GuestGameApiOptions = {},
): GuestGameAdapter {
  return new GuestAdapter(session, cards, opts);
}
