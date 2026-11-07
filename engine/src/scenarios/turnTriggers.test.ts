import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { evalCondition } from '../conditions.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef, CardTrigger } from '../types/index.js';

const withCards = (patch: Record<string, Partial<CardDef>>): CardDatabase => {
  const out: CardDatabase = { ...SCENARIO_CARDS };
  for (const [id, p] of Object.entries(patch)) {
    out[id] = { ...(SCENARIO_CARDS[id] as CardDef), ...p };
  }
  return out;
};
const trig = (t: CardTrigger): Partial<CardDef> => ({ triggers: [t] });

describe('scenario: turn-structure triggers (R72)', () => {
  it('"At the start of your Beginning Phase" resolves for the player whose turn begins', () => {
    // Tests Rule 315.2: Beginning Phase effects happen at the start of the turn
    const sc = Scenario.start(
      {},
      withCards({
        'fx-tide-grunt': trig({ on: 'TURN_START', effects: [{ op: 'DRAW', amount: 1 }] }),
      }),
    );
    sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const mine = sc.player('p0').hand.length;
    const theirs = sc.player('p1').hand.length;
    sc.endTurn('p0');
    expect(sc.player('p1').hand.length).toBe(theirs + 2); // the Draw Phase card + the ability
    expect(sc.player('p0').hand.length).toBe(mine);
    sc.verify();
  });

  it("does not fire at the other player's Beginning Phase", () => {
    // Tests Rule 315.2: "your" Beginning Phase
    const sc = Scenario.start(
      {},
      withCards({ 'fx-grunt': trig({ on: 'TURN_START', effects: [{ op: 'DRAW', amount: 1 }] }) }),
    );
    sc.putUnit('p0', 'fx-grunt', 'base');
    const hand = sc.player('p0').hand.length;
    sc.endTurn('p0'); // p1's turn begins
    expect(sc.player('p0').hand.length).toBe(hand);
  });

  it('honours the condition ("if I am at a battlefield")', () => {
    // Tests Rule 315.2: an intervening condition is checked as the ability triggers
    const mk = () =>
      withCards({
        'fx-tide-grunt': trig({
          on: 'TURN_START',
          when: { kind: 'AT_BATTLEFIELD' },
          effects: [{ op: 'DRAW', amount: 1 }],
        }),
      });
    const base = Scenario.start({}, mk());
    base.putUnit('p1', 'fx-tide-grunt', 'base');
    const h0 = base.player('p1').hand.length;
    base.endTurn('p0');
    expect(base.player('p1').hand.length).toBe(h0 + 1);

    const at = Scenario.start({}, mk());
    at.putUnit('p1', 'fx-tide-grunt', 'bf1');
    const h1 = at.player('p1').hand.length;
    at.endTurn('p0');
    expect(at.player('p1').hand.length).toBe(h1 + 2);
  });

  it('"At the end of your turn" runs in the Ending step, before the turn passes', () => {
    // Tests Rule 317.1: Ending step effects
    const sc = Scenario.start(
      {},
      withCards({
        'fx-grunt': trig({ on: 'TURN_END', effects: [{ op: 'READY_RUNES', count: 2 }] }),
      }),
    );
    sc.putUnit('p0', 'fx-grunt', 'base');
    sc.giveRunes('p0', 3);
    for (const r of sc.runes('p0')) sc.setReady(r.id, false);
    const total = sc.runes('p0').length;
    sc.endTurn('p0');
    const ready = sc.runes('p0').filter((r) => r.ready).length;
    expect(ready).toBe(Math.min(2, total));
  });

  it('a lethal end-of-turn effect kills before the units heal', () => {
    // Tests Rule 317.2: damage is removed after the Ending step; Cleanup kills lethal damage first (323.4)
    const sc = Scenario.start(
      {},
      withCards({
        'fx-grunt': trig({
          on: 'TURN_END',
          effects: [{ op: 'DAMAGE_ALL', amount: 9, side: 'friendly', scope: 'bases' }],
        }),
      }),
    );
    const u = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.endTurn('p0');
    expect(sc.obj(u).zone.kind).toBe('trash');
  });

  it('recycles all runes and channels exhausted runes', () => {
    // Tests Rule 431: channeling puts runes from the Rune Deck into play
    const sc = Scenario.start(
      {},
      withCards({
        'fx-grunt': trig({
          on: 'TURN_END',
          effects: [{ op: 'RECYCLE_RUNES' }, { op: 'CHANNEL', amount: 2, exhausted: true }],
        }),
      }),
    );
    sc.putUnit('p0', 'fx-grunt', 'base');
    const total = sc.runes('p0').length + sc.player('p0').runeDeck.length;
    sc.endTurn('p0');
    expect(sc.runes('p0')).toHaveLength(2);
    expect(sc.runes('p0').every((r) => !r.ready)).toBe(true);
    expect(sc.runes('p0').length + sc.player('p0').runeDeck.length).toBe(total);
  });

  it('recycles cards from the Trash to the bottom of the Main Deck', () => {
    // Tests Rule 160: recycling puts a card at the bottom of its deck
    const sc = Scenario.start(
      {},
      withCards({
        'fx-grunt': trig({ on: 'TURN_START', effects: [{ op: 'RECYCLE_TRASH', count: 2 }] }),
      }),
    );
    sc.putUnit('p0', 'fx-grunt', 'base');
    const a = sc.putInHand('p0', 'fx-flare');
    const b = sc.putInHand('p0', 'fx-flare');
    const ps = sc.state.players[0] as (typeof sc.state.players)[number];
    ps.hand = ps.hand.filter((x) => x !== a && x !== b);
    ps.trash.push(a, b);
    sc.obj(a).zone = { kind: 'trash', player: 'p0' };
    sc.obj(b).zone = { kind: 'trash', player: 'p0' };
    const deck = sc.player('p0').mainDeck.length;
    sc.endTurn('p0');
    sc.endTurn('p1'); // p0's Beginning Phase
    expect(sc.player('p0').trash).toHaveLength(0);
    expect(sc.player('p0').mainDeck.slice(-2)).toEqual([a, b].map((x) => x));
    expect(sc.player('p0').mainDeck.length).toBe(deck + 2 - 1); // minus the Draw Phase card
  });
});

