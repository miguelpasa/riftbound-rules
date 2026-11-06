import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { deflectExtraCost } from '../keywords.js';
import { getLegalActions } from '../legalActions.js';
import { parseStaticLines } from '../cardText.js';
import type { CardDatabase, CardDef, StaticAbility } from '../types/index.js';

/** fx-ash-tank carries the given static abilities. */
const withStatics = (statics: StaticAbility[]): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-ash-tank': { ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef), statics },
});
const might = (sc: Scenario, id: string): number =>
  effectiveMight(sc.state, sc.cards, id, { role: null });

describe('scenario: static abilities (R51)', () => {
  it('"other friendly units here" grants Might only at the source\'s battlefield', () => {
    // Tests Rule 143.2: Might includes continuous bonuses from static abilities
    const sc = Scenario.start({}, withStatics([{ affects: 'OTHER_FRIENDLY_HERE', might: 2 }]));
    const src = sc.putUnit('p0', 'fx-ash-tank', 'bf0', { control: true });
    const here = sc.putUnit('p0', 'fx-grunt', 'bf0');
    const away = sc.putUnit('p0', 'fx-archer', 'base');
    const enemy = sc.putUnit('p1', 'fx-tide-grunt', 'bf0');
    const base = (id: string) => (SCENARIO_CARDS[sc.obj(id).cardId] as CardDef).stats.might ?? 0;
    expect(might(sc, here)).toBe(base(here) + 2);
    expect(might(sc, away)).toBe(base(away));
    expect(might(sc, enemy)).toBe(base(enemy));
    expect(might(sc, src)).toBe(base(src)); // "other"
  });

  it('a condition is evaluated live: +2 only while another friendly unit is here', () => {
    // Tests Rule 143.2: a conditional static applies only while its condition holds
    const sc = Scenario.start(
      {},
      withStatics([
        {
          affects: 'SELF',
          might: 2,
          when: {
            kind: 'COUNT',
            what: 'unit',
            where: 'here',
            who: 'friendly',
            other: true,
            cmp: 'GTE',
            n: 1,
          },
        },
      ]),
    );
    const src = sc.putUnit('p0', 'fx-ash-tank', 'bf0', { control: true });
    const base = (SCENARIO_CARDS['fx-ash-tank'] as CardDef).stats.might ?? 0;
    expect(might(sc, src)).toBe(base);
    sc.putUnit('p0', 'fx-grunt', 'bf0');
    expect(might(sc, src)).toBe(base + 2);
  });

  it('granted Deflect makes opponents pay extra to target the unit', () => {
    // Tests Rule 809: Deflect surcharges targeting (here granted by a static ability)
    const sc = Scenario.start(
      {},
      withStatics([{ affects: 'FRIENDLY_UNITS', keywords: [{ name: 'Deflect' }] }]),
    );
    sc.putUnit('p0', 'fx-ash-tank', 'base');
    const target = sc.putUnit('p0', 'fx-grunt', 'base');
    expect(deflectExtraCost(sc.state, sc.cards, 'p1', [{ kind: 'object', id: target }])).toEqual({
      anyPower: 1,
    });
    expect(deflectExtraCost(sc.state, sc.cards, 'p0', [{ kind: 'object', id: target }])).toBeNull();
  });

  it('granted Ganking lets a unit move between battlefields', () => {
    // Tests Rule 144.4.c.1: a unit with Ganking may move battlefield to battlefield
    const sc = Scenario.start(
      {},
      withStatics([{ affects: 'FRIENDLY_UNITS', keywords: [{ name: 'Ganking' }] }]),
    );
    sc.putUnit('p0', 'fx-ash-tank', 'base');
    const u = sc.putUnit('p0', 'fx-grunt', 'bf0', { control: true });
    const moves = getLegalActions(sc.state, sc.cards, 'p0').filter(
      (i) =>
        i.type === 'STANDARD_MOVE' && i.unitIds.includes(u) && i.destination.kind === 'battlefield',
    );
    expect(moves.length).toBeGreaterThan(0);
  });
});

describe('parser: static lines', () => {
  it('reads who is affected, the grant and an optional condition, and keeps other lines', () => {
    // Tests Rule 143.2: parsed static text
    expect(parseStaticLines('Your gear have [Deflect]. (Opponents must pay [A].)')).toEqual({
      statics: [{ affects: 'FRIENDLY_GEAR', keywords: [{ name: 'Deflect' }] }],
      rest: '',
    });
    expect(parseStaticLines('[Assault]\nOther friendly units here have [Assault].')?.rest).toBe(
      '[Assault]',
    );
    expect(parseStaticLines('Your Mechs have [Deflect], [Ganking].')?.statics[0]).toEqual({
      affects: 'FRIENDLY_SUBTYPE',
      subtype: 'Mech',
      keywords: [{ name: 'Deflect' }, { name: 'Ganking' }],
    });
    expect(
      parseStaticLines('While you have another unit here, I have +1 [M].')?.statics[0],
    ).toMatchObject({
      affects: 'SELF',
      might: 1,
      when: { kind: 'COUNT' },
    });
    expect(
      parseStaticLines("I have [Shield 3] while I'm at a battlefield.")?.statics[0],
    ).toMatchObject({
      keywords: [{ name: 'Shield', value: 3 }],
    });
    expect(parseStaticLines('When you play me, draw 1.')).toBeNull();
  });
});
