import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { parseStaticLines } from '../cardText.js';
import type { CardDatabase, CardDef, StaticAbility } from '../types/index.js';

const withStatics = (statics: StaticAbility[]): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-archer': { ...(SCENARIO_CARDS['fx-archer'] as CardDef), statics },
});
const might = (sc: Scenario, id: string): number =>
  effectiveMight(sc.state, sc.cards, id, { role: null });

describe('scenario: filtered "here" statics (R70)', () => {
  it('"Units here with [Tank] have +1 [M]" affects only Tank units at that battlefield', () => {
    // Tests Rule 143.2: a static that names a keyword applies only to units with it
    const sc = Scenario.start(
      {},
      withStatics([{ affects: 'UNITS_HERE', might: 1, onlyKeyword: 'Tank' }]),
    );
    sc.putUnit('p0', 'fx-archer', 'bf0', { control: true });
    const tank = sc.putUnit('p0', 'fx-ash-tank', 'bf0');
    const grunt = sc.putUnit('p0', 'fx-grunt', 'bf0');
    expect(might(sc, tank)).toBe((SCENARIO_CARDS['fx-ash-tank']?.stats.might ?? 0) + 1);
    expect(might(sc, grunt)).toBe(SCENARIO_CARDS['fx-grunt']?.stats.might ?? 0);
  });
});

describe('parser: filtered statics', () => {
  it('reads "Units here with [Keyword]" and "Champion units here"', () => {
    // Tests Rule 143.2: parsed text
    expect(parseStaticLines('Units here with [Tank] have +1 [M].')?.statics[0]).toEqual({
      affects: 'UNITS_HERE',
      onlyKeyword: 'Tank',
      might: 1,
    });
    expect(parseStaticLines('Champion units here have +1 [M].')?.statics[0]).toEqual({
      affects: 'UNITS_HERE',
      onlySubtype: 'Champion',
      might: 1,
    });
    expect(
      parseStaticLines('Units here with [Temporary] have [Shield].')?.statics[0]?.keywords,
    ).toEqual([{ name: 'Shield' }]);
  });
});
