/**
 * Turn and reaction timers for live games (N5). Dependency-free: no engine import, the caller maps the
 * game state into a {@link TimerSituation} and maps {@link TimeoutInfo} back to intents.
 *
 * Which timer runs (first match wins, evaluated by {@link TurnTimer.sync}):
 *   1. gameOver                         -> nothing.
 *   2. mulliganPlayer set (MULLIGAN)    -> MULLIGAN timer (default 60 s) for that player.
 *   3. combatAwaiting set (ASSIGNMENT)  -> ASSIGNMENT timer (default 60 s) for that player.
 *   4. chainLength > 0 or showdown      -> REACTION window (default 30 s) for the actor.
 *   5. phase MAIN and turnMs !== null   -> TURN clock (opt-in, null = unlimited) for the actor.
 *   6. otherwise                        -> nothing armed.
 *
 * Re-arming: the timer restarts only when the (kind, player, revision) key changes. Pass a `revision`
 * (for example the number of committed intents) so that a new situation for the same player, such
 * as a fresh chain link after an auto-pass, gets a fresh window. Without a revision, a timer that
 * already expired is NOT re-armed for an identical key, which prevents a double fire from a repeated
 * sync.
 *
 * Intended timeout policy (see {@link defaultTimeoutPolicy}; the controller maps it to intents):
 *   - REACTION   -> PASS_PRIORITY for the timed-out player.
 *   - TURN       -> END_TURN for the active player.
 *   - MULLIGAN   -> keep the hand (MULLIGAN with cardIds: []).
 *   - ASSIGNMENT -> engine autoAssign for the combat damage (the controller calls the engine helper).
 *
 * `onTick` callbacks fire once per second while a timer is running, for UI countdowns. `pause()` freezes
 * the remaining time and `resume()` continues from it; `dispose()` cancels everything for good.
 */

export type TimerPlayer = 'p0' | 'p1';
export type TimeoutKind = 'REACTION' | 'TURN' | 'MULLIGAN' | 'ASSIGNMENT';

export interface TimeoutInfo {
  kind: TimeoutKind;
  player: TimerPlayer;
}

export interface TimerTick extends TimeoutInfo {
  remainingMs: number;
  paused: boolean;
}

/** The subset of game state the timers need. Map `TurnInfo` / state into this shape. */
export interface TimerSituation {
  actor: TimerPlayer;
  phase: string;
  chainLength: number;
  showdown: boolean;
  combatAwaiting: TimerPlayer | null;
  mulliganPlayer: TimerPlayer | null;
  gameOver: boolean;
  /** Optional: changes whenever a new situation starts (for example the committed intent count). */
  revision?: number | string;
}

export type TimerHandle = ReturnType<typeof setTimeout>;

/** Injectable clock. Defaults to the global Date.now / setTimeout / clearTimeout. */
export interface TimerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const defaultClock: TimerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface TurnTimerOptions {
  onTimeout: (info: TimeoutInfo) => void;
  /** Reaction window for chain and showdown responses. Default 30000. */
  reactionWindowMs?: number;
  /** Per-turn clock for the active player in MAIN. Default null (unlimited). */
  turnMs?: number | null;
  /** Default 60000. */
  mulliganMs?: number;
  /** Default 60000. */
  assignmentMs?: number;
  /** Interval of onTick callbacks. Default 1000. */
  tickMs?: number;
  clock?: Partial<TimerClock>;
}

export interface TimeoutPolicyEntry {
  action: 'PASS_PRIORITY' | 'END_TURN' | 'KEEP_HAND' | 'AUTO_ASSIGN';
  description: string;
}

/** What each timeout means. The controller maps these actions to intents; the timers do not. */
export const defaultTimeoutPolicy: Readonly<Record<TimeoutKind, TimeoutPolicyEntry>> = {
  REACTION: {
    action: 'PASS_PRIORITY',
    description: 'The reacting player passes priority, letting the chain resolve.',
  },
  TURN: {
    action: 'END_TURN',
    description: 'The active player ends the main phase.',
  },
  MULLIGAN: {
    action: 'KEEP_HAND',
    description: 'The player keeps the current hand (MULLIGAN with no cards).',
  },
  ASSIGNMENT: {
    action: 'AUTO_ASSIGN',
    description: 'The engine assigns combat damage automatically.',
  },
};

interface Desired {
  kind: TimeoutKind;
  player: TimerPlayer;
  ms: number;
}

interface Armed extends Desired {
  key: string;
}

function assertPositive(name: string, v: number): void {
  if (!Number.isFinite(v) || v <= 0) throw new RangeError(`${name} must be a positive number, got ${v}`);
}

export class TurnTimer {
  private readonly onTimeout: (info: TimeoutInfo) => void;
  private readonly reactionWindowMs: number;
  private readonly turnMs: number | null;
  private readonly mulliganMs: number;
  private readonly assignmentMs: number;
  private readonly tickMs: number;
  private readonly clock: TimerClock;
  private readonly listeners = new Set<(tick: TimerTick) => void>();

