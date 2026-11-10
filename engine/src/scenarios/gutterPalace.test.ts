import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities, parseCondition } from '../cardText.js';
import { evalCondition } from '../conditions.js';
import { runTurnTriggers } from '../turnTriggers.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const triggerText =
  'At the start of your Beginning Phase, if you have exactly 4 cards in hand and exactly 4 units at battlefields, you win the game.';
const parsed = parseCardAbilities(triggerText);
/** `fx-ember-totem` stands in for Gutter Palace. */
const cards: CardDatabase = {
  ...SCENARIO_CARDS,
  'fx-ember-totem': {
    ...(SCENARIO_CARDS['fx-ember-totem'] as CardDef),
    triggers: parsed?.triggers ?? [],
  },
};

describe('parser: counts of cards in hand and units at battlefields (Gutter Palace)', () => {
  it('reads "exactly N cards in hand" and "exactly N units at battlefields"', () => {
    // Tests Rule 583: a triggered ability can have a condition
    expect(parseCondition('you have exactly 4 cards in hand')).toEqual({
      kind: 'COUNT',
      what: 'card',
      where: 'hand',
      who: 'friendly',
      cmp: 'EQ',
      n: 4,
    });
    expect(parseCondition('you have exactly 4 units at battlefields')).toEqual({
      kind: 'COUNT',
      what: 'unit',
      where: 'battlefields',
      who: 'friendly',
      cmp: 'EQ',
      n: 4,
    });
  });

  it('reads both joined by "and" as one condition on the start-of-Beginning-Phase win', () => {
    // Tests Rule 583: a triggered ability can have a condition
    expect(parsed?.triggers[0]).toMatchObject({
      on: 'TURN_START',
      when: { kind: 'ALL', conds: [{ where: 'hand' }, { where: 'battlefields' }] },
      effects: [{ op: 'WIN_GAME' }],
    });
  });
});

describe('scenario: Gutter Palace wins the game at the start of the Beginning Phase', () => {
  /** p0 owns the Palace with `hand` cards in hand and `atBf` units at battlefields (more in the Base). */
  function wins(hand: number, atBf: number): boolean {
    const sc = Scenario.start({}, cards);
    sc.putUnit('p0', 'fx-ember-totem', 'base');
    const units = ['fx-grunt', 'fx-archer', 'fx-raider', 'fx-ash-tank'];
    for (let i = 0; i < atBf; i++) sc.putUnit('p0', units[i] as string, 'bf0');
    sc.putUnit('p0', 'fx-ganker', 'base'); // a unit in the Base never counts
    // Now make the hand exactly `hand` cards (the units above may have been taken from it).
    const ps = sc.state.players[0] as { hand: string[]; mainDeck: string[]; trash: string[] };
    while (ps.hand.length > hand) {
      const id = ps.hand.pop() as string;
      (sc.state.objects[id] as { zone: unknown }).zone = { kind: 'trash', player: 'p0' };
      ps.trash.push(id);
    }
    while (ps.hand.length < hand) {
      const id = ps.mainDeck.shift() as string;
      (sc.state.objects[id] as { zone: unknown }).zone = { kind: 'hand', player: 'p0' };
      ps.hand.push(id);
    }
    expect(ps.hand.length).toBe(hand);
    const r = runTurnTriggers(structuredClone(sc.state), cards, 'TURN_START');
    return r.state.gameStatus === 'FINISHED' && r.state.winner === 'p0';
  }

  it('needs exactly 4 cards in hand and exactly 4 units at battlefields', () => {
    // Tests Rule 583: the condition is checked as the ability triggers
    expect(wins(4, 4)).toBe(true);
    expect(wins(3, 4)).toBe(false);
    expect(wins(4, 3)).toBe(false);
  });

  it('counts only units at battlefields, in the Base or not', () => {
    // Tests Rule 583: the Base is not a battlefield
    const sc = Scenario.start({}, cards);
    const a = sc.putUnit('p0', 'fx-grunt', 'base');
    const cond = parseCondition('you have exactly 1 units at battlefields');
    expect(cond && evalCondition(sc.state, cards, cond, 'p0', a)).toBe(false);
    sc.putUnit('p0', 'fx-archer', 'bf0');
    expect(cond && evalCondition(sc.state, cards, cond, 'p0', a)).toBe(true);
  });
});
