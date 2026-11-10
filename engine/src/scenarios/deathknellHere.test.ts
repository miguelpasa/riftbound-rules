import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

function settle(sc: Scenario): void {
  for (let i = 0; i < 20 && sc.state.flow.chain.length > 0; i++) {
    sc.pass(sc.state.flow.priority as 'p0' | 'p1');
  }
}

describe('scenario: a Deathknell\'s "here" is where the unit died (Mournful Spirit)', () => {
  it('reads "[Deathknell][>] You may kill a unit or gear here."', () => {
    // Tests Rule 303: parsed trigger text
    const t = parseCardAbilities('[Deathknell][>] You may kill a unit or gear here.');
    expect(t?.triggers[0]).toMatchObject({ on: 'DEATH' });
    expect(JSON.stringify(t?.triggers[0]?.effects)).toContain('"here":true');
  });

  it('kills the unit at the battlefield where the source died, not elsewhere', () => {
    // Tests Rule 323.4: the source is in the Trash when its trigger resolves; "here" is where it died
    const fx = parseCardAbilities('[Deathknell][>] Kill a unit here.');
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), triggers: fx?.triggers ?? [] },
      'fx-flare': {
        ...(SCENARIO_CARDS['fx-flare'] as CardDef),
        supportLevel: 'partial',
        effects: [{ op: 'KILL_TARGET' }],
      },
    };
    const sc = Scenario.start({}, cards);
    const spirit = sc.putUnit('p0', 'fx-grunt', 'bf1');
    const near = sc.putUnit('p1', 'fx-tide-grunt', 'bf1');
    const far = sc.putUnit('p1', 'fx-order-tank', 'bf0');
    const spell = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', spell, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: spirit }],
    });
    sc.pass('p1');
    sc.pass('p0');
    settle(sc);
    expect(sc.obj(spirit).zone.kind).toBe('trash');
    expect(sc.obj(near).zone.kind).toBe('trash');
    expect(sc.obj(far).zone.kind).toBe('battlefield');
  });

  it('a source that died in a Base means that Base', () => {
    // Tests Rule 323.4: the location is read as the unit died
    const fx = parseCardAbilities('[Deathknell][>] Kill a unit here.');
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), triggers: fx?.triggers ?? [] },
      'fx-flare': {
        ...(SCENARIO_CARDS['fx-flare'] as CardDef),
        supportLevel: 'partial',
        effects: [{ op: 'KILL_TARGET' }],
      },
    };
    const sc = Scenario.start({}, cards);
    const spirit = sc.putUnit('p0', 'fx-grunt', 'base');
    const home = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const away = sc.putUnit('p1', 'fx-tide-grunt', 'bf1');
    const spell = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', spell, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: spirit }],
    });
    sc.pass('p1');
    sc.pass('p0');
    settle(sc);
    expect(sc.obj(spirit).zone.kind).toBe('trash');
    expect(sc.obj(away).zone.kind).toBe('battlefield'); // not in that Base
    expect(sc.obj(home).zone.kind).toBe('trash'); // the only unit in that Base
  });
});