  private armed: Armed | null = null;
  /** The armed timer ran out; it stays armed (no re-fire) until the situation key changes. */
  private expired = false;
  private paused = false;
  private deadlineAt = 0;
  private deadlineHandle: TimerHandle | null = null;
  private tickHandle: TimerHandle | null = null;
  /** Remaining ms while paused (or armed but not yet started because the timer was paused). */
  private frozenRemaining: number | null = null;
  private disposed = false;

  constructor(opts: TurnTimerOptions) {
    this.onTimeout = opts.onTimeout;
    this.reactionWindowMs = opts.reactionWindowMs ?? 30_000;
    this.turnMs = opts.turnMs ?? null;
    this.mulliganMs = opts.mulliganMs ?? 60_000;
    this.assignmentMs = opts.assignmentMs ?? 60_000;
    this.tickMs = opts.tickMs ?? 1000;
    assertPositive('reactionWindowMs', this.reactionWindowMs);
    if (this.turnMs !== null) assertPositive('turnMs', this.turnMs);
    assertPositive('mulliganMs', this.mulliganMs);
    assertPositive('assignmentMs', this.assignmentMs);
    assertPositive('tickMs', this.tickMs);
    this.clock = { ...defaultClock, ...opts.clock };
  }

  /** (Re)arm the timer that applies to `situation`. A no-op when the key is unchanged. */
  sync(situation: TimerSituation): void {
    if (this.disposed) return;
    const want = this.describe(situation);
    const key = want ? `${want.kind}|${want.player}|${situation.revision ?? ''}` : null;
    if (key === (this.armed?.key ?? null)) return;

    this.clearHandles();
    this.expired = false;
    this.frozenRemaining = null;
    if (!want || key === null) {
      this.armed = null;
      return;
    }
    this.armed = { ...want, key };
    if (this.paused) this.frozenRemaining = want.ms;
    else this.startClock(want.ms);
  }

  /** The currently armed timer, or null. */
  current(): TimeoutInfo | null {
    return this.armed ? { kind: this.armed.kind, player: this.armed.player } : null;
  }

  /** Milliseconds left on the armed timer, or null when nothing is armed. */
  remainingMs(): number | null {
    if (!this.armed) return null;
    if (this.expired) return 0;
    if (this.deadlineHandle === null) return this.frozenRemaining ?? this.armed.ms;
    return Math.max(0, this.deadlineAt - this.clock.now());
  }

  pause(): void {
    if (this.disposed || this.paused) return;
    this.paused = true;
    if (this.armed && !this.expired && this.deadlineHandle !== null) {
      this.frozenRemaining = Math.max(0, this.deadlineAt - this.clock.now());
      this.clearHandles();
    }
  }

  resume(): void {
    if (this.disposed || !this.paused) return;
    this.paused = false;
    if (this.armed && !this.expired && this.frozenRemaining !== null) {
      const remaining = this.frozenRemaining;
      this.frozenRemaining = null;
      this.startClock(remaining);
    }
  }

  /** Subscribe to the once-per-second countdown. Returns the unsubscribe function. */
  onTick(cb: (tick: TimerTick) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Cancel all timers and listeners. Later calls are no-ops and onTimeout never fires again. */
  dispose(): void {
    this.disposed = true;
    this.clearHandles();
    this.armed = null;
    this.frozenRemaining = null;
    this.listeners.clear();
  }

  private describe(s: TimerSituation): Desired | null {
    if (s.gameOver) return null;
    if (s.mulliganPlayer !== null) return { kind: 'MULLIGAN', player: s.mulliganPlayer, ms: this.mulliganMs };
    if (s.combatAwaiting !== null) return { kind: 'ASSIGNMENT', player: s.combatAwaiting, ms: this.assignmentMs };
    if (s.chainLength > 0 || s.showdown) return { kind: 'REACTION', player: s.actor, ms: this.reactionWindowMs };
    if (s.phase === 'MAIN' && this.turnMs !== null) return { kind: 'TURN', player: s.actor, ms: this.turnMs };
    return null;
  }

  private startClock(ms: number): void {
    this.deadlineAt = this.clock.now() + ms;
    this.deadlineHandle = this.clock.setTimeout(() => this.fire(), ms);
    this.scheduleTick();
  }

  private fire(): void {
    this.deadlineHandle = null;
    const armed = this.armed;
    if (!armed || this.expired) return;
    this.expired = true;
    this.clearTick();
    this.onTimeout({ kind: armed.kind, player: armed.player });
  }

  private scheduleTick(): void {
    this.clearTick();
    this.tickHandle = this.clock.setTimeout(() => {
      this.tickHandle = null;
      const armed = this.armed;
      if (!armed || this.deadlineHandle === null) return;
      const tick: TimerTick = {
        kind: armed.kind,
        player: armed.player,
        remainingMs: this.remainingMs() ?? 0,
        paused: this.paused,
      };
      for (const cb of [...this.listeners]) cb(tick);
      if (this.deadlineHandle !== null) this.scheduleTick();
    }, this.tickMs);
  }

  private clearTick(): void {
    if (this.tickHandle !== null) this.clock.clearTimeout(this.tickHandle);
    this.tickHandle = null;
  }

  private clearHandles(): void {
    if (this.deadlineHandle !== null) this.clock.clearTimeout(this.deadlineHandle);
    this.deadlineHandle = null;
    this.clearTick();
  }
}
