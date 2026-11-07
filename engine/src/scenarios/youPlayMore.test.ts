import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { TOKEN_CARDS } from '../tokens.js';
import { effectiveMight } from '../combat.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef, PlayFilter } from '../types/index.js';

const watcher = (playFilter: PlayFilter): CardDatabase => ({
  ...TOKEN_CARDS,
  ...SCENARIO_CARDS,
  'fx-ash-tank': {
    ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef),
    triggers: [{ on: 'YOU_PLAY', playFilter, effects: [{ op: 'BUFF_SELF', amount: 2 }] }],
  },
  'fx-grunt': {
    ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
    triggers: [{ on: 'PLAY', effects: [{ op: 'PLAY_TOKEN', token: 'tok-recruit', count: 1 }] }],
  },
});
function settle(sc: Scenario): void {
  for (let i = 0; i < 10 && sc.state.flow.chain.length > 0; i++) {
    sc.pass(sc.state.flow.priority as 'p0' | 'p1');
  }
}
const mightOf = (sc: Scenario, id: string): number =>
  effectiveMight(sc.state, sc.cards, id, { role: null });

describe('scenario: more "When you play ..." heads (R99)', () => {
  it('"a token unit" fires when a token is played by an effect, not for cards', () => {
    // Tests Rule 303: a token being played is an event
    const sc = Scenario.start({}, watcher({ token: true }));
    const w = sc.putUnit('p0', 'fx-ash-tank', 'base');
    sc.giveRunes('p0', 4);
    const before = mightOf(sc, w);
    const spell = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', spell, { payment: sc.exhaustPlan('p0', 1) });
    settle(sc);
    expect(mightOf(sc, w)).toBe(before); // a spell is not a token
    const g = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', g, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    for (let i = 0; i < 8 && sc.state.flow.chain.length > 0; i++) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
    expect(mightOf(sc, w)).toBe(before + 2); // the grunt's Recruit token
  });

  it('"your second card in a turn" fires only for the second card', () => {
    // Tests Rule 303: counted plays this turn
    const sc = Scenario.start({}, watcher({ nth: 2 }));
    const w = sc.putUnit('p0', 'fx-ash-tank', 'base');
    sc.giveRunes('p0', 4);
    const before = mightOf(sc, w);
    const f1 = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', f1, { payment: sc.exhaustPlan('p0', 1) });
    settle(sc);
    expect(mightOf(sc, w)).toBe(before);
    const f2 = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', f2, { payment: sc.exhaustPlan('p0', 1) });
    settle(sc);
    expect(mightOf(sc, w)).toBe(before + 2);
    const f3 = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', f3, { payment: sc.exhaustPlan('p0', 1) });
    settle(sc);
    expect(mightOf(sc, w)).toBe(before + 2); // the third card does not count
  });

  it('"with Power cost [A][A] or more" compares the printed Power cost', () => {
    // Tests Rule 303: cost filters on the played card
    const cards = watcher({ minPower: 2 });
    cards['fx-flare'] = { ...(cards['fx-flare'] as CardDef), cost: { energy: 1, power: 2 } };
    const sc = Scenario.start({}, cards);
    const w = sc.putUnit('p0', 'fx-ash-tank', 'base');
    sc.setRunes('p0', ['Fury', 'Fury', 'Fury']);
    const before = mightOf(sc, w);
    // Pay the Power with a rune recycle: exhaust one rune for Energy, recycle two for Power.
    const spell = sc.putInHand('p0', 'fx-flare');
    const runes = sc.runes('p0');
    sc.play('p0', spell, {
      payment: [
        { runeId: runes[0]!.id, mode: 'EXHAUST' },
        { runeId: runes[1]!.id, mode: 'RECYCLE' },
        { runeId: runes[2]!.id, mode: 'RECYCLE' },
      ],
    });
    settle(sc);
    expect(mightOf(sc, w)).toBe(before + 2);
  });
});

describe('parser: more play heads (R99)', () => {
  it('reads token units, Power cost thresholds and "second card in a turn"', () => {
    // Tests Rule 303: parsed text
    const f = (s: string) => parseCardAbilities(s)?.triggers[0]?.playFilter;
    expect(f('When you play a token unit, give me +1 [M] this turn.')).toEqual({ token: true });
    expect(f('When you play a card with Power cost [A][A] or more, draw 1.')).toEqual({
      minPower: 2,
    });
    expect(f('When you play your second card in a turn, give me +2 [M] this turn.')).toEqual({
      nth: 2,
    });
  });
});
