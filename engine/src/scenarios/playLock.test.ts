import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { getLegalActions } from '../legalActions.js';
import { parseCardAbilities, parseSpellText } from '../cardText.js';
import type { CardDatabase, CardDef, CardEffect } from '../types/index.js';

const withGrunt = (effect: CardEffect): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-grunt': {
    ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
    triggers: [{ on: 'PLAY', effects: [effect] }],
  },
});

describe('scenario: "can\'t play cards this turn" (R83)', () => {
  it('locks the opponent out of playing cards for the rest of this turn only', () => {
    // Tests Rule 354: playing a card is an action a rule can forbid
    const sc = Scenario.start({}, withGrunt({ op: 'LOCK_PLAYS', who: 'OPPONENTS', what: 'CARDS' }));
    sc.giveRunes('p1', 2);
    const reaction = sc.putInHand('p1', 'fx-tide-guard');
    const unit = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', unit, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    expect(sc.state.players[1]?.playLock).toBeUndefined(); // the trigger has not resolved yet
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.state.players[1]?.playLock).toMatchObject({ what: 'CARDS' });
    expect(
      getLegalActions(sc.state, sc.cards, 'p1').filter(
        (i) => i.type === 'PLAY_CARD' && i.cardInstanceId === reaction,
      ),
    ).toHaveLength(0);
    // The lock ends with the turn: a later turn of p1 plays cards again.
    sc.endTurn('p0');
    expect(sc.state.players[1]?.playLock?.turn).not.toBe(sc.state.turn.number);
    sc.verify();
  });

  it('a spells-only lock still lets units be played', () => {
    // Tests Rule 354: only the forbidden kind is blocked
    const sc = Scenario.start({}, SCENARIO_CARDS);
    sc.giveRunes('p0', 4);
    (sc.state.players[0] as (typeof sc.state.players)[number]).playLock = {
      turn: sc.state.turn.number,
      what: 'SPELLS',
    };
    const spell = sc.putInHand('p0', 'fx-flare');
    const unit = sc.putInHand('p0', 'fx-grunt');
    const legal = getLegalActions(sc.state, sc.cards, 'p0');
    expect(legal.some((i) => i.type === 'PLAY_CARD' && i.cardInstanceId === spell)).toBe(false);
    expect(legal.some((i) => i.type === 'PLAY_CARD' && i.cardInstanceId === unit)).toBe(true);
  });
});

describe('scenario: negative group buff with a minimum (R83)', () => {
  it('never takes a unit below the minimum Might', () => {
    // Tests Rule 143.2: Might modifiers; the minimum is part of the effect
    const sc = Scenario.start(
      {},
      withGrunt({ op: 'BUFF_ALL', amount: -3, side: 'enemy', duration: 'TURN', minMight: 1 }),
    );
    const big = sc.putUnit('p1', 'fx-order-titan', 'base');
    const small = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const bigBefore = effectiveMight(sc.state, sc.cards, big, { role: null });
    const smallBefore = effectiveMight(sc.state, sc.cards, small, { role: null });
    const unit = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', unit, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    sc.pass('p1');
    sc.pass('p0');
    expect(effectiveMight(sc.state, sc.cards, big, { role: null })).toBe(bigBefore - 3);
    expect(effectiveMight(sc.state, sc.cards, small, { role: null })).toBe(
      Math.min(smallBefore, Math.max(1, smallBefore - 3)),
    );
    expect(effectiveMight(sc.state, sc.cards, small, { role: null })).toBeGreaterThanOrEqual(1);
  });
});

describe('parser: play locks and minimum debuffs (R83)', () => {
  it('reads the phrases', () => {
    // Tests Rule 354: parsed text
    expect(
      parseCardAbilities("When you play me, opponents can't play cards this turn.")?.triggers[0]
        ?.effects,
    ).toEqual([{ op: 'LOCK_PLAYS', who: 'OPPONENTS', what: 'CARDS' }]);
    expect(parseSpellText("Counter a spell. Its controller can't play spells this turn.")).toEqual([
      { op: 'COUNTER_SPELL' },
      { op: 'LOCK_PLAYS', who: 'TARGET_CONTROLLER', what: 'SPELLS' },
    ]);
    expect(
      parseCardAbilities(
        'When you play me, give enemy units -3 [M] this turn, to a minimum of 1 [M].',
      )?.triggers[0]?.effects,
    ).toEqual([{ op: 'BUFF_ALL', amount: -3, side: 'enemy', duration: 'TURN', minMight: 1 }]);
  });
});

describe('scenario: counter and lock its controller (R83)', () => {
  it("the countered spell's controller cannot play spells for the rest of the turn", () => {
    // Tests Rule 359.3: the effects of the countering spell happen in order
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-flare': {
        ...(SCENARIO_CARDS['fx-flare'] as CardDef),
        supportLevel: 'partial',
        effects: [{ op: 'DAMAGE_TARGET', amount: 1 }],
      },
      'fx-tide-guard': {
        ...(SCENARIO_CARDS['fx-tide-guard'] as CardDef),
        supportLevel: 'partial',
        effects: [
          { op: 'COUNTER_SPELL' },
          { op: 'LOCK_PLAYS', who: 'TARGET_CONTROLLER', what: 'SPELLS' },
        ],
      },
    };
    const sc = Scenario.start({}, cards);
    const victim = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    sc.giveRunes('p1', 2);
    const guard = sc.putInHand('p1', 'fx-tide-guard');
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', flare, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: victim }],
    });
    sc.play('p1', guard, {
      payment: sc.exhaustPlan('p1', 1),
      targets: [{ kind: 'object', id: flare }],
    });
    sc.pass('p0');
    sc.pass('p1');
    expect(sc.obj(flare).zone.kind).toBe('trash');
    expect(sc.state.players[0]?.playLock).toMatchObject({ what: 'SPELLS' });
    expect(sc.state.players[1]?.playLock).toBeUndefined();
  });
});
