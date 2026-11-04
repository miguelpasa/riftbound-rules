/**
 * Intent validation for hosts/UIs: "would the engine accept this?".
 *
 * Implementation: run `reduce` on a structuredClone of the state and discard the result. The engine is
 * pure (it never mutates its input), so the clone is belt-and-braces: even a buggy handler could not
 * corrupt the caller's state through this path. There is deliberately no second, hand-written rules
 * check that could drift from the reducer.
 */
import { getLegalActions, getRuneActivations } from './legalActions.js';
import { reduce } from './reducer.js';
import type { CardDatabase, GameState, Intent, RuleError } from './types/index.js';

export function validateIntent(
  state: GameState,
  cards: CardDatabase,
  intent: Intent,
): { ok: true } | RuleError {
  const r = reduce(structuredClone(state), cards, intent);
  return r.ok ? { ok: true } : r;
}

export { getLegalActions, getRuneActivations };

/** PRD-compatible name: `RulesValidator.validate(...)`, `RulesValidator.getLegalActions(...)`. */
export const RulesValidator = {
  validate: validateIntent,
  getLegalActions,
} as const;
