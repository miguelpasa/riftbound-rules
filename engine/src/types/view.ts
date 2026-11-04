import type { BattlefieldState, CardInstance, GameState, PlayerId, PlayerState } from './state.js';

/** Placeholder for a card the viewer may not see. */
export interface HiddenCard {
  hidden: true;
  owner: PlayerId;
}

export type VisibleOrHidden = CardInstance | HiddenCard;

/** Per-player zone view: hidden zones carry counts; their contents may be HiddenCard. */
export interface ClientPlayerState extends Omit<PlayerState, 'hand' | 'mainDeck' | 'runeDeck'> {
  /** Viewer: real ids. Opponent: ids of HiddenCard placeholders (opaque, in `hiddenObjects`). */
  hand: string[];
  mainDeck: string[];
  runeDeck: string[];
  handCount: number;
  mainDeckCount: number;
  runeDeckCount: number;
}

/** GameState as seen by one player: no rng/seed, hidden info replaced. */
export interface ClientGameState extends Omit<
  GameState,
  'players' | 'objects' | 'rng' | 'seed' | 'battlefields' | 'nextObjectId' | 'nextEventSeq'
> {
  viewer: PlayerId;
  players: [ClientPlayerState, ClientPlayerState];
  /** Opponent hand/mainDeck/runeDeck/facedown objects are HiddenCard. */
  objects: Record<string, VisibleOrHidden>;
  battlefields: BattlefieldState[];
}

/** Implemented elsewhere: strips information `viewer` must not see. */
export type SanitizeFn = (state: GameState, viewer: PlayerId) => ClientGameState;

export function isHiddenCard(o: VisibleOrHidden): o is HiddenCard {
  return (o as HiddenCard).hidden === true && !('id' in o);
}
