/**
 * HostSession: the authoritative game session that runs in the HOST's browser.
 *
 * - Owns the full GameState (never sent anywhere); the guest only ever receives `sanitizeFor` views.
 * - Consumes `Transport` objects (PeerJS, loopback...) so it has no network imports of its own.
 * - Intents from the host player ({@link HostSession.localIntent}), the guest (via a Transport) and
 *   an optional bot all go through the same private `apply(seat, intent)`.
 *
 * Wire conventions used for handshake-level failures: `REJECTED` with `clientSeq: 0` (real client
 * sequence numbers start at 1), followed by closing the transport.
 */
import {
  PROTOCOL_VERSION,
  actorToAct,
  createGameWithSeating,
  getLegalActions,
  reduce,
  ruleError,
  sanitizeEvents,
  sanitizeFor,
  type C2S,
  type CardDatabase,
  type ClientGameState,
  type DeckList,
  type GameEvent,
  type GameState,
  type Intent,
  type PlayerId,
  type RuleError,
  type RuleErrorCode,
  type S2C,
  type Transport,
} from '@riftbound/engine';
import { checkHello, parseC2S } from '../net/protocol.js';

/** What N3 persists after every accepted intent. Kept minimal on purpose. */
export interface CommitEntry {
  intent: Intent;
  seat: PlayerId;
  clientSeq?: number;
}

/** A bot only ever sees its own sanitized view, never the full state. */
export interface BotLike {
  decide(view: ClientGameState): Intent | null | Promise<Intent | null>;
}

export interface TurnInfo {
  turnNumber: number;
  activePlayer: PlayerId;
  phase: GameState['turn']['phase'];
  actor: PlayerId;
  status: GameState['gameStatus'];
}

export type LocalResult = { ok: true } | RuleError;

export interface HostSessionOptions {
  cards: CardDatabase;
  state: GameState;
  hostSeat: PlayerId;
  /** Seat token of an already-claimed guest seat (restored from persistence). */
  guestSeatToken?: string | null;
  onCommit?: (entry: CommitEntry) => void;
  /** Host UI refresh: the host's own sanitized view and events after every commit. */
  onLocalUpdate?: (view: ClientGameState, events: GameEvent[]) => void;
  onOpponentStatus?: (connected: boolean) => void;
  onGameOver?: (winner: PlayerId | null) => void;
  /** Clock, injectable for tests (rate limiting). */
  now?: () => number;
  /** Max guest intents per `rateWindowMs` (default 30 per 1000 ms). */
  rateLimit?: number;
  rateWindowMs?: number;
}

export interface CreateHostOptions {
  cards: CardDatabase;
  hostDeck: DeckList;
  /** Defaults to `hostDeck` (SOLO mirror match). */
  guestDeck?: DeckList;
  seed: string;
  mode: 'MULTIPLAYER' | 'SOLO';
  onCommit?: HostSessionOptions['onCommit'];
  onLocalUpdate?: HostSessionOptions['onLocalUpdate'];
  onOpponentStatus?: HostSessionOptions['onOpponentStatus'];
  onGameOver?: HostSessionOptions['onGameOver'];
  now?: () => number;
}

export interface BotOptions {
  /** Delay before each bot action (default 400 ms; use 0 in tests). */
  delayMs?: number;
  /** Max consecutive bot actions per macrotask when delayMs is 0 (default 200). */
  maxStepsPerTick?: number;
}

interface Conn {
  transport: Transport<S2C, unknown>;
  offs: Array<() => void>;
  hello: boolean;
  stale: boolean;
  stamps: number[];
}

/** Constant-time-ish string comparison (does not short-circuit on the first mismatch). */
export function tokensEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export function mintSeatToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const otherSeat = (s: PlayerId): PlayerId => (s === 'p0' ? 'p1' : 'p0');

export class HostSession {
  readonly hostSeat: PlayerId;
  readonly guestSeat: PlayerId;

  private state: GameState;
  private readonly cards: CardDatabase;
  private readonly opts: HostSessionOptions;
  private readonly now: () => number;

  private guestToken: string | null;
  private conn: Conn | null = null;
  private lastClientSeq = -1;

