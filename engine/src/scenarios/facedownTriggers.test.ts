import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, SC_LURKER_A, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef, CardTrigger } from '../types/index.js';

const BUFF2: CardTrigger['effects'] = [{ op: 'BUFF_SELF', amount: 2 }];
const watcher = (trigger: CardTrigger): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-ash-tank': { ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef), triggers: [trigger] },
});
const mightOf = (sc: Scenario, id: string): number =>
  effectiveMight(sc.state, sc.cards, id, { role: null });
function settle(sc: Scenario): void {
  for (let i = 0; i < 10 && sc.state.flow.chain.length > 0; i++) {
    sc.pass(sc.state.flow.priority as 'p0' | 'p1');
  }
}

describe('scenario: hiding versus playing a card (R100)', () => {
  it('hiding a card is not playing it: "When you play a card" does not fire, "When you hide" does', () => {
    // Tests Rule 811: a Hidden card is placed facedown, not played
    const sc = Scenario.start({}, watcher({ on: 'YOU_PLAY', effects: BUFF2 }));
    const w = sc.putUnit('p0', 'fx-ash-tank', 'bf0', { control: true });
    const lurker = sc.putInHand('p0', SC_LURKER_A);
    const before = mightOf(sc, w);
    sc.do({ type: 'HIDE_CARD', playerId: 'p0', cardInstanceId: lurker, battlefieldId: 'bf0' });
    settle(sc);
    expect(mightOf(sc, w)).toBe(before);

    const sc2 = Scenario.start({}, watcher({ on: 'YOU_HIDE', effects: BUFF2 }));
    const w2 = sc2.putUnit('p0', 'fx-ash-tank', 'bf0', { control: true });
    const l2 = sc2.putInHand('p0', SC_LURKER_A);
    const b2 = mightOf(sc2, w2);
    sc2.do({ type: 'HIDE_CARD', playerId: 'p0', cardInstanceId: l2, battlefieldId: 'bf0' });
    settle(sc2);
    expect(mightOf(sc2, w2)).toBe(b2 + 2);
  });

  it('playing the facedown card later fires "When you play a card from face down" once, not other plays', () => {
    // Tests Rule 811: the hidden card is played for 0 as a Reaction from the next turn
    const sc = Scenario.start(
      {},
      watcher({ on: 'YOU_PLAY', playFilter: { fromFacedown: true }, effects: BUFF2 }),
    );
    const w = sc.putUnit('p0', 'fx-ash-tank', 'bf0', { control: true });
    const lurker = sc.putInHand('p0', SC_LURKER_A);
    sc.do({ type: 'HIDE_CARD', playerId: 'p0', cardInstanceId: lurker, battlefieldId: 'bf0' });
    sc.endTurn('p0');
    sc.endTurn('p1');
    const before = mightOf(sc, w);
    // An ordinary spell first: not from face down.
    sc.giveRunes('p0', 2);
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', flare, { payment: sc.exhaustPlan('p0', 1) });
    settle(sc);
    expect(mightOf(sc, w)).toBe(before);
    // Now the hidden card.
    const flare2 = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', flare2, { payment: sc.exhaustPlan('p0', 1) });
    sc.pass('p1');
    sc.play('p0', lurker);
    settle(sc);
    expect(mightOf(sc, w)).toBe(before + 2);
  });

  it('"When you play me from face down" is a PLAY trigger that only fires for that kind of play', () => {
    // Tests Rule 811: a self trigger conditioned on the facedown play
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      [SC_LURKER_A]: {
        ...(SCENARIO_CARDS[SC_LURKER_A] as CardDef),
        triggers: [
          { on: 'PLAY', when: { kind: 'FROM_FACEDOWN' }, effects: [{ op: 'DRAW', amount: 1 }] },
        ],
      },
    };
    const sc = Scenario.start({}, cards);
    sc.putUnit('p0', 'fx-grunt', 'bf0', { control: true });
    const lurker = sc.putInHand('p0', SC_LURKER_A);
    sc.giveRunes('p0', 3);
    // Played from hand: no draw.
    const hand0 = sc.player('p0').hand.length;
    sc.play('p0', lurker, { payment: sc.exhaustPlan('p0', 3), location: { kind: 'base' } });
    settle(sc);
    expect(sc.player('p0').hand.length).toBe(hand0 - 1);
  });
});

describe('parser: facedown heads (R100)', () => {
  it('reads hide, play-from-face-down and the self form', () => {
    // Tests Rule 811: parsed text
    expect(parseCardAbilities('When you hide a card, ready me.')?.triggers[0]?.on).toBe('YOU_HIDE');
    expect(
      parseCardAbilities('When you play a card from face down, draw 1.')?.triggers[0]?.playFilter,
    ).toEqual({ fromFacedown: true });
    expect(
      parseCardAbilities('When you play me from face down, draw 1.')?.triggers[0],
    ).toMatchObject({ on: 'PLAY', when: { kind: 'FROM_FACEDOWN' } });
  });
});

describe('scenario: "When you play me from face down" fires (R100)', () => {
  it('draws when the hidden unit is played from face down', () => {
    // Tests Rule 811: playing a facedown card reveals it and triggers its own "from face down" text
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      [SC_LURKER_A]: {
        ...(SCENARIO_CARDS[SC_LURKER_A] as CardDef),
        triggers: [
          { on: 'PLAY', when: { kind: 'FROM_FACEDOWN' }, effects: [{ op: 'DRAW', amount: 1 }] },
        ],
      },
    };
    const sc = Scenario.start({}, cards);
    sc.putUnit('p0', 'fx-grunt', 'bf0', { control: true });
    const lurker = sc.putInHand('p0', SC_LURKER_A);
    sc.do({ type: 'HIDE_CARD', playerId: 'p0', cardInstanceId: lurker, battlefieldId: 'bf0' });
    sc.endTurn('p0');
    sc.endTurn('p1');
    sc.giveRunes('p0', 2);
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', flare, { payment: sc.exhaustPlan('p0', 1) });
    sc.pass('p1');
    const hand = sc.player('p0').hand.length;
    sc.play('p0', lurker);
    settle(sc);
    expect(sc.player('p0').hand.length).toBe(hand + 1);
  });
});
