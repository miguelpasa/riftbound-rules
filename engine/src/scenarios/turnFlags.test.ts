import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCondition, parseStaticLines } from '../cardText.js';
import { evalCondition } from '../conditions.js';
import type { CardDatabase, CardDef, CardEffect, Condition } from '../types/index.js';

const base = (id: string): CardDef => SCENARIO_CARDS[id] as CardDef;
const DISCARDED: Condition = { kind: 'TURN_FLAG', flag: 'discarded' };
const XP_GAINED: Condition = { kind: 'TURN_FLAG', flag: 'xpGained' };

/** A card in the database asks for the flags, so they are recorded. */
const asking = (effects: CardEffect[]): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-grunt': {
    ...base('fx-grunt'),
    statics: [{ affects: 'SELF', might: 1, when: DISCARDED }],
  },
  'fx-ash-tank': {
    ...base('fx-ash-tank'),
    statics: [{ affects: 'SELF', might: 1, when: XP_GAINED }],
  },
  'fx-flare': { ...base('fx-flare'), supportLevel: 'full', effects },
});

function cast(sc: Scenario): void {
  const flare = sc.putInHand('p0', 'fx-flare');
  sc.play('p0', flare, { payment: sc.exhaustPlan('p0', 1) });
  for (let i = 0; i < 20 && sc.state.flow.chain.length > 0; i++) {
    sc.pass(sc.state.flow.priority as 'p0' | 'p1');
  }
}

describe('parser: "you\'ve discarded a card / gained XP this turn" (Raging Soul, Wily Newtfish)', () => {
  it('reads both conditions and the "If <condition>, I have ..." static form', () => {
    // Tests Rule 584: static abilities apply while their condition holds
    expect(parseCondition("you've discarded a card this turn")).toEqual(DISCARDED);
    expect(parseCondition("you've gained XP this turn")).toEqual(XP_GAINED);
    expect(
      parseStaticLines("If you've discarded a card this turn, I have [Assault] and [Ganking].")
        ?.statics,
    ).toEqual([
      {
        affects: 'SELF',
        keywords: [{ name: 'Assault' }, { name: 'Ganking' }],
        when: DISCARDED,
      },
    ]);
    expect(
      parseStaticLines("If you've gained XP this turn, I have +1 [M] and [Ganking].")?.statics,
    ).toEqual([{ affects: 'SELF', might: 1, keywords: [{ name: 'Ganking' }], when: XP_GAINED }]);
  });
});

describe('scenario: per-turn flags (discarded a card, gained XP)', () => {
  it('turns on after gaining XP, only for that player and that turn', () => {
    // Tests Rule 584: static abilities apply while their condition holds
    const sc = Scenario.start({}, asking([{ op: 'GAIN_XP', amount: 1 }]));
    const me = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const at = (who: 'p0' | 'p1') => evalCondition(sc.state, sc.cards, XP_GAINED, who, me);
    expect(at('p0')).toBe(false);
    cast(sc);
    expect(at('p0')).toBe(true);
    expect(at('p1')).toBe(false);
    sc.endTurn('p0');
    expect(at('p0')).toBe(false); // a new turn
  });

  it('turns on after discarding a card', () => {
    // Tests Rule 598: discarding is moving a card from the hand to the Trash
    const sc = Scenario.start({}, asking([{ op: 'HAND_DISCARD', who: 'YOU', count: 1 }]));
    const me = sc.putUnit('p0', 'fx-grunt', 'base');
    expect(evalCondition(sc.state, sc.cards, DISCARDED, 'p0', me)).toBe(false);
    cast(sc);
    const pc = sc.state.flow.pendingChoice;
    expect(pc).toMatchObject({ kind: 'HAND_CHOICE', player: 'p0' });
    sc.do({
      type: 'CHOOSE_HAND_CARDS',
      playerId: 'p0',
      cardIds: [sc.player('p0').hand[0] as string],
    });
    expect(evalCondition(sc.state, sc.cards, DISCARDED, 'p0', me)).toBe(true);
  });

  it('records nothing when no card asks (states of ordinary games stay unchanged)', () => {
    // Tests Rule 323: bookkeeping is opt-in
    const sc = Scenario.start(
      {},
      {
        ...SCENARIO_CARDS,
        'fx-flare': {
          ...base('fx-flare'),
          supportLevel: 'full',
          effects: [{ op: 'GAIN_XP', amount: 1 }],
        },
      },
    );
    cast(sc);
    expect(JSON.stringify(sc.state.players)).not.toContain('turnFlags');
  });
});