  private bot: BotLike | null = null;
  private botOpts: Required<BotOptions> = { delayMs: 400, maxStepsPerTick: 200 };
  private botTimer: ReturnType<typeof setTimeout> | null = null;
  private botRunning = false;
  private version = 0;
  private disposed = false;

  constructor(opts: HostSessionOptions) {
    this.opts = opts;
    this.cards = opts.cards;
    this.state = opts.state;
    this.hostSeat = opts.hostSeat;
    this.guestSeat = otherSeat(opts.hostSeat);
    this.guestToken = opts.guestSeatToken ?? null;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Build a fresh game. In MULTIPLAYER the guest seat is claimed by the first guest to connect. */
  static create(o: CreateHostOptions): HostSession {
    const { state, seatOfDeck } = createGameWithSeating(
      o.cards,
      [o.hostDeck, o.guestDeck ?? o.hostDeck],
      o.seed,
    );
    return new HostSession({
      cards: o.cards,
      state,
      hostSeat: seatOfDeck[0],
      onCommit: o.onCommit,
      onLocalUpdate: o.onLocalUpdate,
      onOpponentStatus: o.onOpponentStatus,
      onGameOver: o.onGameOver,
      now: o.now,
    });
  }

  // ---- state access ----------------------------------------------------------------------

  getView(seat: PlayerId): ClientGameState {
    return sanitizeFor(this.state, seat);
  }

  /** Full authoritative state (contains rng/seed/hidden info): local persistence ONLY, never send. */
  getFullStateForPersistence(): GameState {
    return this.state;
  }

  /** Replace the state (resume from storage). Cancels any in-flight bot decision, then re-drives the bot. */
  restore(state: GameState): void {
    this.state = state;
    this.version++;
    this.syncGuest();
    this.opts.onLocalUpdate?.(this.getView(this.hostSeat), []);
    this.scheduleBot();
  }

  getActor(): PlayerId {
    return actorToAct(this.state);
  }

  getTurnInfo(): TurnInfo {
    const t = this.state.turn;
    return {
      turnNumber: t.number,
      activePlayer: t.activePlayer,
      phase: t.phase,
      actor: actorToAct(this.state),
      status: this.state.gameStatus,
    };
  }

  /** Token of the claimed guest seat (persist it to allow guests to rejoin after a host reload). */
  getGuestSeatToken(): string | null {
    return this.guestToken;
  }

  isGuestConnected(): boolean {
    return this.conn !== null && this.conn.hello && !this.conn.stale;
  }

  // ---- guest connection --------------------------------------------------------------------

  /** Take ownership of a freshly accepted transport; the first message must be HELLO. */
  acceptGuest(transport: Transport<S2C, unknown>): void {
    const conn: Conn = { transport, offs: [], hello: false, stale: false, stamps: [] };
    conn.offs.push(transport.onMessage((raw) => this.onGuestMessage(conn, raw)));
    conn.offs.push(transport.onClose(() => this.onGuestClosed(conn)));
  }

  private rawSend(conn: Conn, msg: S2C): void {
    if (conn.stale) return;
    try {
      conn.transport.send(msg);
    } catch {
      /* transport closed underneath us; the close handler deals with it */
    }
  }

  private reject(conn: Conn, clientSeq: number, code: RuleErrorCode, detail: string): void {
    const err = ruleError(code, detail);
    this.rawSend(conn, { type: 'REJECTED', clientSeq, code: err.code, message: err.message });
  }

  private refuse(conn: Conn, code: RuleErrorCode, detail: string): void {
    this.reject(conn, 0, code, detail);
    this.detach(conn);
    try {
      conn.transport.close();
    } catch {
      /* ignore */
    }
  }

  private detach(conn: Conn): void {
    conn.stale = true;
    for (const off of conn.offs) off();
    conn.offs = [];
  }

  private onGuestMessage(conn: Conn, raw: unknown): void {
    if (conn.stale || this.disposed) return;
    const msg = parseC2S(raw);
    if (msg === null) {
      // Malformed frames are dropped; a connection that never said HELLO validly is closed.
      if (!conn.hello) this.refuse(conn, 'UNKNOWN_INTENT', 'expected HELLO');
      return;
    }
    if (!conn.hello) {
      this.handleHello(conn, msg);
      return;
    }
    switch (msg.type) {
      case 'HELLO':
        return; // duplicate HELLO on an established connection: ignore
      case 'REQUEST_RESYNC':
        this.sendState(conn, []);
        return;
      case 'INTENT':
        this.onGuestIntent(conn, msg);
        return;
    }
  }

  private handleHello(conn: Conn, msg: C2S): void {
    if (msg.type !== 'HELLO') {
      this.refuse(conn, 'UNKNOWN_INTENT', 'expected HELLO first');
      return;
    }
    const check = checkHello(msg);
    if (!check.ok) {
      this.refuse(
        conn,
        'ENGINE_VERSION_MISMATCH',
        `protocol ${msg.protocolVersion}, host speaks ${PROTOCOL_VERSION}`,
      );
      return;
    }
    // (Engine version differences are reported by checkHello but tolerated: same protocol.)
    if (this.bot) {
      this.refuse(conn, 'NOT_FOUND', 'solo game: no seat available');
      return;
    }
    if (this.guestToken === null) {
      if (msg.seatToken !== undefined) {
        // A token for a seat that was never claimed here (e.g. host restarted a different game).
        this.refuse(conn, 'NOT_FOUND', 'unknown seat token');
        return;
      }
      this.guestToken = mintSeatToken();
      this.lastClientSeq = -1;
    } else if (msg.seatToken === undefined || !tokensEqual(msg.seatToken, this.guestToken)) {
      this.refuse(conn, 'NOT_FOUND', 'seat already claimed');
      return;
    }
    // Accepted. Replace any previous connection for this seat.
    const old = this.conn;
    conn.hello = true;
    this.conn = conn;
    if (old && old !== conn) {
      this.detach(old);
      try {
        old.transport.close();
      } catch {
        /* ignore */
      }
    }
    this.rawSend(conn, { type: 'WELCOME', seat: this.guestSeat, seatToken: this.guestToken });
    this.sendState(conn, []);
    this.opts.onOpponentStatus?.(true);
  }

  private onGuestClosed(conn: Conn): void {
    if (conn.stale) return;
    this.detach(conn);
    if (this.conn === conn) {
      this.conn = null;
      if (conn.hello) this.opts.onOpponentStatus?.(false);
    }
  }

  private sendState(conn: Conn, events: GameEvent[]): void {
    this.rawSend(conn, {
      type: 'STATE',
      view: sanitizeFor(this.state, this.guestSeat),
      events: sanitizeEvents(events, this.guestSeat),
    });
    if (this.state.gameStatus !== 'IN_PROGRESS') this.sendGameOver(conn);
  }

  private sendGameOver(conn: Conn): void {
    this.rawSend(conn, {
      type: 'GAME_OVER',
      winner: this.state.winner ?? null,
      replayAvailable: true,
    });
  }

  private syncGuest(): void {
    if (this.conn && this.conn.hello) this.sendState(this.conn, []);
  }

  private onGuestIntent(conn: Conn, msg: Extract<C2S, { type: 'INTENT' }>): void {
    const { intent, clientSeq } = msg;
    // Rate limit (sliding window).
    const t = this.now();
    const windowMs = this.opts.rateWindowMs ?? 1000;
    conn.stamps = conn.stamps.filter((s) => t - s < windowMs);
    if (conn.stamps.length >= (this.opts.rateLimit ?? 30)) {
      this.reject(conn, clientSeq, 'UNKNOWN_INTENT', 'rate limited');
      return;
    }
    conn.stamps.push(t);

    if (clientSeq <= this.lastClientSeq) {
      // Duplicate / replay: do not re-apply, but let the guest catch up.
      this.sendState(conn, []);
      return;
    }
    this.lastClientSeq = clientSeq;

    if (intent.playerId !== this.guestSeat) {
      this.reject(conn, clientSeq, 'NOT_OWNED', 'intent claims a different seat');
      return;
    }
    const res = this.apply(this.guestSeat, intent, clientSeq);
    if (!res.ok)
      this.rawSend(conn, { type: 'REJECTED', clientSeq, code: res.code, message: res.message });
  }

  // ---- intents ---------------------------------------------------------------------------

  /** The host player's own intents. `playerId` is forced to the host seat. */
  localIntent(intent: Intent): LocalResult {
    if (this.disposed) return ruleError('GAME_OVER', 'session closed');
    return this.apply(this.hostSeat, { ...intent, playerId: this.hostSeat } as Intent);
  }

  private apply(seat: PlayerId, intent: Intent, clientSeq?: number): LocalResult {
    const res = reduce(this.state, this.cards, intent);
    if (!res.ok) return { ok: false, code: res.code, message: res.message };
    const wasOver = this.state.gameStatus !== 'IN_PROGRESS';
    this.state = res.state;
    this.version++;
    const entry: CommitEntry = { intent, seat };
    if (clientSeq !== undefined) entry.clientSeq = clientSeq;
    try {
      this.opts.onCommit?.(entry);
    } catch (e) {
      console.error('[host] onCommit threw', e);
    }
    if (this.conn && this.conn.hello) this.sendState(this.conn, res.events);
    try {
      this.opts.onLocalUpdate?.(
        sanitizeFor(this.state, this.hostSeat),
        sanitizeEvents(res.events, this.hostSeat),
      );
    } catch (e) {
      console.error('[host] onLocalUpdate threw', e);
    }
    if (!wasOver && this.state.gameStatus !== 'IN_PROGRESS') {
      this.opts.onGameOver?.(this.state.winner ?? null);
    }
    this.scheduleBot();
    return { ok: true };
  }

  // ---- bot (SOLO) ------------------------------------------------------------------------

  /** Seat the bot in the guest seat. Network guests are refused while a bot is attached. */
  attachBot(bot: BotLike, options: BotOptions = {}): void {
    this.bot = bot;
    this.botOpts = {
      delayMs: options.delayMs ?? 400,
      maxStepsPerTick: options.maxStepsPerTick ?? 200,
    };
    this.scheduleBot();
  }

  detachBot(): void {
    this.bot = null;
    this.clearBotTimer();
    this.version++;
  }

  private clearBotTimer(): void {
    if (this.botTimer !== null) clearTimeout(this.botTimer);
    this.botTimer = null;
  }

  private botToAct(): boolean {
    return (
      this.bot !== null &&
      !this.disposed &&
      this.state.gameStatus === 'IN_PROGRESS' &&
      actorToAct(this.state) === this.guestSeat
    );
  }

  private scheduleBot(): void {
    if (this.botTimer !== null || this.botRunning || !this.botToAct()) return;
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      void this.runBot();
    }, this.botOpts.delayMs);
  }

  private async runBot(): Promise<void> {
    if (this.botRunning) return;
    this.botRunning = true;
    let steps = 0;
    try {
      while (this.botToAct()) {
        const bot = this.bot as BotLike;
        const v = this.version;
        let intent: Intent | null = null;
        try {
          intent = await bot.decide(this.getView(this.guestSeat));
        } catch (e) {
          console.error('[host] bot threw', e);
        }
        if (v !== this.version || !this.botToAct()) continue; // state moved on while thinking
        let ok = false;
        if (intent) ok = this.applyBotIntent({ ...intent, playerId: this.guestSeat } as Intent);
        if (!ok && !this.applyBotFallback()) break; // nothing legal: cannot progress
        steps++;
        if (this.botOpts.delayMs > 0 || steps >= this.botOpts.maxStepsPerTick) break;
      }
    } finally {
      this.botRunning = false;
    }
    this.scheduleBot(); // continue on the next macrotask (delay applies between actions)
  }

  private applyBotIntent(intent: Intent): boolean {
    return this.apply(this.guestSeat, intent).ok;
  }

  /** Never stall: prefer pass / end turn / keep-hand, else the first legal action. */
  private applyBotFallback(): boolean {
    const legal = getLegalActions(this.state, this.cards, this.guestSeat);
    const pick =
      legal.find((i) => i.type === 'PASS_PRIORITY' || i.type === 'END_TURN') ??
      legal.find((i) => i.type === 'MULLIGAN' && i.cardIds.length === 0) ??
      legal[0];
    return pick ? this.apply(this.guestSeat, pick).ok : false;
  }

  /** Stop timers, detach the bot and close the guest connection. */
  dispose(): void {
    this.disposed = true;
    this.clearBotTimer();
    this.bot = null;
    const c = this.conn;
    this.conn = null;
    if (c) {
      this.detach(c);
      try {
        c.transport.close();
      } catch {
        /* ignore */
      }
    }
  }
}
