import type { Domain } from './card.js';
import type { FlowState, MulliganState, TurnState } from './chain.js';

/** Bump on any breaking change to GameState shape or rules behavior. */
export const ENGINE_VERSION = '0.1.0';

export type PlayerId = 'p0' | 'p1';
export type GameMode = 'DUEL';

/** Turn phases. Scoring is a step of BEGINNING (see PhaseStep). */
export type Phase = 'MULLIGAN' | 'AWAKEN' | 'BEGINNING' | 'CHANNEL' | 'DRAW' | 'MAIN' | 'ENDING';

/** Step within a phase; 'SCORING' only occurs in BEGINNING. */
export type PhaseStep = 'NONE' | 'SCORING';

export type GameStatus = 'IN_PROGRESS' | 'FINISHED' | 'ABORTED';

/** Where a CardInstance currently is. `player` is the zone owner. */
export type ZoneRef =
  | { kind: 'hand'; player: PlayerId }
  | { kind: 'mainDeck'; player: PlayerId }
  | { kind: 'runeDeck'; player: PlayerId }
  | { kind: 'trash'; player: PlayerId }
  | { kind: 'banishment'; player: PlayerId }
  /** Base also holds channeled runes (type RUNE) per Rule 107.1.c. */
  | { kind: 'base'; player: PlayerId }
  | { kind: 'legend'; player: PlayerId }
  | { kind: 'champion'; player: PlayerId }
  | { kind: 'chain'; player: PlayerId }
  | { kind: 'battlefield'; player: PlayerId; battlefieldId: string }
  /** Hidden card placed facedown at a battlefield (Hidden keyword). */
  | { kind: 'facedown'; player: PlayerId; battlefieldId: string };

export type ZoneKind = ZoneRef['kind'];

/** A physical card/token/object in the game. */
export interface CardInstance {
  id: string;
  cardId: string;
  owner: PlayerId;
  controller: PlayerId;
  zone: ZoneRef;
  /** Ready (true) or exhausted (false). */
  ready: boolean;
  /** Damage currently marked. */
  damage: number;
  /** Net Might modifier from buffs/effects. */
  mightBonus: number;
  /** Equipment -> id of the unit it is attached to. */
  attachedTo?: string;
  facedown?: boolean;
  hidden?: boolean;
  /** Turn number it entered play. */
  enteredTurn?: number;
}

export interface BattlefieldState {
  id: string;
  cardId: string;
  owner: PlayerId;
  /** Current controller, null if uncontrolled. */
  controller: PlayerId | null;
  /** Player currently contesting it, null if none. */
  contestedBy: PlayerId | null;
  /** Object id of the facedown card here, if any. Units here are objects with a 'battlefield' zone ref. */
  facedownSlotId: string | null;
  /** Players who already scored this battlefield this turn (Rule 473.1). */
  scoredThisTurnBy: PlayerId[];
}

export interface RunePool {
  energy: number;
  power: Partial<Record<Domain, number>>;
}

export interface PlayerState {
  id: PlayerId;
  /** Object ids. */
  hand: string[];
  /** Object ids, top = index 0. */
  mainDeck: string[];
  /** Object ids, top = index 0. */
  runeDeck: string[];
  trash: string[];
  banishment: string[];
  /** Units, gear and channeled runes in the base. */
  base: string[];
  /** Legend object id. */
  legend: string | null;
  /** Champion zone object ids. */
  championZone: string[];
  runePool: RunePool;
  points: number;
}

export interface SeedInfo {
  /** Seed the PRNG was initialised from. */
  seed: string;
}

/** sfc32 PRNG state (plain data). */
export interface RngState {
  s: [number, number, number, number];
}

export interface GameState {
  engineVersion: string;
  mode: GameMode;
  victoryScore: number;
  /** players[0] = p0 = first player. */
  players: [PlayerState, PlayerState];
  /** Every object by id; zones hold id arrays. */
  objects: Record<string, CardInstance>;
  battlefields: BattlefieldState[];
  seed: SeedInfo;
  rng: RngState;
  turn: {
    number: number;
    activePlayer: PlayerId;
    phase: Phase;
    step: PhaseStep;
  };
  /** Neutral/Showdown x Open/Closed (Rules 307-310). */
  turnState: TurnState;
  /** Priority, focus, chain, showdown/combat sub-state, staging. */
  flow: FlowState;
  /** Non-null only during the MULLIGAN phase. */
  mulligan: MulliganState | null;
  gameStatus: GameStatus;
  winner?: PlayerId;
  /** Counters for deterministic id / event-seq generation. */
  nextObjectId: number;
  nextEventSeq: number;
}
