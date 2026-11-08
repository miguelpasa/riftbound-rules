import { staticBonus } from './statics.js';
import type { CardDatabase, CardInstance, GameState, PlayerId } from './types/index.js';

/**
 * X7 (571-575): damage replacement effects. A unit may carry "prevent the next damage", "prevent the next N
 * damage" and "double all damage" markers (this turn only); a Static can prevent enemy spell / ability damage
 * to its source; a turn-wide flag prevents all spell and ability damage. The unit's owner orders several
 * replacements (575) and prefers prevention first, then doubling what is left.
 */
export interface DamageSource {
  kind: 'COMBAT' | 'EFFECT';
  /** The controller of the spell or ability (EFFECT only). */
  controller?: PlayerId;
}

/** The damage that is actually dealt to `o` (mutates the markers that were used up). */
export function applyDamageMods(
  state: GameState,
  cards: CardDatabase,
  o: CardInstance,
  amount: number,
  source: DamageSource,
): number {
  if (amount <= 0) return amount;
  let n = amount;
  if (source.kind === 'EFFECT') {
    if (state.noEffectDamageTurn === state.turn.number) return 0;
    if (
      source.controller !== undefined &&
      source.controller !== o.controller &&
      staticBonus(state, cards, o).noEnemyEffectDamage === true
    ) {
      return 0;
    }
  }
  const m = o.dmgMod;
  if (!m) return n;
  if (m.preventNext) {
    delete m.preventNext;
    n = 0;
  } else if (m.prevent !== undefined && m.prevent > 0) {
    const cut = Math.min(m.prevent, n);
    m.prevent -= cut;
    n -= cut;
    if (m.prevent <= 0) delete m.prevent;
  }
  if (m.double) n *= 2;
  if (!m.preventNext && m.prevent === undefined && !m.double) delete o.dmgMod;
  return n;
}
