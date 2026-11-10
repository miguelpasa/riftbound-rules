import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseStaticLines } from '../cardText.js';
import { staticBonus } from '../statics.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const TEXT = 'Your Equipment each give [Assault].';

describe('scenario: "Your Equipment each give [Assault]" (Purifier)', () => {
  it('reads a keyword static for units carrying your Equipment', () => {
    // Tests Rule 604: static abilities grant keywords
    expect(parseStaticLines(TEXT)?.statics[0]).toMatchObject({
      affects: 'EQUIPPED_UNITS',
      keywords: [{ name: 'Assault' }],
    });
  });

  it('grants one [Assault] per attached friendly Equipment, and nothing to unequipped units', () => {
    // Tests Rule 604: the keyword is granted to the equipped unit
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-ash-tank': {
        ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef),
        statics: parseStaticLines(TEXT)?.statics ?? [],
      },
    };
    const sc = Scenario.start({}, cards);
    sc.putUnit('p0', 'fx-ash-tank', 'base'); // the legend-like source
    const carrier = sc.putUnit('p0', 'fx-grunt', 'base');
    const bare = sc.putUnit('p0', 'fx-archer', 'base');
    const assault = (id: string): number =>
      staticBonus(sc.state, sc.cards, sc.state.objects[id]).keywords.filter(
        (k) => k.name === 'Assault',
      ).length;
    expect(assault(carrier)).toBe(0);
    const blade = sc.putUnit('p0', 'fx-blade', 'base');
    (sc.state.objects[blade] as { attachedTo?: string }).attachedTo = carrier;
    expect(assault(carrier)).toBe(1);
    expect(assault(bare)).toBe(0);
    const blade2 = sc.putUnit('p0', 'fx-blade', 'base');
    (sc.state.objects[blade2] as { attachedTo?: string }).attachedTo = carrier;
    expect(assault(carrier)).toBe(2);
  });
});
