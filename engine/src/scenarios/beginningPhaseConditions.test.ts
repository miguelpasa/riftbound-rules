import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities, parseCondition } from '../cardText.js';
import { evalCondition, recordDeath } from '../conditions.js';
import type { CardDatabase, CardDef } from '../types/index.js';

describe('scenario: "If a friendly unit died during your Beginning Phase this turn, I enter ready" (Shadow Watcher)', () => {
  const TEXT = 'If a friendly unit died during your Beginning Phase this turn, I enter ready.';

  it('reads the condition onto "enters ready"', () => {
    // Tests Rule 316: the Beginning Phase
    expect(parseCondition('a friendly unit died during your Beginning Phase this turn')).toEqual({
      kind: 'DIED_THIS_TURN',
      who: 'friendly',
      duringBeginning: true,
    });
    expect(parseCardAbilities(TEXT)?.entersReadyWhen).toMatchObject({ duringBeginning: true });
  });

  it('counts only deaths recorded while it was the controller’s Beginning Phase', () => {
    // Tests Rule 316: the phase of the death is what counts
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-grunt': {
        ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
        entersReadyWhen: parseCardAbilities(TEXT)?.entersReadyWhen,
      },
    };
    const sc = Scenario.start({}, cards);
    const cond = parseCondition('a friendly unit died during your Beginning Phase this turn');
    if (!cond) throw new Error('no condition');
    const holds = (): boolean => evalCondition(sc.state, sc.cards, cond, 'p0', 'x');
    expect(holds()).toBe(false);
    sc.state.turn.phase = 'MAIN';
    sc.state.turn.activePlayer = 'p0';
    recordDeath(sc.state, sc.cards, 'p0');
    expect(holds()).toBe(false); // a death in the Main Phase is not a Beginning Phase death
    sc.state.turn.phase = 'BEGINNING';
    recordDeath(sc.state, sc.cards, 'p0');
    expect(holds()).toBe(true);
  });
});

describe('scenario: "If it\'s your Beginning Phase" (LeBlanc)', () => {
  it('reads the condition and holds only in the controller’s own Beginning Phase', () => {
    // Tests Rule 316: the Beginning Phase
    const cond = parseCondition("it's your Beginning Phase");
    expect(cond).toEqual({ kind: 'YOUR_BEGINNING_PHASE' });
    const sc = Scenario.start({}, SCENARIO_CARDS);
    sc.state.turn.activePlayer = 'p0';
    sc.state.turn.phase = 'BEGINNING';
    expect(evalCondition(sc.state, sc.cards, cond!, 'p0', 'x')).toBe(true);
    expect(evalCondition(sc.state, sc.cards, cond!, 'p1', 'x')).toBe(false);
    sc.state.turn.phase = 'MAIN';
    expect(evalCondition(sc.state, sc.cards, cond!, 'p0', 'x')).toBe(false);
  });

  it('reads "[Deathknell] Draw 1. If it’s your Beginning Phase, draw 2 instead."', () => {
    // Tests Rule 303: Deathknell effects, with an alternative
    const t = parseCardAbilities("[Deathknell][>] Draw 1. If it's your Beginning Phase, draw 2 instead.")
      ?.triggers[0];
    expect(t?.on).toBe('DEATH');
    expect(t?.effects).toHaveLength(2);
  });
});
