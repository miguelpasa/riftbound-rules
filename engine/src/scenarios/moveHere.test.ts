import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef, CardTrigger } from '../types/index.js';

const withTrigger = (t: CardTrigger): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), triggers: [t] },
});

describe("scenario: move a unit to the source's battlefield (R79)", () => {
  it('moves the chosen enemy unit to the battlefield of the source and starts a Combat there', () => {
    // Tests Rule 462: units of both players at a battlefield fight
    const sc = Scenario.start(
      {},
      withTrigger({ on: 'PLAY', effects: [{ op: 'MOVE_HERE_TARGET', side: 'enemy' }] }),
    );
    sc.putUnit('p0', 'fx-ash-tank', 'bf1', { control: true });
    const enemy = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const grunt = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', grunt, {
      payment: sc.exhaustPlan('p0', 2),
      location: { kind: 'battlefield', battlefieldId: 'bf1' },
    });
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.obj(enemy).zone).toMatchObject({ kind: 'battlefield', battlefieldId: 'bf1' });
    expect(sc.state.flow.combat?.battlefieldId ?? sc.state.flow.showdown?.battlefieldId).toBe(
      'bf1',
    );
    expect(
      sc.events.some((e) => e.type === 'UNIT_MOVED' && e.unitId === enemy && e.to === 'bf1'),
    ).toBe(true);
    sc.verify();
  });

  it('fizzles when the source is not at a battlefield', () => {
    // Tests Rule 355.10: "here" needs a location
    const sc = Scenario.start(
      {},
      withTrigger({ on: 'PLAY', effects: [{ op: 'MOVE_HERE_TARGET', side: 'enemy' }] }),
    );
    const enemy = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const grunt = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', grunt, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.obj(enemy).zone.kind).toBe('base');
  });
});

describe('parser: move to here (R79)', () => {
  it('reads the destination phrases and the optional form', () => {
    // Tests Rule 303: parsed effect text
    const t = (s: string) => parseCardAbilities(s)?.triggers[0]?.effects;
    expect(
      t('When I move to a battlefield, you may move an enemy unit to that battlefield.'),
    ).toEqual([{ op: 'MOVE_HERE_TARGET', side: 'enemy', count: { min: 0, max: 1 } }]);
    expect(t('When I attack, move a unit you control to my battlefield.')).toEqual([
      { op: 'MOVE_HERE_TARGET', side: 'friendly' },
    ]);
  });
});
