import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { parseStaticLines } from '../cardText.js';
import type { CardDatabase, CardDef, StaticAbility } from '../types/index.js';

const withStatics = (statics: StaticAbility[]): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-ash-tank': { ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef), statics },
});
const base = SCENARIO_CARDS['fx-ash-tank']?.stats.might ?? 0;
const might = (sc: Scenario, id: string, role: 'ATTACKER' | null = null): number =>
  effectiveMight(sc.state, sc.cards, id, { role });

describe('scenario: counted statics (R67)', () => {
  it('"+1 [M] for each other exhausted unit you control" follows the exhausted count', () => {
    // Tests Rule 143.2: continuous Might that counts something on the board
    const sc = Scenario.start(
      {},
      withStatics([{ affects: 'SELF', might: 1, per: 'OTHER_EXHAUSTED_UNIT' }]),
    );
    const u = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const a = sc.putUnit('p0', 'fx-grunt', 'base');
    const b = sc.putUnit('p0', 'fx-archer', 'base');
    sc.putUnit('p1', 'fx-tide-grunt', 'base');
    expect(might(sc, u)).toBe(base);
    sc.setReady(a, false);
    sc.setReady(b, false);
    expect(might(sc, u)).toBe(base + 2);
  });

  it('"My Might is increased by your points" and "[Assault] equal to the number of enemy units here"', () => {
    // Tests Rule 143.2: counts of points / enemy units
    const sc = Scenario.start(
      {},
      withStatics([
        { affects: 'SELF', might: 1, per: 'POINTS' },
        { affects: 'SELF', per: 'ENEMY_UNITS_HERE', perKeyword: 'Assault' },
      ]),
    );
    const u = sc.putUnit('p0', 'fx-ash-tank', 'bf0', { control: true });
    sc.putUnit('p1', 'fx-tide-grunt', 'bf0');
    sc.putUnit('p1', 'fx-tide-archer', 'bf0');
    sc.setPoints('p0', 3);
    expect(might(sc, u)).toBe(base + 3);
    expect(might(sc, u, 'ATTACKER')).toBe(base + 3 + 2); // Assault 2 for two enemy units
  });
});

describe('parser: counted statics', () => {
  it('reads "for each" Might, points and "[Assault] equal to the number of"', () => {
    // Tests Rule 143.2: parsed text
    expect(
      parseStaticLines('I have +1 [M] for each other exhausted unit you control.')?.statics[0],
    ).toEqual({
      affects: 'SELF',
      might: 1,
      per: 'OTHER_EXHAUSTED_UNIT',
    });
    expect(parseStaticLines('My Might is increased by your points.')?.statics[0]).toEqual({
      affects: 'SELF',
      might: 1,
      per: 'POINTS',
    });
    expect(
      parseStaticLines('I have [Assault] equal to the number of gear you control.')?.statics[0],
    ).toEqual({
      affects: 'SELF',
      per: 'FRIENDLY_GEAR',
      perKeyword: 'Assault',
    });
    expect(parseStaticLines('I have +1 [M] for each sandwich.')).toBeNull();
  });
});
