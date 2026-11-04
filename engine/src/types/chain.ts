import type { PlayerId } from './state.js';

/** Neutral/Showdown, Open/Closed (Rules 307-310). Open = chain empty; Closed = chain non-empty. */
export interface TurnState {
  kind: 'NEUTRAL' | 'SHOWDOWN';
  open: boolean;
}

/** A choice target: an object, a player, or a battlefield. */
export type Target =
  | { kind: 'object'; id: string }
  | { kind: 'player'; playerId: PlayerId }
  | { kind: 'battlefield'; battlefieldId: string };

export type ChoiceValue = string | number | boolean | string[];

export interface ChainItem {
  id: string;
  kind: 'CARD' | 'ABILITY';
  /** Card instance (for CARD) or object whose ability this is. */
  sourceObjectId: string;
  controller: PlayerId;
  /** PENDING while being played (Rule 328); FINALIZED once costs paid. */
  status: 'PENDING' | 'FINALIZED';
  targets: Target[];
  choices: Record<string, ChoiceValue>;
  /** Set when the effect text is not implemented (supportLevel 'partial'); resolves as a no-op + event. */
  unimplementedEffect?: boolean;
  /** Triggered or Add ability: Focus does not pass when its chain resolves (Rules 340.2.a, 346.1). */
  triggered?: boolean;
  /** For ABILITY items: index into the source's abilities. */
  abilityIndex?: number;
  /** Location chosen when playing a unit/gear. */
  location?: { kind: 'base' } | { kind: 'battlefield'; battlefieldId: string };
  /** Additional costs chosen (Accelerate). */
  additionalCosts?: { accelerate?: boolean };
}

export interface ShowdownState {
  battlefieldId: string;
  attacker?: PlayerId;
  defender?: PlayerId;
  /** True if this Showdown precedes combat (Rule 144+). */
  isCombat: boolean;
  /** Consecutive passes; two in a row closes priority round. */
  passesInRow: number;
}

export interface CombatState {
  step: 'SHOWDOWN' | 'DAMAGE' | 'RESOLUTION';
  /** Pending damage assignments, per damage-dealing player. */
  damageAssignment?: Partial<Record<PlayerId, { unitId: string; amount: number }[]>>;
  /** Player who still has to assign combat damage. */
  awaitingAssignmentFrom?: PlayerId | null;
}

/** Everything about who may act and what is on the chain. */
export interface FlowState {
  priority: PlayerId | null;
  focus: PlayerId | null;
  /** Index 0 = oldest; resolves from the end (LIFO). */
  chain: ChainItem[];
  showdown?: ShowdownState;
  combat?: CombatState;
  /** Battlefield ids waiting for a staged Showdown / Combat to begin. */
  stagedShowdowns: string[];
  stagedCombats: string[];
  /** Cleanup loop iteration count; capped by MAX_CLEANUP_ITERATIONS. */
  cleanupIterations: number;
}

/** Sequential mulligan in turn order. */
export interface MulliganState {
  order: PlayerId[];
  /** Index into `order` of the player currently deciding. */
  current: number;
  done: PlayerId[];
}
