import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { evalCondition } from '../conditions.js';
import { parseCardAbilities, parseSelfCostReduction } from '../cardText.js';
import type { CardDatabase, CardDef, Condition } from '../types/index.js';

const withCards = (patch: Record<string, Partial<CardDef>>): CardDatabase => {
  const out: CardDatabase = { ...SCENARIO_CARDS };
  for (const [id, p] of Object.entries(patch)) {
    out[id] = { ...(SCENARIO_CARDS[id] as CardDef), ...p };
  }
  return out;
};

describe('conditions: played to a battlefield, Empowered, stunned, name in Trash (R73)', () => {
  const holds = (sc: Scenario, cond: Condition, src: string, who: 'p0' | 'p1' = 'p0') =>
    evalCondition(sc.state, sc.cards, cond, who, src);

  it('"you\'ve played a unit or gear to a battlefield this turn"', () => {
    // Tests Rule 359.2: a played permanent that stands at a battlefield counts
    const sc = Scenario.start();
    const src = sc.putUnit('p0', 'fx-grunt', 'base');
    const atBf = sc.putUnit('p0', 'fx-ash-tank', 'bf1');
    expect(holds(sc, { kind: 'PLAYED_TO_BATTLEFIELD' }, src)).toBe(false);
    const ps = sc.state.players[0] as (typeof sc.state.players)[number];
    ps.playedThisTurn = { turn: sc.state.turn.number, objectIds: [src] };
    expect(holds(sc, { kind: 'PLAYED_TO_BATTLEFIELD' }, src)).toBe(false); // played to the Base
    ps.playedThisTurn = { turn: sc.state.turn.number, objectIds: [src, atBf] };
    expect(holds(sc, { kind: 'PLAYED_TO_BATTLEFIELD' }, src)).toBe(true);
    ps.playedThisTurn = { turn: sc.state.turn.number - 1, objectIds: [atBf] };
    expect(holds(sc, { kind: 'PLAYED_TO_BATTLEFIELD' }, src)).toBe(false); // an earlier turn
  });

  it('"you control something that\'s [Empowered]"', () => {
    // Tests Rule 359.2: Empowered permanents on the board
    const sc = Scenario.start();
    const src = sc.putUnit('p0', 'fx-grunt', 'base');
    const other = sc.putUnit('p0', 'fx-ash-tank', 'base');
    expect(holds(sc, { kind: 'CONTROLS_EMPOWERED' }, src)).toBe(false);
    sc.obj(other).empowered = true;
    expect(holds(sc, { kind: 'CONTROLS_EMPOWERED' }, src)).toBe(true);
    expect(holds(sc, { kind: 'CONTROLS_EMPOWERED' }, src, 'p1')).toBe(false);
  });

  it('"an opponent controls a stunned unit"', () => {
    // Tests Rule 359.2: Stunned units on the opponent's side
    const sc = Scenario.start();
    const src = sc.putUnit('p0', 'fx-grunt', 'base');
    const enemy = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    expect(holds(sc, { kind: 'ENEMY_STUNNED' }, src)).toBe(false);
    sc.obj(enemy).stunned = true;
    expect(holds(sc, { kind: 'ENEMY_STUNNED' }, src)).toBe(true);
    expect(holds(sc, { kind: 'ENEMY_STUNNED' }, src, 'p1')).toBe(false);
  });

  it('"a card with my name in your trash"', () => {
    // Tests Rule 359.2: Trash contents by card name
    const sc = Scenario.start();
    const src = sc.putUnit('p0', 'fx-grunt', 'base');
    const copy = sc.putUnit('p0', 'fx-grunt', 'base');
    expect(holds(sc, { kind: 'NAME_IN_TRASH' }, src)).toBe(false);
    const ps = sc.state.players[0] as (typeof sc.state.players)[number];
    ps.trash.push(copy);
    sc.obj(copy).zone = { kind: 'trash', player: 'p0' };
    expect(holds(sc, { kind: 'NAME_IN_TRASH' }, src)).toBe(true);
  });
});

describe('scenario: Level gates "I enter ready" (R73)', () => {
  const unit = (xp: number) => {
    const sc = Scenario.start(
      {},
      withCards({ 'fx-grunt': { entersReadyWhen: { kind: 'XP', n: 3 } } }),
    );
    (sc.state.players[0] as (typeof sc.state.players)[number]).xp = xp;
    const id = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', id, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    return sc.obj(id).ready;
  };

  it('enters ready only with enough XP', () => {
    // Tests Rule 359.2: a permanent enters exhausted unless an effect says otherwise
    expect(unit(3)).toBe(true);
    expect(unit(2)).toBe(false);
  });
});

describe('parser: Level, self discounts with "enter ready" (R73)', () => {
  it('reads Level-gated enters-ready and triggers', () => {
    // Tests Rule 359.2: parsed ability text
    expect(parseCardAbilities('[Level 3][>] I enter ready.')?.entersReadyWhen).toEqual({
      kind: 'XP',
      n: 3,
    });
    expect(parseCardAbilities('[Level 6][>] When you play me, draw 1.')?.triggers[0]).toMatchObject(
      {
        on: 'PLAY',
        when: { kind: 'XP', n: 6 },
      },
    );
  });

  it('splits "If <condition>, I cost [N] less and enter ready"', () => {
    // Tests Rule 359.2: parsed discount text
    const r = parseSelfCostReduction(
      'If an opponent controls a stunned unit, I cost [2] less and enter ready.',
    );
    expect(r?.reduction).toEqual({ energy: 2, when: { kind: 'ENEMY_STUNNED' } });
    expect(r?.rest).toBe('I enter ready if an opponent controls a stunned unit');
    expect(parseCardAbilities(r?.rest ?? '')?.entersReadyWhen).toEqual({ kind: 'ENEMY_STUNNED' });
  });

  it('reads the new condition phrases', () => {
    // Tests Rule 359.2: parsed condition text
    expect(
      parseSelfCostReduction(
        "This costs [2] less if you've played a unit or gear to a battlefield this turn.",
      )?.reduction.when,
    ).toEqual({ kind: 'PLAYED_TO_BATTLEFIELD' });
    expect(
      parseSelfCostReduction("This costs [2] less if you control something that's [Empowered].")
        ?.reduction.when,
    ).toEqual({ kind: 'CONTROLS_EMPOWERED' });
    expect(
      parseCardAbilities('I enter ready if you have a card with my name in your trash.')
        ?.entersReadyWhen,
    ).toEqual({
      kind: 'NAME_IN_TRASH',
    });
  });
});
