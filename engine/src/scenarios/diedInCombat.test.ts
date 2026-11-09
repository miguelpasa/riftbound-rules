import { describe, it, expect } from 'vitest';
import { Scenario, SCENARIO_CARDS } from '../testing/scenario.js';
import { TOKEN_CARDS } from '../tokens.js';
import { fireTriggers } from '../triggers.js';
import { runEffects } from '../effects.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef, CardInstance, GameEvent } from '../types/index.js';

const cards: CardDatabase = {
  ...TOKEN_CARDS,
  ...SCENARIO_CARDS,
  'fx-grunt': {
    ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
    triggers: [
      {
        on: 'DEATH',
        inCombat: true,
        effects: [{ op: 'GAIN_POINT', amount: 1, forOpponent: true }],
      },
    ],
  },
};

function killed(inCombat: boolean): number {
  const sc = Scenario.start({}, cards);
  const g = sc.putUnit('p0', 'fx-grunt', 'base');
  const s = structuredClone(sc.state);
  const o = s.objects[g] as CardInstance;
  s.players[0].base = s.players[0].base.filter((x) => x !== g);
  s.players[0].trash.push(g);
  o.zone = { kind: 'trash', player: 'p0' };
  const ev = {
    seq: 1,
    type: 'UNIT_KILLED',
    unitId: g,
    controller: 'p0',
    cardId: 'fx-grunt',
    at: 'bf0',
    alone: true,
    ...(inCombat ? { inCombat: true } : {}),
  } as GameEvent;
  const t = fireTriggers(s, cards, [ev]);
  sc.state = t.state;
  for (let k = 0; k < 6 && sc.state.flow.chain.length > 0; k++) {
    sc.pass(sc.state.flow.priority as 'p0' | 'p1');
  }
  return sc.player('p1').points;
}

describe('scenario: "When I die in combat" and "They score N point" (Draven)', () => {
  it('scores a point for the opponent only when the unit died in combat', () => {
    // Tests Rule 598: death trigger conditioned on combat
    expect(killed(true)).toBe(1);
    expect(killed(false)).toBe(0);
  });

  it('the point goes to the opponent of the controller', () => {
    // Tests Rule 160: "They score 1 point" after "choose an opponent"
    const sc = Scenario.start();
    const s = structuredClone(sc.state);
    runEffects(s, 'p0', [{ op: 'GAIN_POINT', amount: 1, forOpponent: true }], sc.cards);
    expect(s.players[1].points).toBe(1);
    expect(s.players[0].points).toBe(0);
  });

  it('parses Draven', () => {
    // Tests Rule 598: parsed text
    expect(
      parseCardAbilities('When I die in combat, choose an opponent. They score 1 point.')
        ?.triggers[0],
    ).toMatchObject({ on: 'DEATH', inCombat: true });
  });
});
