import { Listeners, type StatusTransport, type TransportStatus } from './transport.js';

export interface LoopbackOptions {
  /** Pass every message through JSON stringify/parse (default true) to catch non-serialisable payloads. */
  jsonRoundTrip?: boolean;
}

export interface LoopbackPair<A = unknown, B = unknown> {
  /** `a` sends A and receives B; `b` sends B and receives A. */
  a: StatusTransport<A, B>;
  b: StatusTransport<B, A>;
  /** Unexpected disconnect: in-flight messages are discarded, both sides get onClose. */
  drop(): void;
  readonly closed: boolean;
}

class PairState {
  closed = false;
  epoch = 0;
  finishers: Array<() => void> = [];
  /**
   * Graceful close: messages already queued are still delivered before onClose fires.
   * Abrupt (drop): in-flight messages are discarded.
   */
  shutdown(abrupt: boolean): void {
    if (this.closed) return;
    this.closed = true;
    if (abrupt) this.epoch++;
    queueMicrotask(() => {
      for (const f of this.finishers) f();
    });
  }
}

class End<S, R> implements StatusTransport<S, R> {
  status: TransportStatus = 'open';
  peer!: End<R, S>;
  private readonly msgs = new Listeners<[R]>();
  private readonly closes = new Listeners<[]>();
  private readonly statuses = new Listeners<[TransportStatus]>();
  constructor(
    private readonly pair: PairState,
    private readonly json: boolean,
  ) {
    pair.finishers.push(() => this.finish());
  }
  send(msg: S): void {
    if (this.pair.closed) return; // like a dead socket: silently ignored
    const wire = this.json ? (JSON.parse(JSON.stringify(msg)) as S) : msg;
    const epoch = this.pair.epoch;
    queueMicrotask(() => {
      if (this.pair.epoch !== epoch) return; // dropped in flight
      this.peer.msgs.emit(wire);
    });
  }
  onMessage(cb: (msg: R) => void): () => void {
    return this.msgs.add(cb);
  }
  onClose(cb: () => void): () => void {
    return this.closes.add(cb);
  }
  onStatus(cb: (s: TransportStatus) => void): () => void {
    return this.statuses.add(cb);
  }
  close(): void {
    this.pair.shutdown(false);
  }
  private finish(): void {
    this.status = 'closed';
    this.statuses.emit('closed');
    this.closes.emit();
  }
}

export function createLoopbackPair<A = unknown, B = unknown>(
  opts: LoopbackOptions = {},
): LoopbackPair<A, B> {
  const json = opts.jsonRoundTrip ?? true;
  const state = new PairState();
  const a = new End<A, B>(state, json);
  const b = new End<B, A>(state, json);
  a.peer = b;
  b.peer = a;
  return {
    a,
    b,
    drop: () => state.shutdown(true),
    get closed() {
      return state.closed;
    },
  };
}

export interface LoopbackHub<S2CLike = unknown, C2SLike = unknown> {
  /** Host registers for incoming guests. Handlers must attach listeners synchronously. */
  hostOnConnection(cb: (t: StatusTransport<S2CLike, C2SLike>) => void): () => void;
  /** Guest side: opens a new connection to the host. If no host is listening it closes asynchronously. */
  connectGuest(): StatusTransport<C2SLike, S2CLike>;
  /** Simulate the most recent guest connection dropping unexpectedly. */
  dropCurrent(): void;
  readonly connectionCount: number;
}

/** A host that can accept multiple sequential guest connections (guest rejoin tests). */
export function createLoopbackHub<S2CLike = unknown, C2SLike = unknown>(
  opts: LoopbackOptions = {},
): LoopbackHub<S2CLike, C2SLike> {
  const listeners = new Listeners<[StatusTransport<S2CLike, C2SLike>]>();
  const pairs: LoopbackPair<C2SLike, S2CLike>[] = [];
  let hosts = 0;
  return {
    hostOnConnection(cb) {
      hosts++;
      const off = listeners.add(cb);
      return () => {
        hosts--;
        off();
      };
    },
    connectGuest() {
      // a = guest end (sends C2S, receives S2C); b = host end.
      const pair = createLoopbackPair<C2SLike, S2CLike>(opts);
      pairs.push(pair);
      if (hosts > 0) listeners.emit(pair.b);
      else pair.a.close();
      return pair.a;
    },
    dropCurrent() {
      pairs[pairs.length - 1]?.drop();
    },
    get connectionCount() {
      return pairs.length;
    },
  };
}
