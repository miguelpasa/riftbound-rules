/**
 * In-memory test double for the slice of PeerJS used by peerTransport (no network).
 * Events are delivered via queueMicrotask, so tests using fake timers should
 * `await vi.advanceTimersByTimeAsync(...)` to flush.
 */
import type { DataConnectionLike, PeerErrorLike, PeerFactory, PeerLike } from './peerTransport.js';

type AnyCb = (...args: never[]) => void;

class Emitter {
  private readonly handlers = new Map<string, AnyCb[]>();
  protected addHandler(event: string, cb: AnyCb): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }
  emitEvent(event: string, ...args: unknown[]): void {
    for (const cb of [...(this.handlers.get(event) ?? [])])
      (cb as (...a: unknown[]) => void)(...args);
  }
}

interface Link {
  silent: boolean;
}

export class FakeDataConnection extends Emitter implements DataConnectionLike {
  open = false;
  other: FakeDataConnection | null = null;
  link: Link = { silent: false };
  /** Data messages sent over this connection end (for assertions). */
  readonly sent: unknown[] = [];
  constructor(readonly peer: string) {
    super();
  }
  on(event: 'open' | 'close', cb: () => void): void;
  on(event: 'data', cb: (data: unknown) => void): void;
  on(event: 'error', cb: (err: PeerErrorLike) => void): void;
  on(event: string, cb: AnyCb): void {
    this.addHandler(event, cb);
  }
  send(data: unknown): void {
    if (!this.open) throw new Error('FakeDataConnection: send on closed connection');
    this.sent.push(data);
    const other = this.other;
    if (!other || this.link.silent) return;
    queueMicrotask(() => {
      if (other.open) other.emitEvent('data', data);
    });
  }
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.emitEvent('close');
    const other = this.other;
    queueMicrotask(() => {
      if (other?.open) {
        other.open = false;
        other.emitEvent('close');
      }
    });
  }
  /** Stop delivering data in both directions without closing (simulates a dead network path). */
  blackhole(): void {
    this.link.silent = true;
  }
  /** Remote vanished without a close frame: only this end is told, after the channel timeout. */
  remoteClosed(): void {
    if (!this.open) return;
    this.open = false;
    this.emitEvent('close');
  }
}

export class FakePeer extends Emitter implements PeerLike {
  destroyed = false;
  disconnected = false;
  id: string;
  readonly conns = new Set<FakeDataConnection>();
  constructor(
    readonly broker: FakeBroker,
    requestedId?: string,
  ) {
    super();
    this.id = requestedId ?? broker.randomId();
    queueMicrotask(() => {
      if (this.destroyed) return;
      const err = broker.register(this);
      if (err) this.emitEvent('error', { type: err });
      else this.emitEvent('open', this.id);
    });
  }
  on(event: 'open', cb: (id: string) => void): void;
  on(event: 'connection', cb: (conn: DataConnectionLike) => void): void;
  on(event: 'error', cb: (err: PeerErrorLike) => void): void;
  on(event: 'disconnected' | 'close', cb: () => void): void;
  on(event: string, cb: AnyCb): void {
    this.addHandler(event, cb);
  }
  connect(remoteId: string): FakeDataConnection {
    const local = new FakeDataConnection(remoteId);
    this.conns.add(local);
    queueMicrotask(() => {
      if (this.destroyed) return;
      const remote = this.broker.online ? this.broker.peers.get(remoteId) : undefined;
      if (!this.broker.online) {
        this.emitEvent('error', { type: 'network' });
        return;
      }
      if (!remote || remote.destroyed) {
        this.emitEvent('error', { type: 'peer-unavailable' });
        return;
      }
      const incoming = new FakeDataConnection(this.id);
      incoming.link = local.link;
      local.other = incoming;
      incoming.other = local;
      remote.conns.add(incoming);
      remote.emitEvent('connection', incoming);
      queueMicrotask(() => {
        if (local.other !== incoming) return;
        local.open = true;
        incoming.open = true;
        local.emitEvent('open');
        incoming.emitEvent('open');
      });
    });
    return local;
  }
  reconnect(): void {
    queueMicrotask(() => {
      if (this.destroyed || !this.disconnected) return;
      const err = this.broker.online ? this.broker.register(this) : 'network';
      if (err) this.emitEvent('error', { type: err });
      else {
        this.disconnected = false;
        this.emitEvent('open', this.id);
      }
    });
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.broker.unregister(this);
    for (const c of this.conns) c.close();
    this.emitEvent('close');
  }
  /** Used by the broker: drop signalling but keep data channels. */
  _brokerLost(): void {
    this.disconnected = true;
    this.emitEvent('disconnected');
  }
}

export class FakeBroker {
  readonly peers = new Map<string, FakePeer>();
  online = true;
  private readonly held = new Map<string, ReturnType<typeof setTimeout>>();
  private n = 0;
  /** Every peer ever created, for assertions. */
  readonly created: FakePeer[] = [];

  randomId(): string {
    return `guest-${++this.n}`;
  }
  /** Returns an error type, or null on success. */
  register(peer: FakePeer): string | null {
    if (!this.online) return 'network';
    const existing = this.peers.get(peer.id);
    if ((existing && existing !== peer) || this.held.has(peer.id)) return 'unavailable-id';
    this.peers.set(peer.id, peer);
    return null;
  }
  unregister(peer: FakePeer): void {
    if (this.peers.get(peer.id) === peer) this.peers.delete(peer.id);
  }
  readonly factory: PeerFactory = (id) => {
    const p = new FakePeer(this, id);
    this.created.push(p);
    return p;
  };
  /**
   * Simulate the peer's browser dying: remote ends see their channels close, and the broker keeps
   * the id reserved for holdIdMs (so a restarted host gets 'unavailable-id' for a while).
   */
  crash(id: string, holdIdMs = 0): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    peer.destroyed = true;
    for (const c of peer.conns) {
      c.open = false;
      c.other?.remoteClosed();
    }
    if (holdIdMs > 0) {
      this.held.set(
        id,
        setTimeout(() => this.held.delete(id), holdIdMs),
      );
    }
  }
  /** Signalling server connection lost for all (or one) peers; data channels survive. */
  setOnline(online: boolean): void {
    this.online = online;
    if (!online) {
      for (const p of [...this.peers.values()]) {
        this.peers.delete(p.id);
        p._brokerLost();
      }
    }
  }
}
