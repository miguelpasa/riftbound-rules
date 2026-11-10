import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities, parseCondition } from '../cardText.js';
import { effectiveMight } from '../combat.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const TEXT = 'When I conquer a battlefield that was uncontrolled, draw 1.';
const toBf = (id: string) => ({ kind: 'battlefield' as const, battlefieldId: id });

describe('scenario: "When I conquer a battlefield that was uncontrolled" (Yone)', () => {
  it('reads a CONQUER trigger gated on the battlefield having been uncontrolled', () => {
    // Tests Rule 473: Conquer scores a battlefield you gained control of
    expect(parseCondition('the battlefield was uncontrolled')).toEqual({
      kind: 'WAS_UNCONTROLLED',
    });
    expect(parseCardAbilities(TEXT)?.triggers[0]).toMatchObject({
      on: 'CONQUER',
      when: { kind: 'WAS_UNCONTROLLED' },
    });
  });

  it('fires when the battlefield had no controller, not when it was an opponent’s', () => {
    // Tests Rule 473: the previous controller is read as control is established
    const fx = parseCardAbilities(TEXT);
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-titan': { ...(SCENARIO_CARDS['fx-titan'] as CardDef), triggers: fx?.triggers ?? [] },
    };
    const conquer = (opponentHeld: boolean): number => {
      const sc = Scenario.start({}, cards);
      const mine = sc.putUnit('p0', 'fx-titan', 'base');
      let foe: string | undefined;
      if (opponentHeld) foe = sc.putUnit('p1', 'fx-tide-grunt', 'bf1', { control: true });
      const hand = sc.player('p0').hand.length;
      sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [mine], destination: toBf('bf1') });
      if (foe) {
        sc.pass('p0');
        sc.pass('p1');
        const mine0 = effectiveMight(sc.state, sc.cards, mine, { role: 'ATTACKER' });
        sc.do({
          type: 'ASSIGN_COMBAT_DAMAGE',
          playerId: 'p0',
          assignments: [{ unitId: foe, amount: mine0 }],
        });
        if (sc.state.flow.combat?.awaitingAssignmentFrom === 'p1') {
          const theirs = effectiveMight(sc.state, sc.cards, foe, { role: 'DEFENDER' });
          sc.do({
            type: 'ASSIGN_COMBAT_DAMAGE',
            playerId: 'p1',
            assignments: [{ unitId: mine, amount: theirs }],
          });
        }
      }
      for (let i = 0; i < 12 && (sc.state.flow.chain.length > 0 || sc.state.flow.showdown); i++) {
        sc.pass(sc.state.flow.priority!);
      }
      expect(sc.state.battlefields.find((b) => b.id === 'bf1')?.controller).toBe('p0');
      return sc.player('p0').hand.length - hand;
    };
    expect(conquer(false)).toBe(1);
    expect(conquer(true)).toBe(0);
  });
});
