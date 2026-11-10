import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, SC_LURKER_A, Scenario } from '../testing/scenario.js';
import { parseCardAbilities } from '../cardText.js';
import { effectiveMight } from '../combat.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const TEXT =
  'When you play me, give a friendly unit +3 [M] this turn, then recycle me if I was played from face down.';

/** Resolve the Chain, choosing `friend` for any trigger target and the default trigger order. */
function settle(sc: Scenario, friend: string): void {
  for (let i = 0; i < 20 && (sc.state.flow.chain.length > 0 || sc.state.flow.pendingChoice); i++) {
    const pc = sc.state.flow.pendingChoice;
    if (pc?.kind === 'TRIGGER_TARGET') {
      sc.do({
        type: 'CHOOSE_TRIGGER_TARGET',
        playerId: pc.player,
        chainItemId: pc.chainItemId,
        targets: [{ kind: 'object', id: friend }],
      });
    } else if (pc?.kind === 'TRIGGER_ORDER') {
      sc.do({ type: 'CHOOSE_TRIGGER_ORDER', playerId: pc.player, order: pc.chainItemIds });
    } else if (!pc) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    } else {
      throw new Error('unexpected choice ' + pc.kind);
    }
  }
}
const db = (): CardDatabase => ({
  ...SCENARIO_CARDS,
  [SC_LURKER_A]: {
    ...(SCENARIO_CARDS[SC_LURKER_A] as CardDef),
    triggers: parseCardAbilities(TEXT)?.triggers ?? [],
  },
});

describe('scenario: "..., then recycle me if I was played from face down" (Elnuk Herd)', () => {
  it('reads a buff trigger plus a face-down-only recycle trigger', () => {
    // Tests Rule 811: a self trigger conditioned on the facedown play
    const ts = parseCardAbilities(TEXT)?.triggers ?? [];
    expect(ts.map((t) => t.on)).toEqual(['PLAY', 'PLAY']);
    expect(ts[0]).toMatchObject({ when: { kind: 'FROM_FACEDOWN' }, effects: [{ op: 'RECYCLE_SELF' }] });
    expect(ts[1]?.effects[0]).toMatchObject({ op: 'BUFF_TARGET', amount: 3 });
  });

  it('played from hand: buffs and stays on the board', () => {
    // Tests Rule 811: the recycle applies only to a card played from face down
    const sc = Scenario.start({}, db());
    const friend = sc.putUnit('p0', 'fx-grunt', 'bf0', { control: true });
    const before = effectiveMight(sc.state, sc.cards, friend, { role: null });
    const herd = sc.putInHand('p0', SC_LURKER_A);
    sc.giveRunes('p0', 3);
    sc.play('p0', herd, {
      payment: sc.exhaustPlan('p0', 3),
      location: { kind: 'base' },
      targets: [{ kind: 'object', id: friend }],
    });
    settle(sc, friend);
    expect(effectiveMight(sc.state, sc.cards, friend, { role: null })).toBe(before + 3);
    expect(sc.obj(herd).zone.kind).toBe('base');
  });

  it('played from face down: buffs, then the card goes to the bottom of the Main Deck', () => {
    // Tests Rule 811: the facedown play triggers the recycle
    const sc = Scenario.start({}, db());
    const friend = sc.putUnit('p0', 'fx-grunt', 'bf0', { control: true });
    const herd = sc.putInHand('p0', SC_LURKER_A);
    sc.do({ type: 'HIDE_CARD', playerId: 'p0', cardInstanceId: herd, battlefieldId: 'bf0' });
    sc.endTurn('p0');
    sc.endTurn('p1');
    const before = effectiveMight(sc.state, sc.cards, friend, { role: null });
    sc.play('p0', herd, { targets: [{ kind: 'object', id: friend }] });
    settle(sc, friend);
    expect(effectiveMight(sc.state, sc.cards, friend, { role: null })).toBe(before + 3);
    expect(sc.obj(herd).zone.kind).toBe('mainDeck');
    expect(sc.player('p0').mainDeck[sc.player('p0').mainDeck.length - 1]).toBe(herd);
  });
});
