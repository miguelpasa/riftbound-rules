import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { actorToAct } from '../reducer.js';
import { getLegalActions } from '../legalActions.js';
import { parseModalSpell } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

/** fx-flare (1 Energy spell): mode 0 draws 1, mode 1 draws 2. */
const cards: CardDatabase = {
  ...SCENARIO_CARDS,
  'fx-flare': {
    ...(SCENARIO_CARDS['fx-flare'] as CardDef),
    modes: [[{ op: 'DRAW', amount: 1 }], [{ op: 'DRAW', amount: 2 }]],
  },
};

function cast(mode: number): number {
  const sc = Scenario.start({}, cards);
  const spell = sc.putInHand('p0', 'fx-flare');
  const before = sc.player('p0').hand.length - 1; // the spell leaves the hand
  sc.play('p0', spell, { payment: sc.exhaustPlan('p0', 1), mode } as never);
  for (let i = 0; i < 4 && sc.state.flow.chain.length > 0; i++) sc.pass(actorToAct(sc.state));
  sc.verify();
  return sc.player('p0').hand.length - before;
}

describe('scenario: modal spells (R59)', () => {
  it('runs only the chosen mode', () => {
    // Tests Rule 359: a spell resolves its effects; a modal spell only those of its chosen mode
    expect(cast(0)).toBe(1);
    expect(cast(1)).toBe(2);
  });

  it('needs a valid mode, is offered once per mode, and other cards take none', () => {
    // Tests Rule 356: choices are made as the card is played
    const sc = Scenario.start({}, cards);
    const spell = sc.putInHand('p0', 'fx-flare');
    const base = {
      type: 'PLAY_CARD' as const,
      playerId: 'p0' as const,
      cardInstanceId: spell,
      payment: sc.exhaustPlan('p0', 1),
    };
    expect(sc.reject(base).code).toBe('MISSING_TARGET');
    sc.reject({ ...base, mode: 5 });
    const legal = getLegalActions(sc.state, sc.cards, 'p0').filter(
      (i) => i.type === 'PLAY_CARD' && i.cardInstanceId === spell,
    );
    expect(legal.map((i) => (i.type === 'PLAY_CARD' ? i.mode : null)).sort()).toEqual([0, 1]);
    const plain = Scenario.start();
    const s2 = plain.putInHand('p0', 'fx-flare');
    plain.reject({
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: s2,
      payment: plain.exhaustPlan('p0', 1),
      mode: 0,
    });
  });
});

describe('parser: modal spells', () => {
  it('reads "Choose one —" with dash lines, ignoring keyword lines and reminders', () => {
    // Tests Rule 359: parsed text
    expect(
      parseModalSpell(
        '[Action] (Play on your turn.)\nChoose one —\n- Draw 1.\n- Give a unit +2 [M] this turn.',
      ),
    ).toEqual([[{ op: 'DRAW', amount: 1 }], [{ op: 'BUFF_TARGET', amount: 2, duration: 'TURN' }]]);
    expect(parseModalSpell('Choose one —\n- Draw 1.')).toBeNull();
    expect(parseModalSpell('Choose one —\n- Draw 1.\n- Sing a song.')).toBeNull();
    expect(parseModalSpell('Draw 1.')).toBeNull();
  });
});
