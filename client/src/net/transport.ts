import type { Transport } from '@riftbound/engine';

export type { Transport };

export type TransportStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** A Transport that also reports connection lifecycle (peer + loopback transports implement this). */
export interface StatusTransport<TSend = unknown, TRecv = unknown> extends Transport<TSend, TRecv> {
  readonly status: TransportStatus;
  /** Register a status handler (not called with the current status). Returns an unsubscribe fn. */
  onStatus(cb: (status: TransportStatus) => void): () => void;
}

/** Status of any transport; transports without status tracking are assumed 'open'. */
export function transportStatus(t: object): TransportStatus {
  return 'status' in t ? (t as { status: TransportStatus }).status : 'open';
}

/** Tiny typed listener set used by the transports in this folder. */
export class Listeners<A extends unknown[]> {
  private readonly set = new Set<(...args: A) => void>();
  add(cb: (...args: A) => void): () => void {
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
        // A throwing listener must not break the transport or other listeners.
        console.error('[net] listener threw', e);
      }
    }
  }
  clear(): void {
    this.set.clear();
  }
}
