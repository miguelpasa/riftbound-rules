import type { CardInstance } from './types/index.js';

/**
 * X12 (109): when an object leaves the Board for a non-Board zone, every temporary modification stops
 * being tracked: damage, Buff, Might bonuses, temporarily granted keywords, stun, Empower. Mutates.
 */
export function clearBoardState(o: CardInstance): void {
  o.damage = 0;
  o.mightBonus = 0;
  delete o.tempMight;
  delete o.baseMightSet;
  delete o.deathReplace;
  delete o.deathOffer;
  delete o.deathDeclined;
  delete o.dmgMod;
  delete o.tempKeywords;
  delete o.unchoosableTurn;
  delete o.stunned;
  delete o.empowered;
  delete o.buffed;
  delete o.attachedTo;
  delete o.showedOff;
  delete o.paidExtra;
}
