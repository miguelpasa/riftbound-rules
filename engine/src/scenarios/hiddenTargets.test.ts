import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, SC_LURKER_A, Scenario } from '../testing/scenario.js';
import { getLegalActions } from '../legalActions.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const HS = SC_LURKER_A; // the deck's Hidden card, redefined here as a targeted Hidden spell
const cards: CardDatabase = {
  ...SCENARIO_CARDS,
  [HS]: {
    ...(SCENARIO_CARDS['fx-flare'] as CardDef),
    cardId: HS,
    name: 'Hidden Snare',
    type: 'SPELL',
    keywords: [{ name: 'Hidden' }, { name: 'Action' }],
    effects: [{ op: 'DAMAGE_TARGET', amount: 1 }],
    supportLevel: 'full',
  } as CardDef,
};

function setup() {
  const sc = Scenario.start({}, cards);
  const there = sc.putUnit('p0', 'fx-ash-tank', 'bf0', { control: true });
  const spell = sc.putInHand('p0', HS);
  sc.giveRunes('p0', 2);
  sc.do({ type: 'HIDE_CARD', playerId: 'p0', cardInstanceId: spell, battlefieldId: 'bf0' });
  const away = sc.putUnit('p0', 'fx-grunt', 'base');
  sc.endTurn('p0');
  sc.endTurn('p1');
  return { sc, spell, there, away };
}

describe('scenario: a card played from face down chooses targets at its battlefield (X4)', () => {
  it('only offers targets at the battlefield it was hidden at', () => {
    // Tests Rule 723.1.d: targets must be at the battlefield of the Facedown Zone
    const { sc, spell, there, away } = setup();
    const plays = getLegalActions(sc.state, sc.cards, 'p0').filter(
      (a) => a.type === 'PLAY_CARD' && a.cardInstanceId === spell,
    );
    const ids = plays.flatMap((a) => (a.type === 'PLAY_CARD' ? (a.targets ?? []) : []));
    expect(ids.some((t) => t.kind === 'object' && t.id === there)).toBe(true);
    expect(ids.some((t) => t.kind === 'object' && t.id === away)).toBe(false);
  });

  it('rejects a target elsewhere and cannot be played with no valid target', () => {
    // Tests Rule 723.1.d.1: no valid target at that battlefield, no play from facedown
    const { sc, spell, there, away } = setup();
    const bad = sc.tryDo({
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: spell,
      payment: sc.exhaustPlan('p0', 0),
      targets: [{ kind: 'object', id: away }],
    });
    expect(bad.ok).toBe(false);
    sc.state.objects[there]!.zone = { kind: 'base', player: 'p1' };
    const none = getLegalActions(sc.state, sc.cards, 'p0').filter(
      (a) => a.type === 'PLAY_CARD' && a.cardInstanceId === spell,
    );
    expect(none).toHaveLength(0);
  });
});
