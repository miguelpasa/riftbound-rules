import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const TEXT = 'When you [Stun] an enemy unit at a battlefield, you may move me to that battlefield.';

describe('scenario: "When you [Stun] an enemy unit at a battlefield, you may move me to that battlefield" (Vex)', () => {
  it('reads a stun trigger that moves the source to the stunned unit’s battlefield', () => {
    // Tests Rule 303: a triggered ability fires on its event
    const t = parseCardAbilities(TEXT)?.triggers[0];
    expect(t).toMatchObject({ on: 'YOU_STUN_ENEMY', optional: {} });
    expect(t?.effects).toEqual([{ op: 'MOVE_SELF_TO_TARGET', side: 'enemy', atBattlefield: true }]);
  });

  function run(accept: boolean): { vex: string; sc: Scenario } {
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-ash-tank': {
        ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef),
        triggers: parseCardAbilities(TEXT)?.triggers ?? [],
      },
      'fx-flare': {
        ...(SCENARIO_CARDS['fx-flare'] as CardDef),
        supportLevel: 'partial',
        effects: [{ op: 'STUN_TARGET', side: 'enemy' }],
      },
    };
    const sc = Scenario.start({}, cards);
    const vex = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const foe = sc.putUnit('p1', 'fx-tide-grunt', 'bf1', { control: true });
    const spell = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', spell, { payment: sc.exhaustPlan('p0', 1), targets: [{ kind: 'object', id: foe }] });
    for (let i = 0; i < 10 && sc.state.flow.pendingChoice?.kind !== 'OPTIONAL_EFFECT'; i++) {
      if (sc.state.flow.chain.length === 0) break;
      sc.pass(sc.state.flow.priority!);
    }
    const pc = sc.state.flow.pendingChoice;
    expect(pc?.kind).toBe('OPTIONAL_EFFECT');
    if (pc?.kind === 'OPTIONAL_EFFECT') {
      sc.do({ type: 'DECIDE_OPTIONAL', playerId: 'p0', chainItemId: pc.chainItemId, accept });
    }
    return { vex, sc };
  }

  it('moves Vex to that battlefield when accepted, and leaves it put when declined', () => {
    // Tests Rule 303: a "you may" ability acts only on accept
    const a = run(true);
    expect(a.sc.obj(a.vex).zone).toMatchObject({ kind: 'battlefield', battlefieldId: 'bf1' });
    const b = run(false);
    expect(b.sc.obj(b.vex).zone.kind).toBe('base');
  });
});
