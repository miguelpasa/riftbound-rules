/**
 * GuestSession: the guest's side of the host link. Wraps a StatusTransport, performs the HELLO /
 * WELCOME handshake (re-sent on every reconnect with the saved seat token), keeps the latest
 * sanitized view and exposes typed listeners.
 *
 * `clientSeq` is monotonic across reconnects (and page reloads) because it is stored alongside the
 * seat token. Handshake-level host refusals arrive as REJECTED with `clientSeq === 0`.
 */
import {
  ENGINE_VERSION,
  PROTOCOL_VERSION,
  type C2S,
  type ClientGameState,
  type DeckList,
  type GameEvent,
  type Intent,
  type PlayerId,
  type RuleErrorCode,
  type S2C,
} from '@riftbound/engine';
import { parseS2C } from './protocol.js';
import type { StatusTransport } from './transport.js';

/** Minimal storage (sessionStorage / localStorage / an in-memory object in tests). */
export interface KeyValueStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/**
 * - connecting: transport not open yet, or open but the host has not welcomed us.
 * - connected: welcomed; intents can be sent.
 * - host-away: the link dropped and the transport is retrying ("Host disconnected, waiting...").
 * - closed: the link is gone for good, or the host refused us.
 */
export type GuestStatus = 'connecting' | 'connected' | 'host-away' | 'closed';

export interface RejectionInfo {
  clientSeq: number;
  code: RuleErrorCode;
  message: string;
}

export interface GuestSessionOptions {
  transport: StatusTransport<C2S, unknown>;
  storage: KeyValueStorage;
  /** Storage key prefix (default 'rb-guest'); use one per room code. */
  storageKey?: string;
  engineVersion?: string;
  protocolVersion?: number;
  /** The guest's own deck, sent in the HELLO of a first join (ignored once a seat token exists). */
  deck?: DeckList;
}

type Cb<A extends unknown[]> = (...args: A) => void;

class Bus<A extends unknown[]> {
  private readonly set = new Set<Cb<A>>();
  add(cb: Cb<A>): () => void {
    this.set.add(cb);
    return () => {
      this.set.delete(cb);
    };
  }
  emit(...args: A): void {
    for (const cb of [...this.set]) {
      try {
        cb(...args);
      } catch (e) {
        console.error('[guest] listener threw', e);
      }
    }
  }
}

export class GuestSession {
  private readonly t: StatusTransport<C2S, unknown>;
  private readonly storage: KeyValueStorage;
  private readonly prefix: string;
  private readonly engineVersion: string;
  private readonly protocolVersion: number;
  private readonly deck: DeckList | undefined;

  private _seat: PlayerId | null = null;
  private _view: ClientGameState | null = null;
  private _legal: Intent[] = [];
  private _status: GuestStatus;
  private _welcomed = false;
  private _opponentConnected = true;
  private _gameOver: { winner: PlayerId | null; replayAvailable: boolean } | null = null;
  private _refused: RejectionInfo | null = null;
  private seatToken: string | null;
  private nextSeq: number;
  private readonly offs: Array<() => void> = [];

  private readonly stateBus = new Bus<[ClientGameState, GameEvent[], Intent[]]>();
  private readonly rejectedBus = new Bus<[RejectionInfo]>();
  private readonly gameOverBus = new Bus<[PlayerId | null, boolean]>();
  private readonly opponentBus = new Bus<[boolean]>();
  private readonly statusBus = new Bus<[GuestStatus]>();

  constructor(o: GuestSessionOptions) {
    this.t = o.transport;
    this.storage = o.storage;
    this.prefix = o.storageKey ?? 'rb-guest';
    this.engineVersion = o.engineVersion ?? ENGINE_VERSION;
    this.protocolVersion = o.protocolVersion ?? PROTOCOL_VERSION;
    this.deck = o.deck;

    this.seatToken = this.read('token');
    const savedSeat = this.read('seat');
    if (savedSeat === 'p0' || savedSeat === 'p1') this._seat = savedSeat;
    const savedSeq = Number(this.read('seq'));
    this.nextSeq = Number.isSafeInteger(savedSeq) && savedSeq >= 0 ? savedSeq + 1 : 1;
    this._status = this.deriveStatus();

    this.offs.push(this.t.onMessage((raw) => this.onFrame(raw)));
    this.offs.push(
      this.t.onStatus((s) => {
        if (s === 'open') {
          this._welcomed = false;
          this.sendHello();
        } else {
          this._welcomed = false;
        }
        this.refreshStatus();
      }),
    );
    this.offs.push(this.t.onClose(() => this.refreshStatus()));
    if (this.t.status === 'open') this.sendHello();
  }

  // ---- accessors -------------------------------------------------------------------------

