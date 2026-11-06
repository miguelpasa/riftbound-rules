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
  additionalCosts?: { accelerate?: boolean };
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
  | ConcedeIntent;

export type IntentType = Intent['type'];

/** PRD name for Intent. */
export type UserIntent = Intent;
