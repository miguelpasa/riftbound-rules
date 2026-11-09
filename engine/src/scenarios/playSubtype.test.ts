import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const text = 'When you play me or another Dragon, give me +2 [M] this turn.';
const trigger = parseCardAbilities(text)?.triggers ?? [];
const def = (id: string): CardDef => SCENARIO_CARDS[id] as CardDef;
/** `fx-ash-tank` stands in for Gentle Gemdragon; `fx-archer` is a Dragon, `fx-grunt` is not. */
const cards: CardDatabase = {
  ...SCENARIO_CARDS,
  'fx-ash-tank': { ...def('fx-ash-tank'), triggers: trigger },
  'fx-archer': { ...def('fx-archer'), subtypes: ['Dragon'] },
};
const mightOf = (sc: Scenario, id: string): number =>
  effectiveMight(sc.state, sc.cards, id, { role: null });
function settle(sc: Scenario): void {
  for (let i = 0; i < 10 && sc.state.flow.chain.length > 0; i++) {
    sc.pass(sc.state.flow.priority as 'p0' | 'p1');
  }
}
function playUnit(sc: Scenario, cardId: string): string {
  const id = sc.putInHand('p0', cardId);
  sc.play('p0', id, { payment: sc.exhaustPlan('p0', (cards[cardId] as CardDef).cost.energy) });
  settle(sc);
  return id;
}

describe('parser: "When you play me or another Dragon" (Gentle Gemdragon)', () => {
  it('reads as a play trigger for itself plus a subtype-filtered play trigger', () => {
    // Tests Rule 303: parsed trigger text
    expect(trigger.map((t) => t.on)).toEqual(['PLAY', 'YOU_PLAY']);
    expect(trigger[1]).toMatchObject({ playFilter: { subtype: 'Dragon', other: true } });
  });

  it('reads the plain "a Dragon" form too', () => {
    // Tests Rule 303: parsed trigger text
    const t = parseCardAbilities('When you play a Dragon, give me +2 [M] this turn.')?.triggers;
    expect(t?.map((x) => x.on)).toEqual(['YOU_PLAY']);
    expect(t?.[0]).toMatchObject({ playFilter: { subtype: 'Dragon' } });
  });
});

describe('scenario: a play trigger filtered by unit type (Dragon)', () => {
  it('fires when another Dragon is played, not for another type of unit', () => {
    // Tests Rule 303: a triggered ability fires on its event
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 8);
    const watcher = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const before = mightOf(sc, watcher);
    playUnit(sc, 'fx-grunt');
    expect(mightOf(sc, watcher)).toBe(before);
    playUnit(sc, 'fx-archer');
    expect(mightOf(sc, watcher)).toBe(before + 2);
  });

  it('fires when the card itself is played', () => {
    // Tests Rule 303: "When you play me" is the source entering
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 8);
    const me = playUnit(sc, 'fx-ash-tank');
    expect(mightOf(sc, me)).toBe(((cards['fx-ash-tank'] as CardDef).stats.might ?? 0) + 2);
  });
});
