import type { CardDef, CardInstance } from './types/index.js';

/**
 * X2 (637.1.a.1, 639.1): "base Might becomes N" assigns Might in the first layer (trait-altering), before
 * any +/- arithmetic (637.3). The newest assignment wins (timestamp order, 639.1), so it is stored as the
 * object's current base rather than as a delta against the printed Might. Returns the base Might that the
 * arithmetic layer (mightBonus, Buff, statics, equipment, combat keywords) is added to.
 */
export function baseMight(def: CardDef | undefined, o: CardInstance | undefined): number {
  return o?.baseMightSet ?? def?.stats.might ?? 0;
}