describe('conditions: runes versus the opponent and facedown cards (R72)', () => {
  it('compares the number of runes in play', () => {
    // Tests Rule 431: runes in play are counted per controller
    const sc = Scenario.start();
    const src = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.setRunes('p0', ['Fury']);
    sc.setRunes('p1', ['Mind', 'Mind']);
    const c = (cmp: 'FEWER' | 'MORE') =>
      evalCondition(sc.state, sc.cards, { kind: 'RUNES_VS_OPPONENT', cmp }, 'p0', src);
    expect(c('FEWER')).toBe(true);
    expect(c('MORE')).toBe(false);
  });

  it("finds the controller's facedown card, anywhere or here", () => {
    // Tests Rule 726: a Hidden card waits facedown at a battlefield
    const sc = Scenario.start();
    const inBf1 = sc.putUnit('p0', 'fx-grunt', 'bf1');
    const hidden = sc.putUnit('p0', 'fx-grunt', 'base');
    const bf2 = sc.state.battlefields.find(
      (b) => b.id !== 'bf1',
    ) as (typeof sc.state.battlefields)[number];
    bf2.facedownSlotId = hidden;
    const has = (here: boolean, src: string) =>
      evalCondition(sc.state, sc.cards, { kind: 'FACEDOWN', ...(here ? { here } : {}) }, 'p0', src);
    expect(has(false, inBf1)).toBe(true);
    expect(has(true, inBf1)).toBe(false); // bf1 has none; the card is at bf2
    bf2.facedownSlotId = null;
    expect(has(false, inBf1)).toBe(false);
  });
});

describe('parser: turn triggers (R72)', () => {
  const t = (s: string) => parseCardAbilities(s)?.triggers;

  it('reads the start-of-Beginning and end-of-turn forms', () => {
    // Tests Rule 315.2: parsed trigger text
    expect(t('At the end of your turn, ready up to 2 runes.')).toEqual([
      { on: 'TURN_END', effects: [{ op: 'READY_RUNES', count: 2 }] },
    ]);
    expect(
      t('At the start of your Beginning Phase, recycle 3 from your trash.')?.[0],
    ).toMatchObject({ on: 'TURN_START', effects: [{ op: 'RECYCLE_TRASH', count: 3 }] });
    expect(
      t('When you play me or at the start of your Beginning Phase, [Burn 1].')?.map((x) => x.on),
    ).toEqual(['PLAY', 'TURN_START']);
    expect(
      t(
        'If you control fewer runes than an opponent at the start of your Beginning Phase, give me +1 [M] this turn.',
      )?.[0],
    ).toMatchObject({ on: 'TURN_START', when: { kind: 'RUNES_VS_OPPONENT', cmp: 'FEWER' } });
  });

  it('refuses bodies that would need a target or a payment', () => {
    // Tests Rule 315.2: inline abilities cannot ask for choices
    expect(
      parseCardAbilities('At the end of your turn, give a friendly unit +1 [M] this turn.'),
    ).toBeNull();
    expect(
      parseCardAbilities(
        'At the start of your Beginning Phase, you may kill a unit you control here to draw 1.',
      ),
    ).toBeNull();
  });
});
