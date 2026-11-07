import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { TOKEN_CARDS } from '../tokens.js';
import { effectiveMight } from '../combat.js';
import { parseCardAbilities, parseSpellText } from '../cardText.js';
import type { CardDatabase, CardDef, CardEffect } from '../types/index.js';

const withGruntTrigger = (effect: CardEffect): CardDatabase => ({
  ...TOKEN_CARDS,
  ...SCENARIO_CARDS,
  'fx-grunt': {
    ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
    triggers: [{ on: 'PLAY', effects: [effect] }],
  },
});

/** Play the grunt (hand size is read after it is in hand), choose `target` when asked, and settle the Chain. */
function playGrunt(sc: Scenario, target?: string): void {
  const g = sc.putInHand('p0', 'fx-grunt');
  sc.play('p0', g, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
  const pc = sc.state.flow.pendingChoice;
  if (pc?.kind === 'TRIGGER_TARGET' && target) {
    sc.do({
      type: 'CHOOSE_TRIGGER_TARGET',
      playerId: 'p0',
      chainItemId: pc.chainItemId,
      targets: [{ kind: 'object', id: target }],
    });
  }
  for (let k = 0; k < 6 && sc.state.flow.chain.length > 0; k++) {
    sc.pass(sc.state.flow.priority as 'p0' | 'p1');
  }
}

describe('scenario: effects that involve the opponent (R97)', () => {
  it('"each player draws" draws for both players', () => {
    // Tests Rule 160: both players draw
    const sc = Scenario.start({}, withGruntTrigger({ op: 'DRAW', amount: 1, eachPlayer: true }));
    const g0 = sc.putInHand('p0', 'fx-grunt');
    const mine = sc.player('p0').hand.length;
    const theirs = sc.player('p1').hand.length;
    sc.play('p0', g0, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.player('p0').hand.length).toBe(mine - 1 + 1); // played the unit, drew one
    expect(sc.player('p1').hand.length).toBe(theirs + 1);
  });

  it('the opponent plays a token of their own', () => {
    // Tests Rule 186: the token enters under the opponent's control
    const sc = Scenario.start(
      {},
      withGruntTrigger({ op: 'PLAY_TOKEN', token: 'tok-bird', count: 1, forOpponent: true }),
    );
    playGrunt(sc);
    const bird = Object.values(sc.state.objects).find((o) => o.cardId === 'tok-bird');
    expect(bird?.controller).toBe('p1');
  });

  it('"base Might becomes N this turn" replaces the printed Might, keeping other bonuses, until end of turn', () => {
    // Tests Rule 143.2: base Might changes
    const sc = Scenario.start({}, withGruntTrigger({ op: 'SET_BASE_MIGHT', amount: 5 }));
    const mate = sc.putUnit('p0', 'fx-ash-tank', 'base');
    sc.setMightBonus(mate, 1);
    const printed = SCENARIO_CARDS['fx-ash-tank']?.stats.might ?? 0;
    playGrunt(sc, mate);
    expect(effectiveMight(sc.state, sc.cards, mate, { role: null })).toBe(5 + 1);
    expect(printed).not.toBe(5);
    sc.endTurn('p0');
    expect(effectiveMight(sc.state, sc.cards, mate, { role: null })).toBe(printed + 1);
  });
});

describe('parser: opponent choices (R97)', () => {
  it('ignores "choose an opponent" and reads the follow-ups', () => {
    // Tests Rule 160: parsed text
    expect(
      parseCardAbilities('When you play me, choose an opponent. You and that player each draw 1.')
        ?.triggers[0]?.effects,
    ).toEqual([{ op: 'DRAW', amount: 1, eachPlayer: true }]);
    expect(
      parseCardAbilities(
        'When you play me, choose an opponent. They play a 1 [M] Bird unit token with [Deflect].',
      )?.triggers[0]?.effects,
    ).toEqual([{ op: 'PLAY_TOKEN', token: 'tok-bird', count: 1, forOpponent: true }]);
    expect(parseSpellText('Choose a unit. Its base Might becomes 5 this turn.')).toEqual([
      { op: 'SET_BASE_MIGHT', amount: 5 },
    ]);
  });
});
