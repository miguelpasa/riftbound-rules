import type { CardEffect, Domain, KeywordInstance, OptionalCost } from './card.js';
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
  /** Part of mightBonus that expires at the end of the turn ("this turn" effects). */
  tempMight?: number;
  /** X3: how often this object has changed between the Board and another zone while targeted (targetGens.ts). */
  gen?: number;
  /** X7: "the next time it would die this turn, you may pay ..." (Unlicensed Armory); `cardId` is the source card. */
  deathOffer?: { cost: OptionalCost; cardId: string };
  /** X7: its controller declined an optional death replacement; it dies this turn. */
  deathDeclined?: boolean;
  /** X7: the turn in which this source used its "once each turn" death replacement. */
  deathUsedTurn?: number;
  /** X7: damage replacements on this unit until the end of the turn. */
  dmgMod?: { preventNext?: boolean; prevent?: number; double?: boolean };
  /** X7: the next time this unit would die this turn it is replaced (recalled healed and exhausted, or banished). */
  deathReplace?: 'RECALL' | 'BANISH';
  /** X2: base Might assigned by an effect ("base Might becomes N this turn"); expires in the Ending step. */
  baseMightSet?: number;
  /** Hostile Takeover: the controller to give this unit back to (recalled to their Base) at the end of the turn. */
  controlRevert?: PlayerId;
  /** What a "this combat" effect gave this object; removed when the combat ends. */
  combatGrant?: { keywords: KeywordInstance[]; might: number };
  /** Keywords granted until the end of the turn (R43); see tempKeywords.ts. */
  tempKeywords?: KeywordInstance[];
  /** Stunned this turn: deals no combat damage. Expires in the Ending step. */
  stunned?: boolean;
  /** R52: Empowered (the Empower keyword). Lost when the permanent leaves the board. */
  empowered?: boolean;
  /** R54: carries a Buff (+1 Might until it leaves the board; at most one). */
  buffed?: boolean;
  /** R57: cannot be moved this turn (expires in the Ending step). */
  cantMove?: boolean;
  /** Equipment -> id of the unit it is attached to. */
  attachedTo?: string;
  facedown?: boolean;
  hidden?: boolean;
  /** Turn number it entered play. */
  enteredTurn?: number;
  /** X-modes: modes of this object's "choose one that hasn't been chosen this turn" triggers already chosen. */
  modesUsed?: { turn: number; used: Record<number, number[]> };
  /** Moves to a battlefield this turn (stored only for cards that count them: Yasuo, Kayn). */
  moves?: { turn: number; n: number };
  /**
   * R98: "Give it [Temporary]": the `enteredTurn` of this stay on the board. It counts only while `enteredTurn`
   * still matches, so a card that left and came back is no longer Temporary.
   */
  temporaryOf?: number;
  /** The optional additional cost was paid when this card was played ("if you paid the additional cost"). */
  paidExtra?: boolean;
  /** Show Off: the hand card revealed as this card was played. */
  showedOff?: string;
  /** How a spell was played when not from the hand ("if you played this from your hand"); absent = from the hand. */
  playedHow?: 'FACEDOWN' | 'ELSEWHERE';
  /** R100: set while a facedown Hidden card is being played, so its CARD_PLAYED says "from face down". */
  faceDownPlay?: boolean;
  /** R71: turn number of the last time each "once each turn" trigger (by index) went on the Chain. */
  onceTurn?: Record<number, number>;
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
  /** Universal Power [A]: pays a Power cost of any Domain (135.2.e.5.b, 163.2.b). */
  universal?: number;
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
  /** R53: XP (Hunt, Level); absent until first gained (= 0). Public. */
  xp?: number;
  /**
   * R56: units of this player that died during turn `turn` ("a unit died this turn"). Only recorded when a
   * card in the database asks (see conditions.ts `recordDeath`), so games without such cards are unchanged.
   */
  diedThisTurn?: { turn: number; count: number; gear?: number };
  /** What this player did during turn `turn` (discarded a card, gained XP); only recorded when a card asks. */
  turnFlags?: {
    turn: number;
    discarded?: true;
    xpGained?: true;
    /** Most Energy paid for one spell, and the total Power paid, this turn. */
    spellEnergy?: number;
    power?: number;
    /** Battlefields this player conquered this turn (a cost reduction counts them). */
    conquered?: number;
  };
  /**
   * Cards this player played (PLAY_CARD, Hidden plays included) during turn `turn` (Legion, 812).
   * A record from an earlier turn counts as nothing, so the counter resets at the start of each turn
   * without a reset step. Object ids of public plays only (CARD_PLAYED is public too).
   */
  playedThisTurn?: { turn: number; objectIds: string[] };
  /** R83: "can't play cards / spells this turn": in force during turn `turn`. */
  playLock?: { turn: number; what: 'CARDS' | 'SPELLS' };
  /** R105: "the next spell you play this turn costs [N] less" (cleared by the next matching play). */
  nextPlayDiscount?: { turn: number; energy: number; spellsOnly: boolean };
  /** R105: units this player plays during this turn number enter ready. */
  enterReadyTurn?: number;
  /** "The next unit you play this turn enters ready": the turn it was granted; cleared by the next unit played. */
  enterReadyNext?: number;
  /** "Buffs give an additional +N [M] to friendly units this turn" (Stand United): buffed friendly units get it. */
  buffBonus?: { turn: number; amount: number };
  /** R87: excess combat damage this player assigned as the attacker in the last combat of turn `turn`. */
  excessRecord?: { turn: number; amount: number };
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
  /** "Take a turn after this one": this player takes the turn after the current one. */
  extraTurnFor?: PlayerId;
  /** X7: all spell and ability damage is prevented during this turn number (Unyielding Spirit). */
  noEffectDamageTurn?: number;
  /**
   * Last known information of a token that left the game while its death trigger is still to resolve (Bomb):
   * where it stood and who controlled it. Stored only for such tokens.
   */
  lki?: Record<string, { cardId: string; controller: PlayerId; at: string | null }>;
  /** "This turn" triggers created by effects (delayed.ts); stored only when a card makes one. */
  delayed?: DelayedTrigger[];
}

/** A trigger that lasts for the rest of the turn (Rally the Troops, Fanfare, Deadly Flourish, Imperial Decree). */
export interface DelayedTrigger {
  controller: PlayerId;
  turn: number;
  on: 'UNIT_PLAYED' | 'UNIT_DAMAGED' | 'SUBJECT_DIES' | 'END_OF_TURN';
  /** How many more times it fires ("the next three times"); absent = every time this turn. */
  times?: number;
  /** SUBJECT_DIES: the unit it watches ("when it dies this turn"). */
  subject?: string;
  effects: CardEffect[];
  sourceCardId: string;
  /** UNIT_PLAYED with effects that need the unit: played but not yet on the board. */
  waiting?: string[];
}
