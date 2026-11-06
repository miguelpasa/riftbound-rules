import type { ChoiceValue, Target } from './chain.js';
import type { PlayerId } from './state.js';

/** One rune action. EXHAUST produces energy; RECYCLE produces power (Rule 164.2). */
export interface RuneAction {
  runeId: string;
  mode: 'EXHAUST' | 'RECYCLE';
}

/** Ordered list of rune actions used to pay a cost. */
export type PaymentPlan = RuneAction[];

export type PlayLocation = { kind: 'base' } | { kind: 'battlefield'; battlefieldId: string };

interface IntentBase {
  playerId: PlayerId;
}

export interface MulliganIntent extends IntentBase {
  type: 'MULLIGAN';
  /** Hand cards to set aside (up to MAX_MULLIGAN). */
  cardIds: string[];
}
export interface PassPriorityIntent extends IntentBase {
  type: 'PASS_PRIORITY';
}
/** Finish the Main Phase. */
export interface EndTurnIntent extends IntentBase {
  type: 'END_TURN';
}
export interface PlayCardIntent extends IntentBase {
  type: 'PLAY_CARD';
  cardInstanceId: string;
  location?: PlayLocation;
  targets?: Target[];
  choices?: Record<string, ChoiceValue>;
  /** Accelerate (units) and Repeat (spells with a Repeat cost, 820) are optional additional costs. */
  additionalCosts?: { accelerate?: boolean; repeat?: boolean; extra?: boolean };
  /**
   * R47: the cards that pay a card-choice additional cost (`CardDef.additionalCost`, or the Repeat cost
   * `repeatCost.card` when Repeat is paid): object ids, validated before anything is paid.
   */
  costCards?: string[];
  payment: PaymentPlan;
}
/** Activate a rune's ability (adds to Rune Pool; Reaction speed). */
export interface ActivateRuneIntent extends IntentBase {
  type: 'ACTIVATE_RUNE';
  runeId: string;
  mode: 'EXHAUST' | 'RECYCLE';
}
export interface StandardMoveIntent extends IntentBase {
  type: 'STANDARD_MOVE';
  unitIds: string[];
  destination: PlayLocation;
}
export interface AssignCombatDamageIntent extends IntentBase {
  type: 'ASSIGN_COMBAT_DAMAGE';
  assignments: { unitId: string; amount: number }[];
}
export interface HideCardIntent extends IntentBase {
  type: 'HIDE_CARD';
  cardInstanceId: string;
  battlefieldId: string;
}
export interface ActivateAbilityIntent extends IntentBase {
  type: 'ACTIVATE_ABILITY';
  sourceId: string;
  abilityIndex: number;
  targets?: Target[];
  /** R46: the cards that pay a card-choice cost (`AbilityCost.card`): object ids, validated by the engine. */
  costCards?: string[];
  payment: PaymentPlan;
}
export interface EquipIntent extends IntentBase {
  type: 'EQUIP';
  equipmentId: string;
  unitId: string;
}
/** Turn player's answer to flow.pendingChoice: begin this battlefield's Showdown/Combat first. */
export interface ChooseStagedIntent extends IntentBase {
  type: 'CHOOSE_STAGED';
  battlefieldId: string;
}
/**
 * Answer to a flow.pendingChoice of kind TRIGGER_TARGET (R41): the controller of a triggered ability
 * picks its targets (object targets only, validated like a spell's).
 */
export interface ChooseTriggerTargetIntent extends IntentBase {
  type: 'CHOOSE_TRIGGER_TARGET';
  chainItemId: string;
  targets: Target[];
}
/**
 * Answer to a flow.pendingChoice of kind OPTIONAL_EFFECT (R45): accept or decline a "you may [pay
 * COST to] ..." triggered ability that is resolving. `payment` (accept only) is the rune plan used to
 * pay an Energy / Power cost, exactly like PLAY_CARD.payment; when absent the engine uses an automatic
 * plan (`autoPlan`).
 */
export interface DecideOptionalIntent extends IntentBase {
  type: 'DECIDE_OPTIONAL';
  chainItemId: string;
  accept: boolean;
  payment?: PaymentPlan;
  /** R46: the cards that pay a card-choice cost (`OptionalCost.card`); required on accept when the cost has one. */
  costCards?: string[];
}
export interface ConcedeIntent extends IntentBase {
  type: 'CONCEDE';
}

export type Intent =
  | MulliganIntent
  | PassPriorityIntent
  | EndTurnIntent
  | PlayCardIntent
  | ActivateRuneIntent
  | StandardMoveIntent
  | AssignCombatDamageIntent
  | HideCardIntent
  | ActivateAbilityIntent
  | EquipIntent
  | ChooseStagedIntent
  | ChooseTriggerTargetIntent
  | DecideOptionalIntent
  | ConcedeIntent;

export type IntentType = Intent['type'];

/** PRD name for Intent. */
export type UserIntent = Intent;
