import type { RuleErrorCode } from './errors.js';
import type { GameEvent } from './event.js';
import type { Intent } from './intent.js';
import type { PlayerId } from './state.js';
import type { ClientGameState } from './view.js';

export const PROTOCOL_VERSION = 1;

/** Guest -> host. */
export type C2S =
  | { type: 'HELLO'; protocolVersion: number; engineVersion: string; seatToken?: string }
  | { type: 'INTENT'; intent: Intent; clientSeq: number }
  | { type: 'REQUEST_RESYNC' };

/** Host -> guest. */
export type S2C =
  | { type: 'WELCOME'; seat: PlayerId; seatToken: string }
  | {
      type: 'STATE';
      view: ClientGameState;
      events: GameEvent[];
      /** Intents the recipient may legally submit now (a hint only; the host re-validates). */
      legalHint?: Intent[];
    }
  | { type: 'REJECTED'; clientSeq: number; code: RuleErrorCode; message: string }
  | { type: 'OPPONENT_STATUS'; connected: boolean }
  | { type: 'GAME_OVER'; winner: PlayerId | null; replayAvailable: boolean };
