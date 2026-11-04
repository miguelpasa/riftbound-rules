import type { GameEvent } from './event.js';
import type { GameState } from './state.js';

export type RuleErrorCode =
  | 'CLOSED_STATE_REACTION_ONLY'
  | 'WRONG_PHASE'
  | 'NOT_YOUR_PRIORITY'
  | 'NOT_YOUR_TURN'
  | 'INSUFFICIENT_RESOURCES'
  | 'ILLEGAL_TARGET'
  | 'MISSING_TARGET'
  | 'UNIT_EXHAUSTED'
  | 'MOVE_NOT_ALLOWED_IN_SHOWDOWN'
  | 'ILLEGAL_MOVE_DESTINATION'
  | 'INVALID_PAYMENT'
  | 'DECK_ILLEGAL'
  | 'MULLIGAN_ORDER'
  | 'MULLIGAN_INVALID'
  | 'NOT_IN_HAND'
  | 'NOT_FOUND'
  | 'NOT_OWNED'
  | 'GAME_OVER'
  | 'ILLEGAL_LOCATION'
  | 'NOT_A_REACTION'
  | 'WRONG_CARD_TYPE'
  | 'KEYWORD_RESTRICTION'
  | 'INVALID_DAMAGE_ASSIGNMENT'
  | 'HIDDEN_NOT_ALLOWED'
  | 'EQUIP_ILLEGAL'
  | 'ABILITY_NOT_AVAILABLE'
  | 'UNKNOWN_INTENT'
  | 'ENGINE_VERSION_MISMATCH';

export const RULE_ERROR_MESSAGES: Record<RuleErrorCode, string> = {
  CLOSED_STATE_REACTION_ONLY:
    '[Rule Error] Action illegal during an active Chain (Closed State). Only Reactions permitted. (Rule 309.1.a)',
  WRONG_PHASE: '[Rule Error] That action is not allowed in the current phase. (Rule 313)',
  NOT_YOUR_PRIORITY: '[Rule Error] You do not have priority. (Rule 310)',
  NOT_YOUR_TURN: '[Rule Error] Only the turn player may do that. (Rule 307)',
  INSUFFICIENT_RESOURCES: '[Rule Error] Not enough Energy or Power to pay the cost. (Rule 156)',
  ILLEGAL_TARGET: '[Rule Error] That is not a legal target. (Rule 178)',
  MISSING_TARGET: '[Rule Error] A required target was not chosen. (Rule 178)',
  UNIT_EXHAUSTED: '[Rule Error] That unit is exhausted. (Rule 140)',
  MOVE_NOT_ALLOWED_IN_SHOWDOWN:
    '[Rule Error] Standard Moves cannot be made during a Showdown. (Rule 144.1.c)',
  ILLEGAL_MOVE_DESTINATION:
    '[Rule Error] That is not a legal destination for this move. (Rule 144)',
  INVALID_PAYMENT: '[Rule Error] The payment plan is invalid for this cost. (Rule 164.2)',
  DECK_ILLEGAL: '[Rule Error] The deck does not satisfy deck construction rules. (Rule 103)',
  MULLIGAN_ORDER: '[Rule Error] Mulligan decisions are made in turn order. (Rule 117)',
  MULLIGAN_INVALID: '[Rule Error] Invalid mulligan selection. (Rule 117)',
  NOT_IN_HAND: '[Rule Error] That card is not in your hand. (Rule 107)',
  NOT_FOUND: '[Rule Error] Referenced object does not exist. (Rule 107)',
  NOT_OWNED: '[Rule Error] You do not control that object. (Rule 107)',
  GAME_OVER: '[Rule Error] The game has ended. (Rule 473.1)',
  ILLEGAL_LOCATION: '[Rule Error] That card cannot be played to that location. (Rule 144)',
  NOT_A_REACTION: '[Rule Error] That card does not have Reaction speed. (Rule 309.1.a)',
  WRONG_CARD_TYPE: '[Rule Error] Wrong card type for this action. (Rule 107)',
  KEYWORD_RESTRICTION: '[Rule Error] A keyword on a card forbids this action. (Rule 700)',
  INVALID_DAMAGE_ASSIGNMENT:
    '[Rule Error] Combat damage must be assigned per the combat damage rules. (Rule 144)',
  HIDDEN_NOT_ALLOWED: '[Rule Error] You cannot hide that card there. (Rule 700)',
  EQUIP_ILLEGAL: '[Rule Error] That Equipment cannot be attached to that unit. (Rule 700)',
  ABILITY_NOT_AVAILABLE: '[Rule Error] That ability cannot be activated now. (Rule 166)',
  UNKNOWN_INTENT: '[Rule Error] Unrecognised intent. (Rule 100)',
  ENGINE_VERSION_MISMATCH: '[Rule Error] Engine version mismatch between peers. (Rule 100)',
};

/** Immutable list of all codes, derived from the message map. */
export const RULE_ERROR_CODES = Object.keys(RULE_ERROR_MESSAGES) as RuleErrorCode[];

export interface RuleError {
  ok: false;
  code: RuleErrorCode;
  message: string;
}

/** Build a RuleError; `detail` is appended in parentheses to the standard message. */
export function ruleError(code: RuleErrorCode, detail?: string): RuleError {
  const base = RULE_ERROR_MESSAGES[code];
  return { ok: false, code, message: detail ? `${base} [${detail}]` : base };
}

export interface ReduceSuccess {
  ok: true;
  state: GameState;
  events: GameEvent[];
}

export type ReduceResult = ReduceSuccess | RuleError;
