import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { runEffects } from '../effects.js';
import { parseCardAbilities, parseSpellText } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const might = (sc: Scenario, id: string): number =>
  effectiveMight(sc.state, sc.cards, id, { role: null });

describe('scenario: Buff (R54)', () => {
  it('a Buff is +1 Might, only one per unit, and it is lost when the unit leaves the board', () => {
    // Tests Rule 143.2: a buff is a continuous +1 Might that cannot stack
    const sc = Scenario.start();
    const u = sc.putUnit('p0', 'fx-grunt', 'base');
    const base = might(sc, u);
    const s = structuredClone(sc.state);
    const ev1 = runEffects(
      s,
      'p0',
      [{ op: 'BUFF_SELF', amount: 1, buff: true }],
      sc.cards,
      [],
      '',
      u,
    );
    const ev2 = runEffects(
      s,
      'p0',
      [{ op: 'BUFF_SELF', amount: 1, buff: true }],
      sc.cards,
      [],
      '',
      u,
    );
    sc.state = s;
    expect(might(sc, u)).toBe(base + 1);
    expect(ev1.filter((e) => e.type === 'EFFECT_BUFF')).toHaveLength(1);
    expect(ev2.filter((e) => e.type === 'EFFECT_BUFF')).toHaveLength(0);
    expect(sc.obj(u).buffed).toBe(true);
  });

  it('"While I\'m buffed" statics follow the flag', () => {
    // Tests Rule 143.2: a conditional static reads the buffed state live
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-ash-tank': {
        ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef),
        statics: [{ affects: 'SELF', keywords: [{ name: 'Shield' }], when: { kind: 'BUFFED' } }],
      },
    };
    const sc = Scenario.start({}, cards);
    const u = sc.putUnit('p0', 'fx-ash-tank', 'base');
    expect(sc.obj(u).buffed).toBeUndefined();
    const s = structuredClone(sc.state);
    (s.objects[u] as { buffed?: boolean }).buffed = true;
    sc.state = s;
    expect(might(sc, u)).toBe((SCENARIO_CARDS['fx-ash-tank']?.stats.might ?? 0) + 1);
  });
});

describe('parser: Buff', () => {
  it('reads "[Buff] a unit", "[Buff] me" and "buff me"', () => {
    // Tests Rule 143.2: parsed Buff text
    expect(parseSpellText('[Buff] a friendly unit.')).toEqual([
      { op: 'BUFF_TARGET', amount: 1, buff: true, side: 'friendly' },
    ]);
    expect(parseCardAbilities('When I hold, [Buff] me.')?.triggers[0]?.effects).toEqual([
      { op: 'BUFF_SELF', amount: 1, buff: true },
    ]);
    expect(
      parseCardAbilities('When you play another unit, buff me.')?.triggers[0]?.effects,
    ).toEqual([{ op: 'BUFF_SELF', amount: 1, buff: true }]);
  });
});
