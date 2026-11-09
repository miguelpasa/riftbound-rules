import { describe, it, expect } from 'vitest';
import { Scenario } from '../testing/scenario.js';
import { runEffects } from '../effects.js';
import { reduce } from '../reducer.js';
import { getLegalActions } from '../legalActions.js';
import { sanitizeFor } from '../sanitize.js';
import { parseCardAbilities, parseSpellText } from '../cardText.js';
import type { CardEffect, GameState, Intent } from '../types/index.js';

function run(sc: Scenario, effects: CardEffect[]): GameState {
  const s = structuredClone(sc.state);
  runEffects(s, 'p0', effects, sc.cards, [], 'fx-grunt', '');
  return s;
}

const choose = (sc: Scenario, player: 'p0' | 'p1', cardIds: string[]): void => {
  sc.do({ type: 'CHOOSE_HAND_CARDS', playerId: player, cardIds });
};

describe('parser: hand choices', () => {
  it('reads each-player discards and revealed-hand picks', () => {
    // Tests Rule 598: discarding is moving a card from the hand to the Trash
    expect(parseSpellText('Each player discards 1.')).toEqual([
      { op: 'HAND_DISCARD', who: 'EACH', count: 1 },
    ]);
    expect(
      parseSpellText(
        'Choose an opponent. They reveal their hand. Choose a non-unit card from it, and recycle that card.',
      ),
    ).toEqual([{ op: 'HAND_PICK', action: 'RECYCLE', filter: { notUnit: true } }]);
    expect(
      parseCardAbilities(
        'When you play me, choose an opponent. They reveal their hand. Choose a card from it, and they discard that card.',
      )?.triggers[0]?.effects,
    ).toEqual([{ op: 'HAND_PICK', action: 'DISCARD' }]);
  });
});

describe('scenario: each player discards (Minah, Bewitching Spirit)', () => {
  it('asks each player in turn order to choose, then finishes the effects', () => {
    // Tests Rule 598: discarding is moving a card from the hand to the Trash
    const sc = Scenario.start();
    const effects: CardEffect[] = [
      { op: 'HAND_DISCARD', who: 'EACH', count: 1 },
      { op: 'DRAW', amount: 1 },
    ];
    sc.state = run(sc, effects);
    const pc = sc.state.flow.pendingChoice;
    expect(pc).toMatchObject({ kind: 'HAND_CHOICE', player: 'p0', handOf: 'p0', count: 1 });
    // nobody else may act, and only the chooser's legal answers are offered
    expect(getLegalActions(sc.state, sc.cards, 'p1')).toEqual([]);
    const first = getLegalActions(sc.state, sc.cards, 'p0');
    expect(first.length).toBeGreaterThan(1);
    sc.reject({ type: 'PASS_PRIORITY', playerId: 'p0' });
    sc.reject({ type: 'CHOOSE_HAND_CARDS', playerId: 'p0', cardIds: [] });
    const mine = sc.player('p0').hand[0] as string;
    const handBefore = sc.player('p0').hand.length;
    choose(sc, 'p0', [mine]);
    expect(sc.player('p0').trash).toContain(mine);
    expect(sc.state.flow.pendingChoice).toMatchObject({ kind: 'HAND_CHOICE', player: 'p1' });
    const theirs = sc.player('p1').hand[0] as string;
    const oppBefore = sc.player('p1').hand.length;
    choose(sc, 'p1', [theirs]);
    expect(sc.state.flow.pendingChoice).toBeUndefined();
    expect(sc.player('p1').hand.length).toBe(oppBefore - 1);
    // the effect after the discards ran: p0 drew one card
    expect(sc.player('p0').hand.length).toBe(handBefore);
  });

  it('takes a small hand whole without asking', () => {
    // Tests Rule 598: discarding is moving a card from the hand to the Trash
    const sc = Scenario.start();
    const s = structuredClone(sc.state);
    s.players[1].hand = s.players[1].hand.slice(0, 1);
    sc.state = s;
    sc.state = run(sc, [{ op: 'HAND_DISCARD', who: 'OPPONENT', count: 2 }]);
    expect(sc.state.flow.pendingChoice).toBeUndefined();
    expect(sc.player('p1').hand).toHaveLength(0);
  });
});

