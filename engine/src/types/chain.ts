import type { OptionalCost } from './card.js';
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
  /** Card instance (for CARD) or object whose ability this is ('' for a Battlefield card's ability). */
  sourceObjectId: string;
  /**
   * R44: set for an ability of a Battlefield card ("When you conquer here, ..."), which is not an
   * object. The id of its `BattlefieldState`; `sourceObjectId` is then ''. Absent for every other item.
   */
  sourceBattlefieldId?: string;
  /** X4 (723.1.d): a spell played from face down may only choose targets at this battlefield. */
  hiddenAt?: string;
  controller: PlayerId;
  /** PENDING while being played (Rule 328); FINALIZED once costs paid. */
  status: 'PENDING' | 'FINALIZED';
  targets: Target[];
  /** X3: the generation of each targeted object when the targets were chosen (see targetGens.ts). */
  targetGens?: Record<string, number>;
  choices: Record<string, ChoiceValue>;
  /** Set when the effect text is not implemented (supportLevel 'partial'); resolves as a no-op + event. */
  unimplementedEffect?: boolean;
  /** Triggered or Add ability: Focus does not pass when its chain resolves (Rules 340.2.a, 346.1). */
  triggered?: boolean;
  /** For triggered ABILITY items: index into the source card's `triggers`. */
  triggerIndex?: number;
  /** For ABILITY items: index into the source's abilities. */
  abilityIndex?: number;
  /** For ABILITY items from ACTIVATE_ABILITY: index into the source card's `abilities`. */
  activatedIndex?: number;
  /** For ACTIVATE_ABILITY items: the source's card id (the source may be gone, e.g. killed as a cost). */
  sourceCardId?: string;
  /** Location chosen when playing a unit/gear. */
  location?: { kind: 'base' } | { kind: 'battlefield'; battlefieldId: string };
  /** R45: the controller's answer to an optional ("you may pay ...") triggered ability, set before it resolves. */
  optionalDecision?: 'ACCEPT' | 'DECLINE';
  /** Additional costs chosen (Accelerate). */
  additionalCosts?: { accelerate?: boolean; repeat?: boolean; extra?: boolean; flow?: boolean };
  /** R59: the chosen mode of a modal spell. */
  mode?: number;
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
  /** Battlefield where this combat takes place (316.7). */
  battlefieldId: string;
  /** Attacker / Defender designations (466.2.c): attacker = player whose units applied Contested. */
  attacker: PlayerId;
  defender: PlayerId;
  step: 'SHOWDOWN' | 'DAMAGE' | 'RESOLUTION';
  /** Pending damage assignments, per damage-dealing player. */
  damageAssignment?: Partial<Record<PlayerId, { unitId: string; amount: number }[]>>;
  /** Player who still has to assign combat damage. */
  awaitingAssignmentFrom?: PlayerId | null;
  /** R87: excess combat damage the attacker assigned (only tracked when a card needs it). */
  excess?: number;
}

/**
 * A decision the engine is paused on before the Cleanup may continue (Rules 323.11, 323.12, 463.1):
 * several Showdowns (or Combats) are staged in Neutral Open and the turn player picks which
 * battlefield begins first. Only CHOOSE_STAGED (and CONCEDE) are accepted while it is set.
 */
export interface StagedOrderChoice {
  kind: 'STAGED_ORDER';
  /** The deciding player: the turn player. */
  player: PlayerId;
  /** Whether the options are staged Showdowns (323.11) or staged Combats (323.12). */
  stage: 'SHOWDOWN' | 'COMBAT';
  /** Battlefield ids (at least two), in battlefield index order. */
  options: string[];
}

/**
 * R41: a triggered ability with several legal target choices sits on the Chain as a PENDING item
 * and its controller picks the targets (CHOOSE_TRIGGER_TARGET) before anyone else may act. The
 * legal choices are derived from the item's effects (`enumerateSpellTargets` / `spellTargetsLegal`).
 */
export interface TriggerTargetChoice {
  kind: 'TRIGGER_TARGET';
  /** The controller of the triggered ability. */
  player: PlayerId;
  /** The PENDING ABILITY item on `flow.chain` that still needs its targets. */
  chainItemId: string;
}

/**
 * R45: a triggered ability with "you may [pay COST to] ..." reached the top of the Chain. The item stays
 * on the Chain (FINALIZED, newest) and its controller answers with DECIDE_OPTIONAL: accept (pay the
 * cost, run the effects) or decline (nothing happens). Nobody else may act meanwhile.
 */
export interface OptionalEffectChoice {
  kind: 'OPTIONAL_EFFECT';
  /** The controller of the triggered ability. */
  player: PlayerId;
  /** The ABILITY item waiting on top of `flow.chain`. */
  chainItemId: string;
  /** What accepting costs (public data copied from the card; `{}` = free). */
  cost: OptionalCost;
}

/** X7: one way to replace the death of a unit with a recall. */
export interface DeathReplaceOffer {
  /** The source object or Battlefield card; for a marker offer (Unlicensed Armory) the unit itself. */
  sourceId: string;
  /** The source card (the Domain of its [C]). */
  cardId: string;
  cost: OptionalCost;
  exhaustSource?: boolean;
  spendBuff?: boolean;
  oncePerTurn?: boolean;
  /** True when the offer is a marker on the unit rather than a standing ability. */
  marker?: boolean;
}

/**
 * X7 (575): a unit would die and its controller may pay to have it recalled instead. The Cleanup pauses
 * (the unit keeps its lethal damage) until DECIDE_REPLACEMENT answers; nobody else may act meanwhile.
 */
export interface DeathReplaceChoice {
  kind: 'DEATH_REPLACE';
  player: PlayerId;
  unitId: string;
  offers: DeathReplaceOffer[];
}

export type PendingChoice =
  | StagedOrderChoice
  | TriggerTargetChoice
  | OptionalEffectChoice
  | DeathReplaceChoice;

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
  /** Set while the Cleanup waits for a player's decision (see PendingChoice). */
  pendingChoice?: PendingChoice;
}

/** Sequential mulligan in turn order. */
export interface MulliganState {
  order: PlayerId[];
  /** Index into `order` of the player currently deciding. */
  current: number;
  done: PlayerId[];
}