  get status(): GuestStatus {
    return this._status;
  }
  get seat(): PlayerId | null {
    return this._seat;
  }
  get view(): ClientGameState | null {
    return this._view;
  }
  /** Host-computed legal intents for this seat (a hint for the UI; the host still validates). */
  get legal(): Intent[] {
    return this._legal;
  }
  get opponentConnected(): boolean {
    return this._opponentConnected;
  }
  get gameOver(): { winner: PlayerId | null; replayAvailable: boolean } | null {
    return this._gameOver;
  }
  /** Set when the host refused the handshake (bad token, protocol mismatch, seat taken...). */
  get refusal(): RejectionInfo | null {
    return this._refused;
  }

  onState(cb: (view: ClientGameState, events: GameEvent[], legal: Intent[]) => void): () => void {
    return this.stateBus.add(cb);
  }
  onRejected(cb: (r: RejectionInfo) => void): () => void {
    return this.rejectedBus.add(cb);
  }
  onGameOver(cb: (winner: PlayerId | null, replayAvailable: boolean) => void): () => void {
    return this.gameOverBus.add(cb);
  }
  onOpponentStatus(cb: (connected: boolean) => void): () => void {
    return this.opponentBus.add(cb);
  }
  onStatus(cb: (status: GuestStatus) => void): () => void {
    return this.statusBus.add(cb);
  }

  // ---- actions ---------------------------------------------------------------------------

  /** Send an intent. Returns its clientSeq, or -1 when the link is not usable (nothing was sent). */
  sendIntent(intent: Intent): number {
    if (this._status !== 'connected') return -1;
    const seq = this.nextSeq;
    try {
      this.t.send({ type: 'INTENT', intent, clientSeq: seq });
    } catch {
      return -1; // e.g. TransportNotOpenError raced with a drop
    }
    this.nextSeq++;
    this.write('seq', String(seq));
    return seq;
  }

  requestResync(): boolean {
    if (this._status !== 'connected') return false;
    try {
      this.t.send({ type: 'REQUEST_RESYNC' });
      return true;
    } catch {
      return false;
    }
  }

  /** Forget the saved seat (e.g. "leave game"). */
  forgetSeat(): void {
    this.seatToken = null;
    this._seat = null;
    for (const k of ['token', 'seat', 'seq']) this.write(k, '');
  }

  close(): void {
    for (const off of this.offs.splice(0)) off();
    try {
      this.t.close();
    } catch {
      /* ignore */
    }
    this.setStatus('closed');
  }

  // ---- internals -------------------------------------------------------------------------

  private read(k: string): string | null {
    try {
      const v = this.storage.get(`${this.prefix}:${k}`);
      return v === '' ? null : v;
    } catch {
      return null;
    }
  }
  private write(k: string, v: string): void {
    try {
      this.storage.set(`${this.prefix}:${k}`, v);
    } catch {
      /* storage unavailable: degrade to in-memory */
    }
  }

  private sendHello(): void {
    const hello: C2S = {
      type: 'HELLO',
      protocolVersion: this.protocolVersion,
      engineVersion: this.engineVersion,
    };
    if (this.seatToken) hello.seatToken = this.seatToken;
    else if (this.deck) hello.deck = this.deck;
    try {
      this.t.send(hello);
    } catch {
      /* transport dropped before it could send; the next 'open' retries */
    }
  }

  private deriveStatus(): GuestStatus {
    if (this._refused) return 'closed';
    switch (this.t.status) {
      case 'open':
        return this._welcomed ? 'connected' : 'connecting';
      case 'reconnecting':
        return 'host-away';
      case 'closed':
        return 'closed';
      default:
        return 'connecting';
    }
  }
  private refreshStatus(): void {
    this.setStatus(this.deriveStatus());
  }
  private setStatus(s: GuestStatus): void {
    if (s === this._status) return;
    this._status = s;
    this.statusBus.emit(s);
  }

  private onFrame(raw: unknown): void {
    const msg: S2C | null = parseS2C(raw);
    if (msg === null) return; // invalid frames are dropped
    switch (msg.type) {
      case 'WELCOME':
        this._seat = msg.seat;
        this.seatToken = msg.seatToken;
        this.write('seat', msg.seat);
        this.write('token', msg.seatToken);
        this._welcomed = true;
        this._refused = null;
        this._opponentConnected = true;
        this.refreshStatus();
        return;
      case 'STATE':
        this._view = msg.view;
        this._legal = msg.legalHint ?? [];
        this.stateBus.emit(msg.view, msg.events, this._legal);
        return;
      case 'REJECTED': {
        const info: RejectionInfo = {
          clientSeq: msg.clientSeq,
          code: msg.code,
          message: msg.message,
        };
        if (msg.clientSeq === 0 && !this._welcomed) {
          // Handshake refusal: the host closes the link right after this.
          this._refused = info;
          this.refreshStatus();
        }
        this.rejectedBus.emit(info);
        return;
      }
      case 'OPPONENT_STATUS':
        this._opponentConnected = msg.connected;
        this.opponentBus.emit(msg.connected);
        return;
      case 'GAME_OVER':
        this._gameOver = { winner: msg.winner, replayAvailable: msg.replayAvailable };
        this.gameOverBus.emit(msg.winner, msg.replayAvailable);
        return;
    }
  }
}
