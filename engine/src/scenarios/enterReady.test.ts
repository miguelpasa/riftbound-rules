import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { TOKEN_CARDS } from '../tokens.js';
import { parseCardAbilities, parseStaticLines } from '../cardText.js';
import type { CardDatabase, CardDef, StaticAbility } from '../types/index.js';

const withStatic = (id: string, s: StaticAbility): CardDatabase => ({
  ...SCENARIO_CARDS,
  [id]: { ...(SCENARIO_CARDS[id] as CardDef), statics: [s] },
});

describe('scenario: statics that make units enter ready (R88)', () => {
  it('"Other friendly units enter ready" readies a unit played next to the source, not the source', () => {
    // Tests Rule 359.2: units normally enter exhausted
    const sc = Scenario.start(
      {},
      withStatic('fx-ash-tank', { affects: 'OTHER_FRIENDLY_UNITS', entersReady: true }),
    );
    sc.putUnit('p0', 'fx-ash-tank', 'base');
    const g = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', g, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    expect(sc.obj(g).ready).toBe(true);
    sc.verify();
  });

  it('without the static the unit still enters exhausted', () => {
    // Tests Rule 359.2: the baseline
    const sc = Scenario.start();
    const g = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', g, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    expect(sc.obj(g).ready).toBe(false);
  });

  it('"Your tokens enter ready" readies played tokens only', () => {
    // Tests Rule 186: tokens enter like units
    const cards: CardDatabase = {
      ...TOKEN_CARDS,
      ...withStatic('fx-ash-tank', {
        affects: 'FRIENDLY_UNITS',
        onlyToken: true,
        entersReady: true,
      }),
      'fx-grunt': {
        ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
        triggers: [{ on: 'PLAY', effects: [{ op: 'PLAY_TOKEN', token: 'tok-recruit', count: 1 }] }],
      },
    };
    const sc = Scenario.start({}, cards);
    sc.putUnit('p0', 'fx-ash-tank', 'base');
    const g = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', g, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    sc.pass('p1');
    sc.pass('p0');
    const token = Object.values(sc.state.objects).find((o) => o.cardId === 'tok-recruit');
    expect(token?.ready).toBe(true);
    expect(sc.obj(g).ready).toBe(false); // a card, not a token
  });
});

describe('parser: "first time each turn" and enter-ready statics (R88)', () => {
  it('reads them', () => {
    // Tests Rule 303: parsed text
    expect(
      parseCardAbilities('The first time I conquer each turn, ready me.')?.triggers[0],
    ).toMatchObject({ on: 'CONQUER', oncePerTurn: true, effects: [{ op: 'READY_SELF' }] });
    expect(
      parseCardAbilities('The first time a friendly unit dies each turn, draw 1.')?.triggers[0],
    ).toMatchObject({ on: 'UNIT_DIES', oncePerTurn: true });
    expect(parseStaticLines('Your tokens enter ready.')?.statics).toEqual([
      { affects: 'FRIENDLY_UNITS', onlyToken: true, entersReady: true },
    ]);
    expect(parseStaticLines('Other friendly units enter ready.')?.statics).toEqual([
      { affects: 'OTHER_FRIENDLY_UNITS', entersReady: true },
    ]);
    expect(parseStaticLines('Your token units have +1 [M].')?.statics).toEqual([
      { affects: 'FRIENDLY_UNITS', onlyToken: true, might: 1 },
    ]);
  });
});
