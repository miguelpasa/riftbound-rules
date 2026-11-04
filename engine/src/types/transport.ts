/** Minimal bidirectional message channel (WebRTC data channel, WebSocket, in-memory...). */
export interface Transport<TSend = unknown, TRecv = unknown> {
  send(msg: TSend): void;
  /** Register a message handler. Returns an unsubscribe function. */
  onMessage(cb: (msg: TRecv) => void): () => void;
  /** Register a close handler. Returns an unsubscribe function. */
  onClose(cb: () => void): () => void;
  close(): void;
}