describe('scenario: reveal the opponent hand and pick a card (Sabotage, Mindsplitter)', () => {
  it('lists the matching cards to the chooser and recycles the picked one', () => {
    // Tests Rule 598: a revealed hand is public information
    const sc = Scenario.start();
    sc.putInHand('p1', 'fx-tide-guard');
    sc.state = run(sc, [{ op: 'HAND_PICK', action: 'RECYCLE', filter: { notUnit: true } }]);
    const pc = sc.state.flow.pendingChoice;
    if (pc?.kind !== 'HAND_CHOICE') throw new Error('expected a hand choice');
    expect(pc).toMatchObject({ player: 'p0', handOf: 'p1', reveal: true, count: 1 });
    expect(pc.options.length).toBeGreaterThan(0);
    for (const o of pc.options) expect(sc.cards[o.cardId]?.type).not.toBe('UNIT');
    // both players see the revealed list
    const view = sanitizeFor(sc.state, 'p1').flow.pendingChoice;
    expect(view?.kind === 'HAND_CHOICE' && view.options.length).toBe(pc.options.length);
    const pick = pc.options[0]!.id;
    const deckBefore = sc.player('p1').mainDeck.length;
    choose(sc, 'p0', [pick]);
    expect(sc.player('p1').hand).not.toContain(pick);
    expect(sc.player('p1').mainDeck).toHaveLength(deckBefore + 1);
    expect(sc.player('p1').mainDeck[deckBefore]).toBe(pick);
  });

  it('hides a discard choice from the other player', () => {
    // Tests Rule 128: a hand is private
    const sc = Scenario.start();
    sc.state = run(sc, [{ op: 'HAND_DISCARD', who: 'EACH', count: 1 }]);
    const theirView = sanitizeFor(sc.state, 'p1').flow.pendingChoice;
    expect(theirView?.kind === 'HAND_CHOICE' && theirView.options).toEqual([]);
    const mine = sanitizeFor(sc.state, 'p0').flow.pendingChoice;
    expect(mine?.kind === 'HAND_CHOICE' && mine.options.length).toBeGreaterThan(1);
  });

  it('refuses a card that was not offered', () => {
    // Tests Rule 598: only offered cards can be chosen
    const sc = Scenario.start();
    sc.state = run(sc, [{ op: 'HAND_DISCARD', who: 'EACH', count: 1 }]);
    const foreign = sc.player('p1').hand[0] as string;
    const r = reduce(sc.state, sc.cards, {
      type: 'CHOOSE_HAND_CARDS',
      playerId: 'p0',
      cardIds: [foreign],
    } as Intent);
    expect(r.ok).toBe(false);
  });
});

describe('scenario: each player kills or returns one of their own (Cull the Weak, Whirlwind)', () => {
  it('asks each player to pick one of their units; the kill happens in the next Cleanup', () => {
    // Tests Rule 598: each player chooses one of their own permanents
    const sc = Scenario.start();
    const a1 = sc.putUnit('p0', 'fx-grunt', 'base');
    const a2 = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const b1 = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const b2 = sc.putUnit('p1', 'fx-order-tank', 'base');
    sc.state = run(sc, [{ op: 'EACH_CHOOSE', board: 'unit', action: 'KILL' }]);
    const pc = sc.state.flow.pendingChoice;
    expect(pc).toMatchObject({ kind: 'HAND_CHOICE', player: 'p0', board: 'unit' });
    expect(pc?.kind === 'HAND_CHOICE' && pc.options.map((o) => o.id).sort()).toEqual(
      [a1, a2].sort(),
    );
    choose(sc, 'p0', [a1]);
    expect(sc.state.flow.pendingChoice).toMatchObject({ player: 'p1' });
    choose(sc, 'p1', [b2]);
    expect(sc.obj(a1).zone.kind).toBe('trash');
    expect(sc.obj(b2).zone.kind).toBe('trash');
    expect(sc.obj(a2).zone.kind).toBe('base');
    expect(sc.obj(b1).zone.kind).toBe('base');
  });

  it('"may return" can be declined, and starts with the next player', () => {
    // Tests Rule 598: each player chooses one of their own permanents
    const sc = Scenario.start();
    const mine = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.putUnit('p0', 'fx-ash-tank', 'base');
    const theirs = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    sc.putUnit('p1', 'fx-order-tank', 'base');
    sc.state = run(sc, [
      {
        op: 'EACH_CHOOSE',
        board: 'unit',
        action: 'RETURN',
        optional: true,
        startWithOpponent: true,
      },
    ]);
    expect(sc.state.flow.pendingChoice).toMatchObject({ player: 'p1', optional: true });
    const legal = getLegalActions(sc.state, sc.cards, 'p1');
    expect(legal[0]).toMatchObject({ type: 'CHOOSE_HAND_CARDS', cardIds: [] });
    choose(sc, 'p1', [theirs]);
    expect(sc.obj(theirs).zone.kind).toBe('hand');
    choose(sc, 'p0', []);
    expect(sc.obj(mine).zone.kind).toBe('base');
    expect(sc.state.flow.pendingChoice).toBeUndefined();
  });
});
