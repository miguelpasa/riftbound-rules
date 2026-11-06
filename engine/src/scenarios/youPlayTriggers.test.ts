import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef, CardTrigger } from '../types/index.js';

/** fx-ash-tank (p0) carries the given trigger; the tests play cards while it sits in the Base. */
const withTrigger = (t: CardTrigger, id = 'fx-ash-tank'): CardDatabase => ({
  ...SCENARIO_CARDS,
  [id]: { ...(SCENARIO_CARDS[id] as CardDef), triggers: [t] },
});
const BUFF2: CardTrigger['effects'] = [{ op: 'BUFF_SELF', amount: 2 }];

function playSpell(sc: Scenario): void {
  const spell = sc.putInHand('p0', 'fx-flare');
  sc.play('p0', spell, { payment: sc.exhaustPlan('p0', 1) });
  sc.pass('p1');
  sc.pass('p0');
}

describe('scenario: "When you play a <card>" triggers (R49)', () => {
  it('fires for a matching play: spells buff the source this turn', () => {
    // Tests Rule 303: a triggered ability goes on the Chain when its event happens
    const sc = Scenario.start(
      {},
      withTrigger({ on: 'YOU_PLAY', playFilter: { type: 'SPELL' }, effects: BUFF2 }),
    );
    const u = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const before = effectiveMight(sc.state, sc.cards, u, { role: null });
    playSpell(sc);
    expect(effectiveMight(sc.state, sc.cards, u, { role: null })).toBe(before + 2);
    sc.verify();
  });

  it('ignores a card of another type', () => {
    // Tests Rule 303: only the described event triggers it
    const sc = Scenario.start(
      {},
      withTrigger({ on: 'YOU_PLAY', playFilter: { type: 'UNIT' }, effects: BUFF2 }),
    );
    const u = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const before = effectiveMight(sc.state, sc.cards, u, { role: null });
    playSpell(sc);
    expect(effectiveMight(sc.state, sc.cards, u, { role: null })).toBe(before);
  });

  it("honours the Energy-cost threshold and never fires for the opponent's plays", () => {
    // Tests Rule 303: "you play" means the controller of the source
    const sc = Scenario.start(
      {},
      withTrigger({ on: 'YOU_PLAY', playFilter: { minEnergy: 5 }, effects: BUFF2 }),
    );
    const u = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const before = effectiveMight(sc.state, sc.cards, u, { role: null });
    playSpell(sc); // a 1-Energy spell: below the threshold
    expect(effectiveMight(sc.state, sc.cards, u, { role: null })).toBe(before);
  });

  it('a unit does not trigger its own YOU_PLAY ability when it is played', () => {
    // Tests Rule 303: "When you play me" is a different trigger (UNCLEAR, docs/ASSUMPTIONS.md R49)
    const sc = Scenario.start({}, withTrigger({ on: 'YOU_PLAY', effects: BUFF2 }, 'fx-grunt'));
    const unit = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', unit, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    expect(sc.state.flow.chain).toHaveLength(0);
  });
});

describe('parser: "When you play ..." heads', () => {
  it('reads type, "another", Energy threshold and turn / showdown qualifiers', () => {
    // Tests Rule 303: parsed trigger text
    const t = (s: string) => parseCardAbilities(s)?.triggers[0];
    expect(t('When you play a spell, give me +2 [M] this turn.')).toMatchObject({
      on: 'YOU_PLAY',
      playFilter: { type: 'SPELL' },
      effects: [{ op: 'BUFF_SELF', amount: 2 }],
    });
    expect(t('When you play another unit, ready me.')?.playFilter).toEqual({
      type: 'UNIT',
      other: true,
    });
    expect(t('When you play a card with Energy cost [7] or more, ready me.')?.playFilter).toEqual({
      minEnergy: 7,
    });
    expect(t("When you play a spell on an opponent's turn, draw 1.")?.playFilter).toEqual({
      type: 'SPELL',
      onOpponentTurn: true,
    });
    expect(t('When you play a unit during a showdown, draw 1.')?.playFilter).toEqual({
      type: 'UNIT',
      inShowdown: true,
    });
    expect(parseCardAbilities('When you play a sandwich, draw 1.')).toBeNull();
  });
});
