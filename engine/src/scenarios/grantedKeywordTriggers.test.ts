import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseStaticLines } from '../cardText.js';
import { effectiveMight } from '../combat.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const toBf = (id: string) => ({ kind: 'battlefield' as const, battlefieldId: id });
const mightOf = (sc: Scenario, id: string): number =>
  effectiveMight(sc.state, sc.cards, id, { role: null });

function db(line: string): CardDatabase {
  const st = parseStaticLines(line);
  return {
    ...SCENARIO_CARDS,
    'fx-ash-tank': { ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef), statics: st?.statics ?? [] },
    'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), subtypes: ['Mech'] },
  };
}

describe('scenario: "Your Mechs have [Disarm] / [Vision]" (Clanging Sentry, Forecaster)', () => {
  it('reads the grants as keyword statics', () => {
    // Tests Rule 604: static abilities grant keywords
    expect(parseStaticLines('Your Mechs have [Disarm].')?.statics[0]).toMatchObject({
      affects: 'FRIENDLY_SUBTYPE',
      subtype: 'Mech',
      keywords: [{ name: 'Disarm' }],
    });
    expect(parseStaticLines('Your Mechs have [Vision].')?.statics[0]?.keywords).toEqual([
      { name: 'Vision' },
    ]);
  });

  it('a granted [Disarm] gives an enemy unit there -1 [M] when the Mech attacks', () => {
    // Tests Rule 831: Disarm = "When I attack, give an enemy unit here -1 [M] this turn"
    const sc = Scenario.start({}, db('Your Mechs have [Disarm].'));
    sc.putUnit('p0', 'fx-ash-tank', 'base'); // the Clanging Sentry
    const foe = sc.putUnit('p1', 'fx-order-tank', 'bf1', { control: true });
    const mech = sc.putUnit('p0', 'fx-grunt', 'base');
    const before = mightOf(sc, foe);
    sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [mech], destination: toBf('bf1') });
    for (let i = 0; i < 4 && sc.state.flow.chain.length > 0; i++) sc.pass(sc.state.flow.priority!);
    expect(mightOf(sc, foe)).toBe(before - 1);
  });

  it('without the granting unit, or for a non-Mech, nothing happens', () => {
    // Tests Rule 604: a static applies only while its source is on the board, to the units it names
    const sc = Scenario.start({}, db('Your Mechs have [Disarm].'));
    const foe = sc.putUnit('p1', 'fx-order-tank', 'bf1', { control: true });
    const mech = sc.putUnit('p0', 'fx-grunt', 'base');
    const before = mightOf(sc, foe);
    sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [mech], destination: toBf('bf1') });
    for (let i = 0; i < 4 && sc.state.flow.chain.length > 0; i++) sc.pass(sc.state.flow.priority!);
    expect(mightOf(sc, foe)).toBe(before);
  });

  it('a granted [Vision] triggers when a Mech is played', () => {
    // Tests Rule 55: Vision = "When you play me, look at the top card of your Main Deck"
    const sc = Scenario.start({}, db('Your Mechs have [Vision].'));
    sc.putUnit('p0', 'fx-ash-tank', 'base'); // the Forecaster
    const mech = sc.putInHand('p0', 'fx-grunt');
    sc.giveRunes('p0', 3);
    sc.play('p0', mech, { payment: sc.exhaustPlan('p0', 3), location: { kind: 'base' } });
    const trig = sc.state.flow.chain.find((i) => i.triggered);
    expect(trig?.sourceObjectId).toBe(mech);
  });
});
