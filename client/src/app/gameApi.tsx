import { createContext, useContext } from 'react';
import type {
  CardDatabase,
  ClientGameState,
  GameEvent,
  Intent,
  PlayerId,
  RuleError,
} from '@riftbound/engine';

export type ConnectionStatus = 'connecting' | 'connected' | 'host-away' | 'closed';

/**
 * Everything a game screen needs, independent of whether the game is hosted locally,
 * joined as a guest, solo vs AI, or a tutorial sandbox. UI components read this through
 * `useGame()` and never talk to sessions or transports directly.
 */
export interface GameApi {
  /** Card definitions by cardId. */
  cards: CardDatabase;
  /** The viewer's seat. */
  seat: PlayerId;
  /** Sanitised view of the game from `seat`'s perspective. */
  view: ClientGameState;
  /** Intents the engine would currently accept from `seat` (host-computed, never a guess). */
  legal: Intent[];
  /** Events from the most recent updates (newest last), already filtered for `seat`. */
  recentEvents: GameEvent[];
  connection: ConnectionStatus;
  opponentConnected: boolean;
  /** Set when the game has ended. */
  gameOver: { winner: PlayerId | null } | null;
  /** Send an intent for `seat`. Resolves ok, or with the engine's rule error. */
  send(intent: Intent): Promise<{ ok: true } | RuleError>;
}

const GameContext = createContext<GameApi | null>(null);

export const GameProvider = GameContext.Provider;

export function useGame(): GameApi {
  const api = useContext(GameContext);
  if (!api) throw new Error('useGame() must be used inside a <GameProvider>');
  return api;
}
