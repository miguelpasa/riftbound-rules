/**
 * Temporary keyword grants (R43): "Give a friendly unit [Tank] this turn". A grant is stored on the
 * object (`CardInstance.tempKeywords`, public) and removed in the Ending step with the other
 * "this turn" effects (expireTurnEffects). Reads of combat / movement keywords go through
 * `defWithTemp`, which adds the grants to the printed keywords.
 */
import type { CardDef, CardInstance, KeywordInstance } from './types/index.js';

/** The grantable keywords: the ones with a runtime read (Assault, Shield, Tank, Ganking). */
export const GRANTABLE_KEYWORDS: readonly KeywordInstance['name'][] = [
  'Assault',
  'Shield',
  'Tank',
  'Ganking',
];

/** The printed definition plus this object's temporary grants (the same object if none). */
export function defWithTemp(
  def: CardDef | undefined,
  obj: Pick<CardInstance, 'tempKeywords'> | undefined,
): CardDef | undefined {
  if (!def || !obj?.tempKeywords || obj.tempKeywords.length === 0) return def;
  return { ...def, keywords: [...def.keywords, ...obj.tempKeywords] };
}
