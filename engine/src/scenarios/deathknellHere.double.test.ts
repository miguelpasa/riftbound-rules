import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseStaticLines } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const TEXT = 'Friendly [Deathknell] effects here trigger an additional time.';

function settle(sc: Scenario): void {
  for (let i = 0; i < 20 && sc.state.flow.chain.length > 0; i++) sc.pass(sc.state.flow.priority!);
}

describe('scenario: "Friendly [Deathknell] effects here trigger an additional time" (Detonation Amplifier)', () => {
  it('reads a here-scoped Deathknell doubling static', () => {
    // Tests Rule 604: static abilities
    expect(parseStaticLines(TEXT)?.statics[0]).toMatchObject({
      doubleDeathknell: true,
      deathknellHere: true,
    });
  });

  function run(diesAt: 'bf1' | 'base', withStatic = true): number {
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-blade': { ...(SCENARIO_CARDS['fx-blade'] as CardDef), keywords: [{ name: 'Deploy' }], statics: withStatic ? (parseStaticLines(TEXT)?.statics ?? []) : [] },
      'fx-grunt': {
        ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
        triggers: [{ on: 'DEATH', effects: [{ op: 'DRAW', amount: 1 }] }],
      },
      'fx-flare': {
        ...(SCENARIO_CARDS['fx-flare'] as CardDef),
        supportLevel: 'partial',
        effects: [{ op: 'KILL_TARGET' }],
      },
    };
    const sc = Scenario.start({}, cards);
    // The Amplifier is a [Deploy] gear: it sits at the battlefield.
    const amp = sc.putUnit('p0', 'fx-blade', 'base');
    sc.state.players[0]!.base = sc.state.players[0]!.base.filter((id) => id !== amp);
    (sc.state.objects[amp] as { zone: unknown }).zone = {
      kind: 'battlefield',
      player: 'p0',
      battlefieldId: 'bf1',
    };
    sc.setBattlefield('bf1', { controller: 'p0' });
    const unit = sc.putUnit('p0', 'fx-grunt', diesAt);
    const hand = sc.player('p0').hand.length;
    const spell = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', spell, { payment: sc.exhaustPlan('p0', 1), targets: [{ kind: 'object', id: unit }] });
    settle(sc);
    expect(sc.obj(unit).zone.kind).toBe('trash');
    return sc.player('p0').hand.length - hand; // cards drawn (the spell came and went)
  }

  it('doubles the Deathknell of a friendly unit dying at its battlefield only', () => {
    // Tests Rule 604: the static applies to Deathknells "here"
    expect(run('bf1', false)).toBe(1); // control: no static
    expect(run('bf1')).toBe(2);
    expect(run('base')).toBe(1);
  });
});
